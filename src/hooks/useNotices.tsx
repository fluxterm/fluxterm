import type React from "react";
import { createContext, useContext } from "react";

export type ToastLevel = "info" | "success" | "error";

export type ToastPayload = {
  title?: string;
  message: string;
  level?: ToastLevel;
  /** 为 0 时保留到用户主动关闭。 */
  durationMs?: number;
  dismissLabel?: string;
};

export type DialogPayload = {
  title: string;
  message: React.ReactNode;
  bodyLayout?: "plain" | "details";
  details?: Array<{
    label: string;
    value: React.ReactNode;
    tone?: "default" | "mono";
  }>;
  note?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  secondaryLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  onSecondary?: () => void;
};

export type ToastItem = ToastPayload & { id: string };
export type DialogItem = DialogPayload & { id: string };

export type NoticesContextValue = {
  toasts: ToastItem[];
  dialogs: DialogItem[];
  pushToast: (payload: ToastPayload) => void;
  openDialog: (payload: DialogPayload) => void;
  closeDialog: (id: string) => void;
  closeToast: (id: string) => void;
};

export const NoticesContext = createContext<NoticesContextValue | null>(null);

export function useNotices() {
  const ctx = useContext(NoticesContext);
  if (!ctx) {
    throw new Error("useNotices must be used within NoticesProvider");
  }
  return ctx;
}
