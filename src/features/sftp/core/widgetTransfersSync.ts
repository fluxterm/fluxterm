/**
 * 浮动传输面板同步协议。
 * 职责：定义主窗口与浮动传输面板之间共享的最小状态快照与动作消息。
 */
import type { AppEvent } from "@/types";
import type { RunningSftpTransfer } from "@/features/sftp/core/transferState";

/** 浮动传输面板与主窗口之间共享的 BroadcastChannel 名称。 */
export const WIDGET_TRANSFERS_CHANNEL = "fluxterm-transfers-sync";

/** 带会话标签的全局运行任务视图。 */
export type SftpTransferTaskView = RunningSftpTransfer & {
  sessionLabel: string;
};

/** 带会话标签的全局传输历史视图。 */
export type SftpTransferHistoryItem = {
  event: AppEvent;
  sessionLabel: string;
};

/** 传输面板快照：描述全局传输中心可渲染的最小状态。 */
export type FloatingTransfersSnapshot = {
  tasks: SftpTransferTaskView[];
  history: SftpTransferHistoryItem[];
};

/** 浮动传输面板发往主窗口的动作消息。 */
export type FloatingTransfersActionMessage =
  | { type: "transfers:request-snapshot" }
  | {
      type: "transfers:cancel";
      requestId: string;
      sessionId: string;
      transferId: string;
    };

/** 主窗口发往浮动传输面板的状态快照消息。 */
export type FloatingTransfersSnapshotMessage = {
  type: "transfers:snapshot";
  payload: FloatingTransfersSnapshot;
};

/** 主窗口返回的取消请求处理结果。 */
export type FloatingTransfersCancelResultMessage = {
  type: "transfers:cancel-result";
  requestId: string;
  ok: boolean;
};

/** 浮动传输面板同步协议的完整消息集合。 */
export type FloatingTransfersMessage =
  | FloatingTransfersActionMessage
  | FloatingTransfersSnapshotMessage
  | FloatingTransfersCancelResultMessage;
