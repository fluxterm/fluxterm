/**
 * 浮动广播面板同步协议。
 * 职责：定义主窗口与浮动广播面板之间共享的会话分组快照与发送动作。
 */
import type { Session, SessionGroup, SessionStateUi } from "@/types";

/** 浮动广播面板与主窗口之间共享的 BroadcastChannel 名称。 */
export const WIDGET_BROADCAST_CHANNEL = "fluxterm-broadcast-sync";

/** 广播面板快照：描述可渲染和可发送的运行时会话分组状态。 */
export type FloatingBroadcastSnapshot = {
  activeSessionId: string | null;
  sessions: Session[];
  sessionGroups: SessionGroup[];
  sessionStates: Record<string, SessionStateUi>;
};

/** 浮动广播面板发往主窗口的操作消息。 */
export type FloatingBroadcastActionMessage =
  | { type: "broadcast:request-snapshot" }
  | { type: "broadcast:send"; sessionIds: string[]; command: string };

/** 主窗口发往浮动广播面板的状态快照消息。 */
export type FloatingBroadcastSnapshotMessage = {
  type: "broadcast:snapshot";
  payload: FloatingBroadcastSnapshot;
};

/** 浮动广播面板同步协议的完整消息集合。 */
export type FloatingBroadcastMessage =
  | FloatingBroadcastActionMessage
  | FloatingBroadcastSnapshotMessage;
