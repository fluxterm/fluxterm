/**
 * 全局传输中心。
 * 职责：展示所有 SSH 会话正在运行的 SFTP 任务及全局传输历史。
 */
import { useState } from "react";
import { FiDownload, FiLoader, FiUpload } from "react-icons/fi";
import type { Locale, Translate } from "@/i18n";
import type { AppEvent, SftpProgress } from "@/types";
import type {
  SftpTransferHistoryItem,
  SftpTransferTaskView,
} from "@/features/sftp/core/widgetTransfersSync";
import { getSftpTransferKey } from "@/features/sftp/core/transferState";
import { formatBytes, formatTime } from "@/utils/format";
import Button from "@/components/ui/button";
import "./TransfersWidget.css";

type TransfersWidgetProps = {
  tasks: SftpTransferTaskView[];
  history: SftpTransferHistoryItem[];
  onCancel: (sessionId: string, transferId: string) => Promise<void>;
  locale: Locale;
  t: Translate;
};

/** 过滤事件插值变量，只保留翻译函数支持的标量。 */
function normalizeEventVars(event: AppEvent) {
  if (!event.vars) return undefined;
  return Object.fromEntries(
    Object.entries(event.vars).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number",
    ),
  );
}

/** 计算任务进度；总字节未知时回退到项目数。 */
function resolveProgress(progress: SftpProgress) {
  if (progress.total && progress.total > 0) {
    return {
      percent: Math.min(100, (progress.transferred / progress.total) * 100),
      determinate: true,
    };
  }
  if (progress.totalItems && progress.totalItems > 0) {
    return {
      percent: Math.min(
        100,
        (progress.completedItems / progress.totalItems) * 100,
      ),
      determinate: true,
    };
  }
  return { percent: 30, determinate: false };
}

/** 单个运行任务卡片。 */
function TransferTaskCard({
  task,
  onCancel,
  locale,
  t,
}: {
  task: SftpTransferTaskView;
  onCancel: TransfersWidgetProps["onCancel"];
  locale: Locale;
  t: Translate;
}) {
  const { progress, sessionLabel, startedAt } = task;
  const [isCancelling, setIsCancelling] = useState(false);
  const progressMeta = resolveProgress(progress);
  const progressLabel =
    progress.op === "upload" ? t("log.upload") : t("log.download");
  const progressTitle =
    progress.totalItems && progress.totalItems > 1
      ? t("log.transferItems", { count: progress.totalItems })
      : progress.displayName || progress.path;
  const currentItemName =
    progress.kind !== "file" ? (progress.currentItemName ?? "") : "";
  const targetName =
    progress.targetName && progress.targetName !== progress.displayName
      ? progress.targetName
      : "";

  /** 发出一次取消请求，并保持等待态直到后端终态事件移除任务。 */
  async function handleCancel() {
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      await onCancel(progress.sessionId, progress.transferId);
    } catch {
      setIsCancelling(false);
    }
  }

  return (
    <article
      className="transfer-task"
      data-slot="transfer-task"
      data-session-id={progress.sessionId}
      data-transfer-id={progress.transferId}
    >
      <div className="transfer-task-header">
        <div className="transfer-task-owner">
          <span className={`transfer-op ${progress.op}`} aria-hidden="true">
            {progress.op === "upload" ? <FiUpload /> : <FiDownload />}
          </span>
          <span className="transfer-session" title={sessionLabel}>
            {sessionLabel}
          </span>
          <span className="transfer-started">
            {formatTime(startedAt / 1000, locale)}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="transfer-cancel-button"
          data-slot="transfer-cancel"
          data-state={isCancelling ? "loading" : "idle"}
          disabled={isCancelling}
          aria-busy={isCancelling}
          onClick={() => void handleCancel()}
          aria-label={t("transfers.cancelAria", {
            session: sessionLabel,
            name: progressTitle,
          })}
        >
          {isCancelling && (
            <FiLoader className="transfer-cancel-spinner" aria-hidden="true" />
          )}
          {isCancelling
            ? t("transfers.cancelling")
            : t("actions.cancelTransfer")}
        </Button>
      </div>

      <div className="transfer-task-title-row">
        <span className="transfer-kind">{progressLabel}</span>
        <strong className="transfer-task-title" title={progressTitle}>
          {progressTitle}
        </strong>
      </div>

      <div
        className={`transfer-progress ${progressMeta.determinate ? "" : "indeterminate"}`.trim()}
        role="progressbar"
        aria-label={`${sessionLabel} ${progressLabel} ${progressTitle}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          progressMeta.determinate
            ? Math.round(progressMeta.percent)
            : undefined
        }
        aria-valuetext={
          progressMeta.determinate ? undefined : t("log.transferRunning")
        }
      >
        <span style={{ width: `${progressMeta.percent}%` }} />
      </div>

      <div className="transfer-detail-row">
        <span>
          {t("log.transferItemsProgress", {
            completed: progress.completedItems,
            total: progress.totalItems ?? "?",
          })}
        </span>
        <span>
          {formatBytes(progress.transferred)} /{" "}
          {progress.total ? formatBytes(progress.total) : t("log.unknownSize")}
        </span>
      </div>

      {!!currentItemName && (
        <div className="transfer-detail-row">
          <span>{t("log.transferCurrentItem")}</span>
          <span className="transfer-detail-value" title={currentItemName}>
            {currentItemName}
          </span>
        </div>
      )}
      {!!targetName && (
        <div className="transfer-detail-row">
          <span>{t("log.transferTargetName")}</span>
          <span className="transfer-detail-value" title={targetName}>
            {targetName}
          </span>
        </div>
      )}
    </article>
  );
}

/** 全局传输进度与历史面板。 */
export default function TransfersWidget({
  tasks,
  history,
  onCancel,
  locale,
  t,
}: TransfersWidgetProps) {
  const formatLogTime = (timestamp: number) =>
    formatTime(timestamp / 1000, locale);

  return (
    <div className="transfer-widget" data-ui="transfers-widget">
      <section
        className="transfer-section"
        data-slot="active-transfers"
        aria-live="polite"
      >
        <div className="transfer-section-header">
          <span>{t("transfers.active")}</span>
          <strong>
            {tasks.length
              ? t("transfers.runningCount", { count: tasks.length })
              : t("log.idle")}
          </strong>
        </div>
        {tasks.length ? (
          <div className="transfer-task-list">
            {tasks.map((task) => (
              <TransferTaskCard
                key={getSftpTransferKey(
                  task.progress.sessionId,
                  task.progress.transferId,
                )}
                task={task}
                onCancel={onCancel}
                locale={locale}
                t={t}
              />
            ))}
          </div>
        ) : (
          <div className="transfer-empty" data-slot="transfer-empty">
            {t("transfers.empty")}
          </div>
        )}
      </section>

      {!!history.length && (
        <section className="transfer-section" data-slot="transfer-history">
          <div className="transfer-history-header">{t("log.history")}</div>
          <div className="transfer-history-list">
            {history.map(({ event, sessionLabel }) => (
              <div
                key={event.id}
                className={`transfer-history-item ${event.level}`}
                data-slot="transfer-history-item"
              >
                <span className="transfer-history-time">
                  {formatLogTime(event.timestamp)}
                </span>
                <span className="transfer-history-session" title={sessionLabel}>
                  {sessionLabel}
                </span>
                <span className="transfer-history-message">
                  {t(event.titleKey, normalizeEventVars(event))}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
