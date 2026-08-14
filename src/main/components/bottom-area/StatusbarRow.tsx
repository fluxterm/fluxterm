import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FiActivity,
  FiDatabase,
  FiLock,
  FiRepeat,
  FiUnlock,
} from "react-icons/fi";
import type { Locale, Translate } from "@/i18n";
import type { ResourceMonitorStatus, SessionResourceSnapshot } from "@/types";
import type { RunningSftpTransfer } from "@/features/sftp/core/transferState";
import { FLUXTERM_ISSUES_URL } from "@/constants/links";
import { formatDateTime } from "@/utils/format";
import type { TerminalStats } from "@/main/components/bottom-area/BottomArea.types";
import {
  formatBytes,
  formatPercent,
  formatUptime,
  resolveResourceSeverity,
  resolveResourceUnsupportedMessage,
} from "@/main/components/bottom-area/resourceFormat";
import type { SecurityProvider } from "@/features/security/types";

type StatusbarRowProps = {
  stats: TerminalStats;
  now: Date;
  resourceMonitorEnabled: boolean;
  resourceMonitorStatus: ResourceMonitorStatus;
  resourceSnapshot: SessionResourceSnapshot | null;
  runningTransfers: RunningSftpTransfer[];
  onOpenTransfersWidget: () => void;
  activeAiConfigName: string | null;
  securityLocked: boolean;
  securityProvider: SecurityProvider;
  onSecurityAction: () => void;
  onLockScreen: () => void;
  locale: Locale;
  t: Translate;
};

