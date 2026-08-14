/**
 * 浮动传输面板取消 RPC。
 * 职责：关联取消请求与主窗口回执，并在窗口销毁或回执超时时释放等待任务。
 */
import { useCallback, useEffect, useRef } from "react";
import type {
  FloatingTransfersCancelResultMessage,
  FloatingTransfersMessage,
} from "@/features/sftp/core/widgetTransfersSync";

type PendingFloatingTransferCancel = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

const FLOATING_TRANSFER_CANCEL_TIMEOUT_MS = 10_000;

/** 管理浮动传输面板取消请求的回执与超时。 */
export default function useFloatingTransferCancelRpc() {
  const pendingRef = useRef<Record<string, PendingFloatingTransferCancel>>({});
  const nextRequestIdRef = useRef(0);

  useEffect(
    () => () => {
      Object.values(pendingRef.current).forEach((pending) => {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("Transfer window closed"));
      });
      pendingRef.current = {};
    },
    [],
  );

  const requestCancel = useCallback(
    (
      postMessage: (message: FloatingTransfersMessage) => void,
      sessionId: string,
      transferId: string,
    ) => {
      const requestId = `transfer-cancel-${Date.now()}-${++nextRequestIdRef.current}`;
      return new Promise<void>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          delete pendingRef.current[requestId];
          reject(new Error("Transfer cancellation timed out"));
        }, FLOATING_TRANSFER_CANCEL_TIMEOUT_MS);
        pendingRef.current[requestId] = { resolve, reject, timeoutId };
        postMessage({
          type: "transfers:cancel",
          requestId,
          sessionId,
          transferId,
        });
      });
    },
    [],
  );

  const handleResult = useCallback(
    (message: FloatingTransfersCancelResultMessage) => {
      const pending = pendingRef.current[message.requestId];
      if (!pending) return;
      window.clearTimeout(pending.timeoutId);
      delete pendingRef.current[message.requestId];
      if (message.ok) {
        pending.resolve();
      } else {
        pending.reject(new Error("Transfer cancellation failed"));
      }
    },
    [],
  );

  return { requestCancel, handleResult };
}
