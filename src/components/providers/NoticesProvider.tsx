/**
 * 通知中心 Provider 模块。
 * 职责：
 * 1. 管理全局 Toast 与确认对话框状态。
 * 2. 通过 Context 向子树暴露 pushToast/openDialog/closeDialog 能力。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { appendToast } from "@/shared/notices/toastQueue";
import {
  NoticesContext,
  type DialogPayload,
  type ToastPayload,
} from "@/hooks/useNotices";

type ToastItem = ToastPayload & { id: string };
type DialogItem = DialogPayload & { id: string };

function buildId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 通用提示（Toast/对话框）管理。 */
export function NoticesProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialogs, setDialogs] = useState<DialogItem[]>([]);
  const timersRef = useRef<Record<string, number>>({});

  /** 关闭横幅时同时清理定时器，持久错误由用户明确关闭。 */
  const closeToast = useCallback((id: string) => {
    window.clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      Object.values(timers).forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const closeDialog = useCallback((id: string) => {
    setDialogs((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback(
    (payload: ToastPayload) => {
      const id = buildId("toast");
      const next: ToastItem = {
        ...payload,
        id,
        level: payload.level ?? "info",
        durationMs: payload.durationMs ?? 2600,
      };
      setToasts((previous) => appendToast(previous, next, 4));
      if (next.durationMs !== 0) {
        timersRef.current[id] = window.setTimeout(
          () => closeToast(id),
          next.durationMs,
        );
      }
    },
    [closeToast],
  );

  const openDialog = useCallback((payload: DialogPayload) => {
    const id = buildId("dialog");
    const next: DialogItem = { id, ...payload };
    setDialogs((prev) => prev.concat(next));
  }, []);

  const value = useMemo(
    () => ({ toasts, dialogs, pushToast, openDialog, closeDialog, closeToast }),
    [toasts, dialogs, pushToast, openDialog, closeDialog, closeToast],
  );

  return (
    <NoticesContext.Provider value={value}>{children}</NoticesContext.Provider>
  );
}
