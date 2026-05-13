/**
 * 传输面板。
 * 职责：展示当前活动会话最近一个传输任务的聚合进度与传输日志。
 *
 * 当前视图以 job 为单位展示：
 * - 单文件传输显示文件名
 * - 目录传输优先显示 items count
 * - 目录传输会额外展示当前正在处理的文件名
 * - 进度条优先使用字节进度，未知总字节时退回项目数进度
 * - 只有 running 状态才显示取消按钮
 */
import { useEffect, useState } from "react";
import type { Locale, Translate } from "@/i18n";
import type { AppEvent, SftpProgress } from "@/types";
import { formatBytes, formatTime } from "@/utils/format";
import Button from "@/components/ui/button";
import "./Transferswidget.css";

type TransfersWidgetProps = {
  progress: SftpProgress | null;
  busyMessage: string | null;
  events: AppEvent[];
  onCancel: () => Promise<void>;
  locale: Locale;
  t: Translate;
};

function isTransferEvent(event: AppEvent) {
  return (
    event.scope === "sftp" &&
    (event.type.startsWith("sftp.upload.") ||
      event.type.startsWith("sftp.download."))
  );
}

function normalizeEventVars(event: AppEvent) {
  if (!event.vars) return undefined;
  return Object.fromEntries(
    Object.entries(event.vars).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number",
    ),
  );
}

/** 传输进度与记录面板。 */
export default function TransfersWidget({
  progress,
  busyMessage,
  events,
  onCancel,
  locale,
  t,
}: TransfersWidgetProps) {
  const transferEvents = events.filter(isTransferEvent);
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(
    null,
  );
  const [activeTransferId, setActiveTransferId] = useState<string | null>(null);

  const formatLogTime = (timestamp: number) =>
    formatTime(timestamp / 1000, locale);

  const progressLabel = progress
    ? progress.op === "upload"
      ? t("log.upload")
      : t("log.download")
    : "";
  const progressTitle = progress
    ? progress.totalItems && progress.totalItems > 1
      ? t("log.transferItems", { count: progress.totalItems })
      : progress.path
    : "";
  const progressPercent = progress
    ? progress.total && progress.total > 0
      ? Math.min(100, (progress.transferred / progress.total) * 100)
      : progress.totalItems && progress.totalItems > 0
        ? Math.min(100, (progress.completedItems / progress.totalItems) * 100)
        : 30
    : 0;
  const progressStatus = progress
    ? progress.status === "partial_success"
      ? t("log.transferPartialSuccess", { failed: progress.failedItems })
      : progress.status === "failed"
        ? t("log.transferFailed")
        : progress.status === "success"
          ? t("log.transferSuccess")
          : progress.status === "cancelled"
            ? t("log.transferCancelled")
            : t("log.transferRunning")
    : "";
  // 目录任务是批处理，用户需要知道当前具体卡在哪个文件上；
  // 单文件任务本身标题已经足够明确，不再额外重复一行。
  const currentItemName =
    progress && progress.kind !== "file"
      ? (progress.currentItemName ?? "")
      : "";
  const targetName =
    progress?.targetName && progress.targetName !== progress.displayName
      ? progress.targetName
      : "";

  useEffect(() => {
    if (!progress) {
      queueMicrotask(() => {
        setActiveTransferId(null);
        setProgressStartedAt(null);
      });
      return;
    }
    if (progress.transferId !== activeTransferId) {
      queueMicrotask(() => {
        setActiveTransferId(progress.transferId);
        setProgressStartedAt(Date.now());
      });
      return;
    }
    queueMicrotask(() => {
      setProgressStartedAt((prev) => prev ?? Date.now());
    });
  }, [activeTransferId, progress]);

  return (
    <div className="log-widget">
      <div className="log-row">
        <span>{t("log.currentTask")}</span>
        {progress?.status === "running" ? (
          <span className="log-current-task-actions">
            <strong>{busyMessage ?? t("log.idle")}</strong>
            <Button
              variant="ghost"
              size="sm"
              className="log-cancel-button"
              onClick={() => {
                onCancel().catch(() => {});
              }}
            >
              {t("actions.cancelTransfer")}
            </Button>
          </span>
        ) : (
          <strong>{busyMessage ?? t("log.idle")}</strong>
        )}
      </div>
      {progress && (
        <div className="log-progress">
          <div className="log-row log-row-transfer">
            <span className="log-transfer-meta">
              [
              {progressStartedAt
                ? formatTime(progressStartedAt / 1000, locale)
                : "--"}
              ] [{progressLabel}]{" "}
            </span>
            <strong className="log-transfer-path">{progressTitle}</strong>
          </div>
          <div className="progress-bar">
            <span
              style={{
                width: `${progressPercent}%`,
              }}
            />
          </div>
          <div className="log-row small">
            <span>
              {t("log.transferItemsProgress", {
                completed: progress.completedItems,
                total: progress.totalItems ?? "?",
              })}
            </span>
            <span>{progressStatus}</span>
          </div>
          {!!currentItemName && (
            <div className="log-row small">
              <span>{t("log.transferCurrentItem")}</span>
              <span className="log-transfer-current">{currentItemName}</span>
            </div>
          )}
          {!!targetName && (
            <div className="log-row small">
              <span>{t("log.transferTargetName")}</span>
              <span className="log-transfer-current">{targetName}</span>
            </div>
          )}
          <div className="log-row small">
            <span>{formatBytes(progress.transferred)}</span>
            <span>
              {progress.total
                ? formatBytes(progress.total)
                : t("log.unknownSize")}
            </span>
          </div>
        </div>
      )}
      {!!transferEvents.length && (
        <div className="log-list">
          <div className="log-list-header">{t("log.history")}</div>
          <div className="log-list-body">
            {transferEvents.map((event) => (
              <div key={event.id} className={`log-item ${event.level}`}>
                <span className="log-time">
                  {formatLogTime(event.timestamp)}
                </span>
                <span className="log-message">
                  {t(event.titleKey, normalizeEventVars(event))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
