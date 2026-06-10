import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Button from "@/components/ui/button";
import type { Translate } from "@/i18n";
import type { AiChatMessage } from "@/features/ai/types";
import "./AiWidget.css";

/**
 * AI 会话面板视图组件。
 * 负责消息渲染（assistant Markdown + loading 占位）、输入交互与滚动行为。
 * 不持有业务状态，所有会话状态由 useAiState 管理并通过 props 注入。
 */
type AiWidgetProps = {
  activeSessionId: string | null;
  aiAvailable: boolean;
  aiUnavailableMessage: string | null;
  messages: AiChatMessage[];
  draft: string;
  pending: boolean;
  waitingFirstChunk: boolean;
  errorMessage: string | null;
  keepLocalDraftBuffer?: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => Promise<void>;
  onCancel: () => void;
  onClear: () => void;
  t: Translate;
};

/** AI 会话上下文问答面板。 */
export default function AiWidget({
  activeSessionId,
  aiAvailable,
  aiUnavailableMessage,
  messages,
  draft,
  pending,
  waitingFirstChunk,
  errorMessage,
  keepLocalDraftBuffer = false,
  onDraftChange,
  onSend,
  onCancel,
  onClear,
  t,
}: AiWidgetProps) {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [localDraft, setLocalDraft] = useState(draft);
  const [isComposing, setIsComposing] = useState(false);
  const canChat = !!activeSessionId && !pending && aiAvailable;
  const textareaValue = keepLocalDraftBuffer ? localDraft : draft;

  useEffect(() => {
    if (!autoScroll) return;
    // 自动跟随滚动：仅在用户位于底部附近时追踪最新消息。
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [autoScroll, messages, waitingFirstChunk, errorMessage]);

  useEffect(() => {
    if (keepLocalDraftBuffer && isComposing) return;
    // 外部草稿变化回灌到本地输入缓存；中文输入法组合态期间避免覆盖用户输入。
    queueMicrotask(() => {
      setLocalDraft(draft);
    });
  }, [draft, isComposing, keepLocalDraftBuffer]);

  useEffect(() => {
    // 输入区默认按单行起步，内容增多后再向上扩展，避免空状态占用过高。
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 40), 144);
    textarea.style.height = `${nextHeight}px`;
  }, [textareaValue]);

  async function copyMessage(content: string, key: string) {
    await writeText(content);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1500);
  }

  function renderMessageBody(message: AiChatMessage) {
    if (!message.content && pending && message.role === "assistant") {
      // assistant 空内容 + pending 表示“占位消息”，统一渲染成 loading 状态。
      return (
        <div
          className={`ai-message-loading ${waitingFirstChunk ? "pending" : ""}`}
          aria-live="polite"
          aria-label={t("ai.generating")}
        >
          <span className="ai-message-loading-label">{t("ai.generating")}</span>
          <span className="ai-message-loading-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      );
    }

    if (message.role === "assistant") {
      // assistant 默认按 Markdown 渲染，支持 GFM；链接统一新窗口打开。
      return (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ ...props }) => (
              <a {...props} target="_blank" rel="noreferrer noopener" />
            ),
          }}
        >
          {message.content}
        </ReactMarkdown>
      );
    }

    return message.content;
  }

  return (
    <div className="ai-widget">
      <div className="ai-widget-toolbar">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={!messages.length && !errorMessage}
        >
          {t("ai.clear")}
        </Button>
        <span className="ai-widget-status">
          {!activeSessionId
            ? t("ai.sessionMissing")
            : waitingFirstChunk
              ? t("ai.generating")
              : pending
                ? t("ai.streaming")
                : t("ai.sessionReady")}
        </span>
      </div>

      <div
        ref={messagesRef}
        className="ai-widget-messages"
        onScroll={(event) => {
          const element = event.currentTarget;
          // 用户离开底部后暂停自动滚动，避免阅读历史消息时被新消息打断。
          const nearBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
          setAutoScroll(nearBottom);
        }}
      >
        {!messages.length && !errorMessage && (
          <div className="ai-widget-empty">
            {!aiAvailable && activeSessionId
              ? aiUnavailableMessage
              : activeSessionId
                ? t("ai.emptyWithSession")
                : t("ai.emptyWithoutSession")}
          </div>
        )}
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}-${message.content.slice(0, 20)}`}
            className={`ai-message ${message.role === "user" ? "user" : "assistant"}`}
          >
            <div className="ai-message-toolbar">
              <span className="ai-message-role">
                {message.role === "user"
                  ? t("ai.message.user")
                  : t("ai.message.assistant")}
              </span>
              <button
                type="button"
                className="ai-message-copy"
                onClick={() => {
                  copyMessage(
                    message.content,
                    `${message.role}-${index}-${message.content.length}`,
                  ).catch(() => {});
                }}
              >
                {copiedKey ===
                `${message.role}-${index}-${message.content.length}`
                  ? t("actions.copied")
                  : t("actions.copy")}
              </button>
            </div>
            <div className="ai-message-body">{renderMessageBody(message)}</div>
          </div>
        ))}
      </div>

      {errorMessage && <div className="ai-widget-error">{errorMessage}</div>}

      <div className="ai-widget-input">
        <div className="ai-widget-input-shell">
          <textarea
            ref={textareaRef}
            className="ai-widget-textarea"
            value={textareaValue}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              const nextValue = event.target.value;
              if (keepLocalDraftBuffer) {
                setLocalDraft(nextValue);
              }
              if (!keepLocalDraftBuffer || !isComposing) {
                onDraftChange(nextValue);
              }
            }}
            onCompositionStart={() => {
              if (!keepLocalDraftBuffer) return;
              setIsComposing(true);
            }}
            onCompositionEnd={(event) => {
              if (!keepLocalDraftBuffer) return;
              const nextValue = event.currentTarget.value;
              setIsComposing(false);
              setLocalDraft(nextValue);
              onDraftChange(nextValue);
            }}
            onBlur={(event) => {
              if (!keepLocalDraftBuffer) return;
              const nextValue = event.currentTarget.value;
              setLocalDraft(nextValue);
              onDraftChange(nextValue);
            }}
            placeholder={t("ai.inputPlaceholder")}
            disabled={!activeSessionId || pending || !aiAvailable}
            rows={1}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              onSend().catch(() => {});
            }}
          />
          <div className="ai-widget-input-actions">
            <Button
              variant="ghost"
              size="sm"
              className={`ai-widget-send ${pending ? "secondary" : ""}`}
              onClick={() => {
                if (pending) {
                  onCancel();
                  return;
                }
                onSend().catch(() => {});
              }}
              disabled={pending ? false : !canChat || !textareaValue.trim()}
            >
              {pending ? t("ai.stop") : t("ai.send")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
