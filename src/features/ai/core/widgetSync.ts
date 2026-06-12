/**
 * AI 浮动面板同步协议。
 * 职责：
 * 1. 约束主窗口与浮动 AI 面板之间共享的最小状态快照。
 * 2. 让浮动窗口把输入/发送/取消等动作代理回主窗口执行。
 */
import type { AiChatMessage } from "@/features/ai/types";

/** 浮动 AI 面板与主窗口之间共享的 BroadcastChannel 名称。 */
export const WIDGET_AI_CHANNEL = "fluxterm-ai-widget-sync";

/** AI 面板快照：描述当前活动会话的可渲染最小状态。 */
export type FloatingAiSnapshot = {
  activeSessionId: string | null;
  messages: AiChatMessage[];
  draft: string;
  pending: boolean;
  waitingFirstChunk: boolean;
  errorMessage: string | null;
  aiAvailable: boolean;
  aiUnavailableMessage: string | null;
};

/** 浮动 AI 面板发往主窗口的操作消息。 */
export type FloatingAiActionMessage =
  | { type: "ai:request-snapshot" }
  | { type: "ai:set-draft"; draft: string }
  | { type: "ai:send" }
  | { type: "ai:cancel" }
  | { type: "ai:clear" }
  | { type: "ai:send-code-to-terminal"; code: string };

/** 主窗口发往浮动 AI 面板的状态快照消息。 */
export type FloatingAiSnapshotMessage = {
  type: "ai:snapshot";
  payload: FloatingAiSnapshot;
};

/** AI 浮动面板同步协议的完整消息集合。 */
export type FloatingAiMessage =
  | FloatingAiActionMessage
  | FloatingAiSnapshotMessage;