/** 底部状态栏。 */
export default function StatusbarRow({
  stats,
  now,
  resourceMonitorEnabled,
  resourceMonitorStatus,
  resourceSnapshot,
  runningTransfers,
  onOpenTransfersWidget,
  activeAiConfigName,
  securityLocked,
  securityProvider,
  onSecurityAction,
  onLockScreen,
  locale,
  t,
}: StatusbarRowProps) {
  const [resourcePopoverOpen, setResourcePopoverOpen] = useState(false);

  const transferHint = useMemo(() => {
    // 仅统计运行中的上传/下载任务，用于状态栏常驻指示器与点击行为控制。
    const progresses = runningTransfers.map((item) => item.progress);
    const runningUploads = progresses.filter(
      (item) => item.status === "running" && item.op === "upload",
    ).length;
    const runningDownloads = progresses.filter(
      (item) => item.status === "running" && item.op === "download",
    ).length;
    return {
      runningUploads,
      runningDownloads,
      hasTransfer: runningUploads > 0 || runningDownloads > 0,
    };
  }, [runningTransfers]);

  const showResourceStatus = resourceMonitorEnabled;
  const resourceStatus = resourceMonitorStatus;
  const resourceCpu = resourceSnapshot?.cpu ?? null;
  const resourceMemory = resourceSnapshot?.memory ?? null;
  const resourceUnsupportedMessage = resolveResourceUnsupportedMessage(
    t,
    resourceSnapshot?.unsupportedReason,
  );
  const allowResourcePopover =
    resourceStatus === "ready" && Boolean(resourceCpu && resourceMemory);
  const readyResourceCpu = allowResourcePopover ? resourceCpu : null;
  const readyResourceMemory = allowResourcePopover ? resourceMemory : null;
  const readyResourceCpuCount = readyResourceCpu?.logicalCpuCount ?? null;
  const readyResourceUptime = allowResourcePopover
    ? (resourceSnapshot?.uptimeSeconds ?? null)
    : null;
  const resourceMemoryPercent =
    resourceMemory && resourceMemory.totalBytes > 0
      ? (resourceMemory.usedBytes / resourceMemory.totalBytes) * 100
      : 0;
  const cpuSeverity = resourceCpu
    ? resolveResourceSeverity(resourceCpu.totalPercent)
    : "success";
  const memorySeverity = resourceMemory
    ? resolveResourceSeverity(resourceMemoryPercent)
    : "success";

  return (
    <div className="statusbar-row">
      <div className="statusbar">
        <div className="statusbar-left">
          {showResourceStatus && (
            <div
              className="statusbar-resource"
              onMouseEnter={() => {
                if (allowResourcePopover) setResourcePopoverOpen(true);
              }}
              onMouseLeave={() => {
                if (resourcePopoverOpen) setResourcePopoverOpen(false);
              }}
            >
              {resourceStatus === "ready" && resourceCpu && resourceMemory ? (
                <>
                  <span
                    className={`statusbar-resource-chip ${cpuSeverity}`.trim()}
                  >
                    <FiActivity />
                    <span>
                      {t("status.resource.cpu")}{" "}
                      {formatPercent(resourceCpu.totalPercent)}
                    </span>
                  </span>
                  <span
                    className={`statusbar-resource-chip ${memorySeverity}`.trim()}
                  >
                    <FiDatabase />
                    <span>
                      {t("status.resource.memory")}{" "}
                      {formatPercent(resourceMemoryPercent)}
                    </span>
                  </span>
                </>
              ) : (
                <span className="statusbar-resource-chip muted">
                  {resourceStatus === "disabled"
                    ? t("status.resource.inactive")
                    : resourceStatus === "unsupported"
                      ? resourceUnsupportedMessage
                      : t("status.resource.checking")}
                </span>
              )}
              {allowResourcePopover && resourcePopoverOpen && (
                <div
                  className="statusbar-resource-popover"
                  data-ui="statusbar-resource-popover"
                >
                  <>
                    <div className="statusbar-resource-block cpu">
                      <div className="statusbar-resource-title cpu">
                        {t("status.resource.cpu")}
                      </div>
                      <div className="statusbar-resource-grid">
                        <span>{t("status.resource.usage")}</span>
                        <strong>
                          {formatPercent(readyResourceCpu!.totalPercent)}
                        </strong>
                        {readyResourceCpuCount !== null && (
                          <>
                            <span>{t("status.resource.cpuLogicalCores")}</span>
                            <strong>{readyResourceCpuCount}</strong>
                          </>
                        )}
                        {readyResourceUptime !== null && (
                          <>
                            <span>{t("status.resource.uptime")}</span>
                            <strong>{formatUptime(readyResourceUptime)}</strong>
                          </>
                        )}
                        {resourceSnapshot?.source === "ssh-linux" && (
                          <>
                            <span>{t("status.resource.user")}</span>
                            <strong>
                              {formatPercent(readyResourceCpu!.userPercent)}
                            </strong>
                            <span>{t("status.resource.system")}</span>
                            <strong>
                              {formatPercent(readyResourceCpu!.systemPercent)}
                            </strong>
                            <span>{t("status.resource.idle")}</span>
                            <strong>
                              {formatPercent(readyResourceCpu!.idlePercent)}
                            </strong>
                            <span>{t("status.resource.iowait")}</span>
                            <strong>
                              {formatPercent(readyResourceCpu!.iowaitPercent)}
                            </strong>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="statusbar-resource-block memory">
                      <div className="statusbar-resource-title memory">
                        {t("status.resource.memory")}
                      </div>
                      <div className="statusbar-resource-grid">
                        <span>{t("status.resource.total")}</span>
                        <strong>
                          {formatBytes(readyResourceMemory!.totalBytes)}
                        </strong>
                        <span>{t("status.resource.used")}</span>
                        <strong>
                          {formatBytes(readyResourceMemory!.usedBytes)}
                        </strong>
                        <span>{t("status.resource.free")}</span>
                        <strong>
                          {formatBytes(readyResourceMemory!.freeBytes)}
                        </strong>
                        <span>{t("status.resource.available")}</span>
                        <strong>
                          {formatBytes(readyResourceMemory!.availableBytes)}
                        </strong>
                        <span>{t("status.resource.cache")}</span>
                        <strong>
                          {formatBytes(readyResourceMemory!.cacheBytes)}
                        </strong>
                      </div>
                    </div>
                  </>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="statusbar-right">
          {/* 约定：右侧状态区中，AI 与传输指示必须固定在最左侧，后续新增状态信息不得插入其前方。 */}
          <span className="statusbar-ai-chip">
            {t("status.ai")} {activeAiConfigName || t("status.ai.unset")}
          </span>
          <div className="statusbar-transfer" aria-live="polite">
            <button
              type="button"
              data-ui="statusbar-transfer-button"
              className={`statusbar-transfer-token ${transferHint.hasTransfer ? "active" : "idle"}`.trim()}
              aria-label={
                transferHint.hasTransfer
                  ? `${t("actions.upload")} ${transferHint.runningUploads} / ${t("actions.download")} ${transferHint.runningDownloads}`
                  : `${t("actions.upload")} / ${t("actions.download")}`
              }
              onClick={() => {
                // 仅在存在运行任务时允许打开传输组件。
                if (transferHint.hasTransfer) onOpenTransfersWidget();
              }}
            >
              <FiRepeat />
            </button>
          </div>
          <button
            type="button"
            className={`statusbar-security-chip ${
              securityProvider === "embedded"
                ? "weak"
                : securityLocked
                  ? "locked"
                  : "unlocked"
            }`.trim()}
            onClick={onSecurityAction}
            aria-label={
              securityProvider === "embedded"
                ? t("status.security.weakAction")
                : securityLocked
                  ? t("status.security.lockedAction")
                  : t("status.security.unlockedAction")
            }
          >
            {securityProvider === "embedded" ? (
              <FiUnlock />
            ) : securityLocked ? (
              <FiLock />
            ) : (
              <FiUnlock />
            )}
            <span>
              {securityProvider === "embedded"
                ? t("status.security.weak")
                : securityLocked
                  ? t("status.security.locked")
                  : t("status.security.unlocked")}
            </span>
          </button>
          <span className="statusbar-info-chip">
            {t("status.window")} {stats.windowRows}x{stats.windowCols}
          </span>
          <span className="statusbar-info-chip">
            {t("status.buffer")} {stats.bufferLines}
          </span>
          <button
            type="button"
            className="statusbar-link-chip"
            aria-label="Issues"
            onClick={() => {
              void openUrl(FLUXTERM_ISSUES_URL);
            }}
          >
            <span>Issues</span>
          </button>
          <button
            type="button"
            className="statusbar-lock-screen-chip"
            data-ui="lock-screen-trigger"
            aria-label={t("lockScreen.lock")}
            onClick={onLockScreen}
          >
            <span>{t("lockScreen.lock")}</span>
          </button>
          <span className="statusbar-info-chip">
            {formatDateTime(now, locale)}
          </span>
        </div>
      </div>
    </div>
  );
}
