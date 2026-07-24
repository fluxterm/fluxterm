import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { logInfo, logWarn } from "@/shared/logging";
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
} from "@/features/updater/core/updaterService";
import type { ToastLevel } from "@/hooks/useNotices";

export type AppUpdaterStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "error";

export type AppUpdateIndicator = "none" | "success" | "error";

type AppUpdateToastPayload = {
  level: ToastLevel;
  message: string;
};

type UseAppUpdaterOptions = {
  onToast?: (payload: AppUpdateToastPayload) => void;
  upToDateMessage?: string;
  updateCheckFailedMessage?: string;
  restartFailedMessage?: string;
};

/** 主窗口更新编排状态。 */
export type AppUpdaterState = {
  status: AppUpdaterStatus;
  indicator: AppUpdateIndicator;
  hasAvailableUpdate: boolean;
  downloadProgressPercent: number | null;
  isChecking: boolean;
  isDownloading: boolean;
  triggerUpdateAction: () => Promise<void>;
  resetCheckState: () => void;
};

/** 管理应用更新检查与安装流程。 */
export default function useAppUpdater(
  options: UseAppUpdaterOptions = {},
): AppUpdaterState {
  const {
    onToast,
    upToDateMessage,
    updateCheckFailedMessage,
    restartFailedMessage,
  } = options;
  const [status, setStatus] = useState<AppUpdaterStatus>("idle");
  const [indicator, setIndicator] = useState<AppUpdateIndicator>("none");
  const [downloadProgressPercent, setDownloadProgressPercent] = useState<
    number | null
  >(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const installRunningRef = useRef(false);
  const successStateTimerRef = useRef<number | null>(null);

  const isChecking = status === "checking";
  const isDownloading = status === "downloading";
  const hasAvailableUpdate = status === "update-available" && !!pendingUpdate;

  const clearSuccessStateTimer = useCallback(() => {
    if (successStateTimerRef.current == null) return;
    window.clearTimeout(successStateTimerRef.current);
    successStateTimerRef.current = null;
  }, []);

  const scheduleResetFromSuccessState = useCallback(() => {
    clearSuccessStateTimer();
    successStateTimerRef.current = window.setTimeout(() => {
      setIndicator("none");
      setStatus((prev) => (prev === "up-to-date" ? "idle" : prev));
      successStateTimerRef.current = null;
    }, 2600);
  }, [clearSuccessStateTimer]);

  useEffect(() => clearSuccessStateTimer, [clearSuccessStateTimer]);

  const installAvailableUpdate = useCallback(async () => {
    if (
      !pendingUpdate ||
      isChecking ||
      isDownloading ||
      installRunningRef.current
    ) {
      return;
    }
    installRunningRef.current = true;
    clearSuccessStateTimer();
    setStatus("downloading");
    setDownloadProgressPercent(0);
    try {
      let totalBytes = 0;
      let downloadedBytes = 0;
      await downloadAndInstallUpdate(pendingUpdate, (event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          setDownloadProgressPercent(0);
          return;
        }
        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            const percent = Math.min(
              100,
              Math.round((downloadedBytes / totalBytes) * 100),
            );
            setDownloadProgressPercent(percent);
          }
          return;
        }
        setDownloadProgressPercent(100);
      });
      setPendingUpdate(null);
      setStatus("idle");
      setIndicator("none");
      setDownloadProgressPercent(null);
      logInfo("app.update.install.succeeded");
      try {
        await relaunch();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onToast?.({
          level: "error",
          message: restartFailedMessage ?? message,
        });
        logWarn("app.update.relaunch.failed", {
          error: {
            code: "app_update_relaunch_failed",
            message: "Application relaunch after update failed",
            detail: message,
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus("error");
      setIndicator("error");
      setDownloadProgressPercent(null);
      onToast?.({
        level: "error",
        message,
      });
      logWarn("app.update.install.failed", {
        error: {
          code: "app_update_install_failed",
          message: "Application update installation failed",
          detail: message,
        },
      });
    } finally {
      installRunningRef.current = false;
    }
  }, [
    clearSuccessStateTimer,
    isChecking,
    isDownloading,
    onToast,
    pendingUpdate,
    restartFailedMessage,
  ]);

  const checkForUpdates = useCallback(async () => {
    if (isChecking || isDownloading || installRunningRef.current) return;
    clearSuccessStateTimer();
    setStatus("checking");
    setIndicator("none");
    setDownloadProgressPercent(null);
    try {
      const result = await checkForAppUpdate();
      if (!result.available || !result.update) {
        setPendingUpdate(null);
        setStatus("up-to-date");
        setIndicator("success");
        if (upToDateMessage) {
          onToast?.({
            level: "success",
            message: upToDateMessage,
          });
        }
        scheduleResetFromSuccessState();
        logInfo("app.update.check.current");
        return;
      }
      setPendingUpdate(result.update);
      setIndicator("success");
      setStatus("update-available");
      logInfo("app.update.check.available", {
        version: result.version,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingUpdate(null);
      setStatus("error");
      setIndicator("error");
      if (updateCheckFailedMessage) {
        onToast?.({
          level: "error",
          message: updateCheckFailedMessage,
        });
      }
      logWarn("app.update.check.failed", {
        error: {
          code: "app_update_check_failed",
          message: "Application update check failed",
          detail: message,
        },
      });
    }
  }, [
    clearSuccessStateTimer,
    isChecking,
    isDownloading,
    onToast,
    upToDateMessage,
    updateCheckFailedMessage,
    scheduleResetFromSuccessState,
  ]);

  const triggerUpdateAction = useCallback(async () => {
    if (hasAvailableUpdate) {
      await installAvailableUpdate();
      return;
    }
    await checkForUpdates();
  }, [checkForUpdates, hasAvailableUpdate, installAvailableUpdate]);

  const resetCheckState = useCallback(() => {
    clearSuccessStateTimer();
    setIndicator("none");
    setDownloadProgressPercent(null);
    if (!isDownloading) {
      setPendingUpdate(null);
      setStatus("idle");
    }
  }, [clearSuccessStateTimer, isDownloading]);

  return useMemo(
    () => ({
      status,
      indicator,
      hasAvailableUpdate,
      downloadProgressPercent,
      isChecking,
      isDownloading,
      triggerUpdateAction,
      resetCheckState,
    }),
    [
      indicator,
      hasAvailableUpdate,
      downloadProgressPercent,
      isChecking,
      isDownloading,
      triggerUpdateAction,
      resetCheckState,
      status,
    ],
  );
}
