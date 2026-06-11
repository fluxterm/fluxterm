import { useCallback, useEffect, useRef, useState } from "react";
import { debug as logDebug } from "@/shared/logging/telemetry";
import {
  aiSessionChatStreamCancel,
  aiSessionChatStreamStart,
  onAiChatChunk,
  onAiChatDone,
  onAiChatError,
} from "@/features/ai/core/commands";
import type {
  AiChatDonePayload,
  AiChatErrorPayload,
  AiChatMessage,
  AiChatChunkPayload,
} from "@/features/ai/types";
import { translations, type Locale, type TranslationKey } from "@/i18n";
import { translateAppError } from "@/shared/errors/appError";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";

/**
 * AI 面板状态管理 Hook。
 * 负责会话内消息状态、流式问答生命周期、跨窗口同步与本地持久化。
 * 约定：assistant 空消息表示“占位中”，用于在首包到达前展示 loading。
 */
const AI_SESSION_STORAGE_KEY = "fluxterm.ai.session-state";
const AI_SESSION_SYNC_CHANNEL = "fluxterm-ai-sync";

type PersistedAiSessionState = {
  messages: AiChatMessage[];
  draft: string;
  errorMessage: string | null;
};

type AiSessionSyncPayload = {
  instanceId: string;
  sessionId: string;
  state: PersistedAiSessionState;
};

type UseAiStateProps = {
  activeSessionId: string | null;
  locale: Locale;
  debugLoggingEnabled: boolean;
  aiAvailable: boolean;
  aiUnavailableMessage: string | null;
  selectionMaxChars?: number;
  enabled?: boolean;
};

type UseAiStateResult = {
  messages: AiChatMessage[];
  draft: string;
  pending: boolean;
  waitingFirstChunk: boolean;
  errorMessage: string | null;
  setDraft: (value: string) => void;
  sendMessage: () => Promise<void>;
  sendSelectionText: (selectionText: string) => Promise<void>;
  cancelMessage: () => void;
  clearMessages: () => void;
};

function readPersistedAiSessionStates() {
  if (typeof window === "undefined")
    return {} as Record<string, PersistedAiSessionState>;
  try {
    const raw = window.localStorage.getItem(AI_SESSION_STORAGE_KEY);
    if (!raw) return {} as Record<string, PersistedAiSessionState>;
    return JSON.parse(raw) as Record<string, PersistedAiSessionState>;
  } catch {
    return {} as Record<string, PersistedAiSessionState>;
  }
}

function writePersistedAiSessionStates(
  value: Record<string, PersistedAiSessionState>,
) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AI_SESSION_STORAGE_KEY, JSON.stringify(value));
}

function readSessionState(
  sessionId: string | null,
): PersistedAiSessionState | null {
  if (!sessionId) return null;
  const all = readPersistedAiSessionStates();
  return all[sessionId] ?? null;
}

function writeSessionState(
  sessionId: string | null,
  value: PersistedAiSessionState,
) {
  if (!sessionId) return;
  const all = readPersistedAiSessionStates();
  all[sessionId] = value;
  writePersistedAiSessionStates(all);
}

function normalizeSelectionMaxChars(value: number | undefined) {
  if (!Number.isFinite(value)) return 1500;
  return Math.max(1, Math.round(value ?? 1500));
}

function truncateSelectionText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

