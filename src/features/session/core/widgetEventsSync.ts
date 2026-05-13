/**
 * 浮动事件面板同步协议。
 * 职责：定义主窗口与浮动事件面板之间共享的最小状态快照。
 */
import type { AppEvent, DisconnectReason, SessionStateUi } from "@/types";

/** 浮动事件面板与主窗口之间共享的 BroadcastChannel 名称。 */
export const WIDGET_EVENTS_CHANNEL = "fluxterm-events-sync";

/** 事件面板快照：描述连接状态与事件列表的最小可渲染状态。 */
export type FloatingEventsSnapshot = {
  sessionState: SessionStateUi;
  sessionReason: DisconnectReason | null;
  reconnectInfo: { attempt: number; delayMs: number } | null;
  events: AppEvent[];
};

/** 浮动事件面板发往主窗口的动作消息。 */
export type FloatingEventsActionMessage = { type: "events:request-snapshot" };

/** 主窗口发往浮动事件面板的状态快照消息。 */
export type FloatingEventsSnapshotMessage = {
  type: "events:snapshot";
  payload: FloatingEventsSnapshot;
};

/** 浮动事件面板同步协议的完整消息集合。 */
export type FloatingEventsMessage =
  | FloatingEventsActionMessage
  | FloatingEventsSnapshotMessage;
