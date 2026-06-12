import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import ReactMarkdown from "react-markdown";
import type { Components, ExtraProps } from "react-markdown";
import { FiCopy, FiTerminal } from "react-icons/fi";
import remarkGfm from "remark-gfm";
import Button from "@/components/ui/button";
import type { Translate } from "@/i18n";
import type { AiChatMessage } from "@/features/ai/types";
import "./AiWidget.css";

type AiCodeBlockProps = {
  activeSessionId: string | null;
  code: string;
  copied: boolean;
  language: string | null;
  onCopy: () => void;
  onSendCodeToTerminal: (code: string) => void;
  t: Translate;
};

type MarkdownElement = NonNullable<ExtraProps["node"]>;
type MarkdownChild = MarkdownElement["children"][number];

/** AI 输出中的代码块工具容器。 */
function AiCodeBlock({
  activeSessionId,
  code,
  copied,
  language,
  onCopy,
  onSendCodeToTerminal,
  t,
}: AiCodeBlockProps) {
  return (
    <div className="ai-code-block" data-ui="ai-code-block">
      <div className="ai-code-toolbar">
        <span className="ai-code-language">
          {language ?? t("ai.code.plainText")}
        </span>
        <span className="ai-code-actions">
          <button
            type="button"
            className="ai-code-action"
            title={copied ? t("actions.copied") : t("ai.code.copy")}
            aria-label={copied ? t("actions.copied") : t("ai.code.copy")}
            onClick={onCopy}
          >
            <FiCopy />
          </button>
          <button
            type="button"
            className="ai-code-action"
            title={
              activeSessionId
                ? t("ai.code.fillTerminal")
                : t("ai.code.noSession")
            }
            aria-label={
              activeSessionId
                ? t("ai.code.fillTerminal")
                : t("ai.code.noSession")
            }
            disabled={!activeSessionId}
            onClick={() => onSendCodeToTerminal(code)}
          >
            <FiTerminal />
          </button>
        </span>
      </div>
      <pre className="ai-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** 从 HAST code 节点提取文本，避免依赖 React 子节点结构。 */
function extractHastText(node: MarkdownChild | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  return node.children
    .map((child: MarkdownChild) => extractHastText(child))
    .join("");
}

/** 为代码块生成稳定短 key，避免不同代码块共享复制状态。 */
function createCodeBlockKey(language: string | null, code: string): string {
  let hash = 0;
  const source = `${language ?? "plain"}\n${code}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) | 0;
  }
  return `code-${language ?? "plain"}-${source.length}-${hash.toString(36)}`;
}

/** 获取最新用户消息 key，用于识别新一轮提问。 */
function getLatestUserMessageKey(messages: AiChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return message.id ?? `${index}-${message.content}`;
    }
  }
  return null;
}

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
  onSendCodeToTerminal: (code: string) => void;
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
  onSendCodeToTerminal,
  t,
}: AiWidgetProps) {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const onSendCodeToTerminalRef = useRef(onSendCodeToTerminal);
  const userPausedAutoScrollRef = useRef(false);
  const lastWheelUpAtRef = useRef(0);
  const latestUserMessageKeyRef = useRef<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [localDraft, setLocalDraft] = useState(draft);
  const [isComposing, setIsComposing] = useState(false);
  const canChat = !!activeSessionId && !pending && aiAvailable;
  const textareaValue = keepLocalDraftBuffer ? localDraft : draft;

  useEffect(() => {
    onSendCodeToTerminalRef.current = onSendCodeToTerminal;
  }, [onSendCodeToTerminal]);

  useEffect(() => {
    if (!autoScroll) return;
    // 自动跟随滚动：仅在用户位于底部附近时追踪最新消息。
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [autoScroll, messages, waitingFirstChunk, errorMessage]);

  useEffect(() => {
    if (pending) {
      setTimeout(() => {
        if (!userPausedAutoScrollRef.current) {
          setAutoScroll(true);
        }
      }, 0);
    }
  }, [pending]);

  useEffect(() => {
    const latestUserMessageKey = getLatestUserMessageKey(messages);
    if (!latestUserMessageKey) {
      latestUserMessageKeyRef.current = null;
      userPausedAutoScrollRef.current = false;
      lastWheelUpAtRef.current = 0;
      queueMicrotask(() => setAutoScroll(true));
      return;
    }

    if (latestUserMessageKeyRef.current === latestUserMessageKey) return;

    latestUserMessageKeyRef.current = latestUserMessageKey;
    userPausedAutoScrollRef.current = false;
    lastWheelUpAtRef.current = 0;
    queueMicrotask(() => setAutoScroll(true));
  }, [messages]);

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

  const copyMessage = useCallback(async (content: string, key: string) => {
    await writeText(content);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1500);
  }, []);

  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ ...props }) => (
        <a {...props} target="_blank" rel="noreferrer noopener" />
      ),
      pre: ({
        children,
        node,
      }: {
        children?: ReactNode;
        node?: MarkdownElement;
      }) => {
        const codeNode = node?.children.find(
          (child: MarkdownChild): child is MarkdownElement =>
            child.type === "element" && child.tagName === "code",
        );
        if (!codeNode) {
          return <pre>{children}</pre>;
        }
        const className =
          typeof codeNode.properties.className === "string"
            ? codeNode.properties.className
            : Array.isArray(codeNode.properties.className)
              ? codeNode.properties.className.join(" ")
              : "";
        const languageMatch = /language-([\w-]+)/.exec(className ?? "");
        const code = extractHastText(codeNode).replace(/\n$/, "");
        const language = languageMatch?.[1] ?? null;
        const key = createCodeBlockKey(language, code);
        return (
          <AiCodeBlock
            activeSessionId={activeSessionId}
            code={code}
            copied={copiedKey === key}
            language={language}
            onCopy={() => {
              copyMessage(code, key).catch(() => {});
            }}
            onSendCodeToTerminal={(code) => {
              onSendCodeToTerminalRef.current(code);
            }}
            t={t}
          />
        );
      },
      code: ({ children, className, ...props }) => (
        <code className={className} {...props}>
          {children}
        </code>
      ),
    }),
    [activeSessionId, copiedKey, copyMessage, t],
  );

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

    if (message.role === "user") {
      if (message.source === "selection") {
        return (
          <div className="ai-message-selection">
            <div className="ai-message-selection-header">
              <span className="ai-message-selection-icon">📝</span>
              <span className="ai-message-selection-label">
                {t("ai.selectionPrefix")}
              </span>
            </div>
            <pre className="ai-message-selection-text">
              <code>{message.content}</code>
            </pre>
          </div>
        );
      }
      return message.content;
    }

    if (message.role === "assistant") {
      // assistant 默认按 Markdown 渲染，支持 GFM；链接统一新窗口打开。
      return (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
        >
          {message.content}
        </ReactMarkdown>
      );
    }

    return null;
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
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastWheelUpAtRef.current = Date.now();
            userPausedAutoScrollRef.current = true;
            setAutoScroll(false);
          }
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          // 用户离开底部后暂停自动滚动，避免阅读历史消息时被新消息打断。
          const bottomDistance =
            element.scrollHeight - element.scrollTop - element.clientHeight;
          const nearBottom = bottomDistance < 4;
          if (userPausedAutoScrollRef.current) {
            const recentWheelUp = Date.now() - lastWheelUpAtRef.current < 250;
            if (nearBottom && !recentWheelUp) {
              userPausedAutoScrollRef.current = false;
              setAutoScroll(true);
              return;
            }
            setAutoScroll(false);
            return;
          }
          if (nearBottom) {
            userPausedAutoScrollRef.current = false;
          }
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
            key={message.id ?? `${message.role}-${index}`}
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