/** AI 面板状态管理。 */
export default function useAiState({
  activeSessionId,
  locale,
  debugLoggingEnabled,
  aiAvailable,
  aiUnavailableMessage,
  selectionMaxChars,
  enabled = true,
}: UseAiStateProps): UseAiStateResult {
  const instanceIdRef = useRef(crypto.randomUUID());
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [draft, setDraftState] = useState("");
  const [pending, setPending] = useState(false);
  const [waitingFirstChunk, setWaitingFirstChunk] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);
  const syncChannelRef = useRef<BroadcastChannel | null>(null);
  const t = useCallback(
    (key: TranslationKey) => translations[locale][key] ?? key,
    [locale],
  );

  const handleChunk = useCallback((payload: AiChatChunkPayload) => {
    if (payload.requestId !== pendingRequestIdRef.current) return;
    // 首包到达后退出“等待首包”态，并把增量文本追加到最后一个 assistant 消息。
    setWaitingFirstChunk(false);
    setMessages((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last?.role !== "assistant") return prev;
      next[next.length - 1] = {
        ...last,
        content: `${last.content}${payload.content}`,
      };
      return next;
    });
  }, []);

  const handleDone = useCallback((payload: AiChatDonePayload) => {
    if (payload.requestId !== pendingRequestIdRef.current) return;
    // done 事件是流式请求的唯一正常收口点：清理 requestId 并复位 pending 状态。
    pendingRequestIdRef.current = null;
    setPending(false);
    setWaitingFirstChunk(false);
  }, []);

  const handleError = useCallback(
    (payload: AiChatErrorPayload) => {
      if (payload.requestId !== pendingRequestIdRef.current) return;
      pendingRequestIdRef.current = null;
      setPending(false);
      setWaitingFirstChunk(false);
      setErrorMessage(translateAppError(payload.error, t));
      setMessages((prev) => {
        // 错误场景移除末尾 assistant 占位，避免空消息残留。
        const next = prev.slice();
        if (next[next.length - 1]?.role === "assistant") {
          next.pop();
        }
        return next;
      });
      if (debugLoggingEnabled) {
        void logDebug(
          JSON.stringify({
            event: "ai.session.chat.error",
            sessionId: payload.sessionId,
            error: translateAppError(payload.error, t),
          }),
        );
      }
    },
    [debugLoggingEnabled, t],
  );

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlistenChunk: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    // 流式事件订阅入口：chunk/done/error 三类事件共同驱动 pending 状态机。
    // Tauri 事件订阅是异步返回 unlisten 的，组件快速卸载时要立即回收晚到的订阅句柄。
    void onAiChatChunk(handleChunk).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlistenChunk = unlisten;
    });
    void onAiChatDone(handleDone).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlistenDone = unlisten;
    });
    void onAiChatError(handleError).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlistenError = unlisten;
    });

    return () => {
      disposed = true;
      cancelPendingRequest();
      unlistenChunk?.();
      unlistenDone?.();
      unlistenError?.();
    };
  }, [enabled, handleChunk, handleDone, handleError]);

  useEffect(() => {
    if (!enabled) return;
    if (typeof BroadcastChannel === "undefined") return;
    // 多窗口同步：当前窗口写入后广播，其他窗口按 sessionId 精确接收并覆盖本地状态。
    const channel = new BroadcastChannel(AI_SESSION_SYNC_CHANNEL);
    syncChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<AiSessionSyncPayload>) => {
      const payload = event.data;
      if (!payload || payload.instanceId === instanceIdRef.current) return;
      if (!activeSessionId || payload.sessionId !== activeSessionId) return;
      setMessages(payload.state.messages);
      setDraftState(payload.state.draft);
      setErrorMessage(payload.state.errorMessage);
    };
    if (activeSessionId) {
      const currentState = readSessionState(activeSessionId) ?? {
        messages,
        draft,
        errorMessage,
      };
      channel.postMessage({
        instanceId: instanceIdRef.current,
        sessionId: activeSessionId,
        state: currentState,
      } satisfies AiSessionSyncPayload);
    }
    return () => {
      channel.close();
      if (syncChannelRef.current === channel) {
        syncChannelRef.current = null;
      }
    };
  }, [activeSessionId, draft, enabled, errorMessage, messages]);

  useEffect(() => {
    if (!enabled) return;
    // 会话切换时先取消旧请求，再加载该会话的持久化快照，避免串流写入错误会话。
    const cancel = scheduleDeferredTask(() => {
      cancelPendingRequest();
      const persisted = readSessionState(activeSessionId);
      setMessages(persisted?.messages ?? []);
      setDraftState(persisted?.draft ?? "");
      setWaitingFirstChunk(false);
      setErrorMessage(persisted?.errorMessage ?? null);
    });
    return cancel;
  }, [activeSessionId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (!activeSessionId) return;
    const state = {
      messages,
      draft,
      errorMessage,
    };
    writeSessionState(activeSessionId, state);
    syncChannelRef.current?.postMessage({
      instanceId: instanceIdRef.current,
      sessionId: activeSessionId,
      state,
    } satisfies AiSessionSyncPayload);
  }, [activeSessionId, draft, enabled, errorMessage, messages]);

  function cancelPendingRequest() {
    const requestId = pendingRequestIdRef.current;
    if (!requestId) return;
    pendingRequestIdRef.current = null;
    setPending(false);
    setWaitingFirstChunk(false);
    // 流式请求仍由后端继续读取时，显式取消可以停止继续消费 token。
    void aiSessionChatStreamCancel(requestId);
  }

  async function sendStreamingMessage(
    userMessage: AiChatMessage,
    options: { onAccepted?: () => void } = {},
  ) {
    if (!enabled) return false;
    const activeId = activeSessionId;
    if (!activeId || pending) return false;
    if (!aiAvailable) {
      setErrorMessage(aiUnavailableMessage ?? t("ai.unavailable.generic"));
      return false;
    }

    const nextMessages = messages.concat(userMessage);
    const nextRequestId = crypto.randomUUID();
    pendingRequestIdRef.current = nextRequestId;

    const assistantPlaceholder: AiChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };

    options.onAccepted?.();
    setMessages(nextMessages.concat(assistantPlaceholder));
    setPending(true);
    setWaitingFirstChunk(true);
    setErrorMessage(null);

    try {
      if (debugLoggingEnabled) {
        void logDebug(
          JSON.stringify({
            event:
              userMessage.source === "selection"
                ? "ai.selection.request"
                : "ai.session.chat.request",
            sessionId: activeId,
            requestId: nextRequestId,
            responseLanguageStrategy:
              userMessage.source === "selection"
                ? "follow_ui"
                : "follow_user_input",
            uiLanguage: locale,
            content: userMessage.content,
          }),
        );
      }
      await aiSessionChatStreamStart({
        requestId: nextRequestId,
        sessionId: activeId,
        responseLanguageStrategy:
          userMessage.source === "selection"
            ? "follow_ui"
            : "follow_user_input",
        uiLanguage: locale,
        messages: nextMessages.map((msg) => {
          if (msg.role === "user" && msg.source === "selection") {
            return {
              role: msg.role,
              content: `Selected terminal text:\n${msg.content}`,
            };
          }
          return {
            role: msg.role,
            content: msg.content,
          };
        }),
      });
      return true;
    } catch (error) {
      if (debugLoggingEnabled) {
        void logDebug(
          JSON.stringify({
            event:
              userMessage.source === "selection"
                ? "ai.selection.error"
                : "ai.session.chat.error",
            sessionId: activeId,
            requestId: nextRequestId,
            error: translateAppError(error, t),
          }),
        );
      }
      pendingRequestIdRef.current = null;
      setMessages((prev) => {
        // 请求启动失败时同时回滚 user 与 assistant 占位，恢复发送前状态。
        const next = prev.slice();
        if (next[next.length - 1]?.id === assistantPlaceholder.id) {
          next.pop();
        }
        if (next[next.length - 1]?.id === userMessage.id) {
          next.pop();
        }
        return next;
      });
      if (userMessage.source !== "selection") {
        setDraftState(userMessage.content);
      }
      setErrorMessage(translateAppError(error, t));
      setPending(false);
      setWaitingFirstChunk(false);
      return false;
    }
  }

  async function sendMessage() {
    const content = draft.trim();
    if (!content) return;
    await sendStreamingMessage(
      {
        id: crypto.randomUUID(),
        role: "user",
        content,
      },
      {
        onAccepted: () => setDraftState(""),
      },
    );
  }

  async function sendSelectionText(selectionText: string) {
    const content = truncateSelectionText(
      selectionText.trim(),
      normalizeSelectionMaxChars(selectionMaxChars),
    );
    if (!content) return;
    await sendStreamingMessage({
      id: crypto.randomUUID(),
      role: "user",
      content,
      source: "selection",
    });
  }

  function clearMessages() {
    if (!enabled) return;
    cancelPendingRequest();
    setMessages([]);
    setErrorMessage(null);
  }

  function setDraft(value: string) {
    if (!enabled) return;
    setDraftState(value);
  }

  return {
    messages,
    draft,
    pending,
    waitingFirstChunk,
    errorMessage,
    setDraft,
    sendMessage,
    sendSelectionText,
    cancelMessage: cancelPendingRequest,
    clearMessages,
  };
}
