import { useCallback, useEffect, useRef, useState } from "react";
import { debug as logDebug } from "@/shared/logging/telemetry";
import {
  aiExplainSelection,
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

/** AI 面板状态管理。 */
export default function useAiState({
  activeSessionId,
  locale,
  debugLoggingEnabled,
  aiAvailable,
  aiUnavailableMessage,
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

  async function sendMessage() {
    if (!enabled) return;
    const content = draft.trim();
    if (!content || !activeSessionId || pending) return;
    if (!aiAvailable) {
      setErrorMessage(aiUnavailableMessage ?? "AI 助手当前不可用");
      return;
    }

    const nextUserMessage: AiChatMessage = {
      role: "user",
      content,
    };
    const nextMessages = messages.concat(nextUserMessage);
    const nextRequestId = crypto.randomUUID();
    pendingRequestIdRef.current = nextRequestId;
    // 聊天发送路径：先插入空 assistant 占位，首包前由 UI 渲染 loading。
    setMessages(
      nextMessages.concat({
        role: "assistant",
        content: "",
      }),
    );
    setDraftState("");
    setPending(true);
    setWaitingFirstChunk(true);
    setErrorMessage(null);

    try {
      if (debugLoggingEnabled) {
        void logDebug(
          JSON.stringify({
            event: "ai.session.chat.request",
            sessionId: activeSessionId,
            requestId: nextRequestId,
            responseLanguageStrategy: "follow_user_input",
            uiLanguage: locale,
            content,
          }),
        );
      }
      await aiSessionChatStreamStart({
        requestId: nextRequestId,
        sessionId: activeSessionId,
        responseLanguageStrategy: "follow_user_input",
        uiLanguage: locale,
        messages: nextMessages,
      });
    } catch (error) {
      if (debugLoggingEnabled) {
        void logDebug(
          JSON.stringify({
            event: "ai.session.chat.error",
            sessionId: activeSessionId,
            requestId: nextRequestId,
            error: translateAppError(error, t),
          }),
        );
      }
      pendingRequestIdRef.current = null;
      setMessages((prev) => {
        // 请求启动失败时同时回滚 user 与 assistant 占位，恢复发送前状态。
        const next = prev.slice();
        if (next[next.length - 1]?.role === "assistant") {
          next.pop();
        }
        if (next[next.length - 1] === nextUserMessage) {
          next.pop();
        }
        return next;
      });
      setDraftState(content);
      setErrorMessage(translateAppError(error, t));
      setPending(false);
      setWaitingFirstChunk(false);
    }
  }

  async function sendSelectionText(selectionText: string) {
    if (!enabled) return;
    const content = selectionText.trim();
    if (!content || !activeSessionId || pending) return;
    if (!aiAvailable) {
      setErrorMessage(aiUnavailableMessage ?? "AI 助手当前不可用");
      return;
    }

    const nextUserMessage: AiChatMessage = {
      role: "user",
      content,
    };
    // 与聊天提问路径保持一致：先插入空 assistant 占位，复用同一套 loading UI。
    const nextAssistantPlaceholder: AiChatMessage = {
      role: "assistant",
      content: "",
    };
    setMessages((prev) =>
      prev.concat(nextUserMessage, nextAssistantPlaceholder),
    );
    setPending(true);
    setWaitingFirstChunk(true);
    setErrorMessage(null);

    try {
      if (debugLoggingEnabled) {
        void logDebug(
          JSON.stringify({
            event: "ai.selection.request",
            sessionId: activeSessionId,
            responseLanguageStrategy: "follow_ui",
            uiLanguage: locale,
            selectionChars: content.length,
          }),
        );
      }
      const response = await aiExplainSelection({
        sessionId: activeSessionId,
        responseLanguageStrategy: "follow_ui",
        uiLanguage: locale,
        selectionText: content,
      });
      if (debugLoggingEnabled) {
        void logDebug(
          JSON.stringify({
            event: "ai.selection.response",
            sessionId: activeSessionId,
            responseChars: response.message.content.length,
            responseRole: response.message.role,
          }),
        );
      }
      setMessages((prev) => {
        // 优先替换最近一个空 assistant 占位，避免右键发送阶段出现重复 assistant 气泡。
        const next = prev.slice();
        for (let index = next.length - 1; index >= 0; index -= 1) {
          if (next[index]?.role === "assistant" && !next[index]?.content) {
            next[index] = response.message;
            return next;
          }
        }
        return next.concat(response.message);
      });
    } catch (error) {
      if (debugLoggingEnabled) {
        void logDebug(
          JSON.stringify({
            event: "ai.selection.error",
            sessionId: activeSessionId,
            error: translateAppError(error, t),
          }),
        );
      }
      setMessages((prev) => {
        // 失败时回滚本次右键发送注入的空 assistant 占位，防止遗留空消息。
        const withoutUser = prev.filter((item) => item !== nextUserMessage);
        let placeholderRemoved = false;
        return withoutUser.filter((item) => {
          if (placeholderRemoved) return true;
          if (item.role === "assistant" && !item.content) {
            placeholderRemoved = true;
            return false;
          }
          return true;
        });
      });
      setErrorMessage(translateAppError(error, t));
    } finally {
      setPending(false);
      setWaitingFirstChunk(false);
    }
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
