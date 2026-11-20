import Button from "@/components/ui/button";
import { useNotices } from "@/hooks/useNotices";
import { isMacOS } from "@/utils/platform";
import "@/components/ui/notice-host.css";

/**
 * 全局通知宿主组件。
 * 职责：作为全局交互反馈层的渲染入口。
 * 1. 渲染自动消失的 Toast 消息。
 * 2. 渲染命令式弹出的 Dialog 确认框（如删除确认、错误提示等）。
 * 交互：Dialog 遮罩层特意避开了标题栏，以便在弹窗时依然可以关闭或最小化应用。
 */
export default function NoticeHost() {
  const { toasts, dialogs, closeDialog, closeToast } = useNotices();
  const activeDialog = dialogs[dialogs.length - 1] ?? null;
  const dialogOverlayClassName =
    `dialog-overlay ${isMacOS() ? "dialog-overlay--macos" : ""}`.trim();

  return (
    <>
      <div className="toast-layer" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast-item ${toast.level ?? "info"} ${toast.durationMs === 0 ? "toast-item--dismissible" : ""}`}
            role={toast.level === "error" ? "alert" : "status"}
            data-ui="notice-toast"
            data-slot={toast.level ?? "info"}
          >
            {toast.title && <strong>{toast.title}</strong>}
            <span>{toast.message}</span>
            {toast.durationMs === 0 && (
              <button
                type="button"
                className="toast-close"
                data-ui="notice-dismiss"
                aria-label={toast.dismissLabel ?? "Close"}
                title={toast.dismissLabel ?? "Close"}
                onClick={() => closeToast(toast.id)}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {activeDialog && (
        <div className={dialogOverlayClassName} role="presentation">
          <div className="dialog-card" role="alertdialog" aria-modal="true">
            <div className="dialog-title">{activeDialog.title}</div>
            <div
              className={`dialog-body ${
                activeDialog.bodyLayout === "details"
                  ? "dialog-body--details"
                  : ""
              }`.trim()}
            >
              {activeDialog.bodyLayout === "details" ? (
                <>
                  {activeDialog.message ? (
                    <p className="dialog-body__lead">{activeDialog.message}</p>
                  ) : null}
                  <div className="dialog-body__grid">
                    {(activeDialog.details ?? []).map((detail) => (
                      <div key={detail.label} className="dialog-body__grid-row">
                        <span className="dialog-body__label">
                          {detail.label}
                        </span>
                        <span
                          className={`dialog-body__value ${
                            detail.tone === "mono"
                              ? "dialog-body__fingerprint"
                              : ""
                          }`.trim()}
                        >
                          {detail.value}
                        </span>
                      </div>
                    ))}
                  </div>
                  {activeDialog.note ? (
                    <p className="dialog-body__note">{activeDialog.note}</p>
                  ) : null}
                </>
              ) : (
                activeDialog.message
              )}
            </div>
            <div className="dialog-actions">
              {activeDialog.cancelLabel && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    activeDialog.onCancel?.();
                    closeDialog(activeDialog.id);
                  }}
                >
                  {activeDialog.cancelLabel}
                </Button>
              )}
              {activeDialog.secondaryLabel && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    activeDialog.onSecondary?.();
                    closeDialog(activeDialog.id);
                  }}
                >
                  {activeDialog.secondaryLabel}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  activeDialog.onConfirm?.();
                  closeDialog(activeDialog.id);
                }}
              >
                {activeDialog.confirmLabel ?? "OK"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
