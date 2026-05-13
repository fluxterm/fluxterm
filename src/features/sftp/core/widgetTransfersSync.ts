/**
 * 浮动传输面板同步协议。
 * 职责：定义主窗口与浮动传输面板之间共享的最小状态快照与动作消息。
 */
import type { AppEvent, SftpProgress } from "@/types";

/** 浮动传输面板与主窗口之间共享的 BroadcastChannel 名称。 */
export const WIDGET_TRANSFERS_CHANNEL = "fluxterm-transfers-sync";

/** 传输面板快照：描述当前会话传输区可渲染的最小状态。 */
export type FloatingTransfersSnapshot = {
  activeSessionId: string | null;
  progress: SftpProgress | null;
  busyMessage: string | null;
  events: AppEvent[];
};

/** 浮动传输面板发往主窗口的动作消息。 */
export type FloatingTransfersActionMessage =
  | { type: "transfers:request-snapshot" }
  | { type: "transfers:cancel" };

/** 主窗口发往浮动传输面板的状态快照消息。 */
export type FloatingTransfersSnapshotMessage = {
  type: "transfers:snapshot";
  payload: FloatingTransfersSnapshot;
};

/** 浮动传输面板同步协议的完整消息集合。 */
export type FloatingTransfersMessage =
  | FloatingTransfersActionMessage
  | FloatingTransfersSnapshotMessage;
