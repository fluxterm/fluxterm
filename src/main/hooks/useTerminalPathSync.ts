/**
 * 终端当前目录与文件面板同步。
 * 职责：记录终端 cwd 能力与路径，并在路径变化时单向驱动文件面板。
 */
import { useEffect, useMemo, useState } from "react";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import { normalizeLocalPath } from "@/features/sftp/core/path";
import { extractErrorMessage } from "@/shared/errors/appError";
import { logDebug, logWarn } from "@/shared/logging";
import type {
  HostProfile,
  LocalSessionMeta,
  TerminalCwdSupport,
  TerminalPathSyncState,
  TerminalWorkingDirectory,
} from "@/types";
import type { SftpAvailability } from "@/types";

export type TerminalPathSyncStatus =
  | "active"
  | "paused"
  | "checking"
  | "unsupported"
  | "disabled";

type UseTerminalPathSyncOptions = {
  enabled: boolean;
  filesWidgetVisible: boolean;
  sftpEnabled: boolean;
  activeSessionId: string | null;
  activeSessionProfile: HostProfile | null;
  isRemoteConnected: boolean;
  localSessionMeta: Record<string, LocalSessionMeta>;
  currentPath: string;
  activeSftpAvailability: SftpAvailability;
  isLocalSession: (sessionId: string) => boolean;
  openRemoteDir: (path: string) => Promise<void>;
};

type UseTerminalPathSyncState = {
  activeTerminalPathSyncStatus: TerminalPathSyncStatus;
  handleWorkingDirectoryChange: (
    sessionId: string,
    payload: TerminalWorkingDirectory,
  ) => void;
  handlePathSyncSupportChange: (
    sessionId: string,
    status: TerminalCwdSupport,
  ) => void;
};

function resolveTrackedWorkingDirectory(
  rawPath: string,
  homePath: string | null,
  isLocalPath: boolean,
) {
  if (isLocalPath) {
    if (rawPath === "drives://") return rawPath;
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(rawPath)) {
      return normalizeLocalPath(rawPath);
    }
    if (!rawPath.startsWith("~") || !homePath) return null;
    if (rawPath === "~") return normalizeLocalPath(homePath);
    const normalizedHome = normalizeLocalPath(homePath);
    return normalizeLocalPath(
      `${normalizedHome.replace(/[\\/]+$/, "")}\\${rawPath.slice(2)}`,
    );
  }
  if (rawPath.startsWith("/")) return rawPath;
  if (!rawPath.startsWith("~") || !homePath) return null;
  if (rawPath === "~") return homePath;
  return `${homePath.replace(/\/+$/, "")}/${rawPath.slice(2)}`;
}

function resolveWslWindowsPath(rawPath: string) {
  const mountMatch = rawPath.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (!mountMatch) return null;
  const driveLetter = mountMatch[1].toUpperCase();
  const tail = (mountMatch[2] ?? "").replace(/\//g, "\\");
  return `${driveLetter}:${tail || "\\"}`;
}

/** 将 WSL Unix 路径映射为 Windows 可访问的 UNC 路径。 */
function resolveWslUncPath(rawPath: string, distribution: string | null) {
  const normalizedDistribution = distribution?.trim();
  if (!normalizedDistribution) return null;
  const normalizedPath = rawPath.trim();
  if (!normalizedPath.startsWith("/")) return null;
  const tail = normalizedPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .join("\\");
  const uncRoot = `\\\\wsl.localhost\\${normalizedDistribution}`;
  return tail ? `${uncRoot}\\${tail}` : uncRoot;
}

/** 推导 WSL 用户家目录的 UNC 路径。 */
function resolveWslHomeUncPath(
  distribution: string | null,
  username: string | null,
) {
  const normalizedUsername = username?.trim();
  if (!normalizedUsername) return null;
  return resolveWslUncPath(`/home/${normalizedUsername}`, distribution);
}

/** 推导 WSL 用户家目录的 Unix 路径，用于缓存 `~` 展开结果。 */
function inferWslHomePath(rawPath: string, username: string | null) {
  const normalizedUsername = username?.trim();
  if (!normalizedUsername) return null;
  const normalizedPath = rawPath.trim();
  const expectedHome = `/home/${normalizedUsername}`;
  if (normalizedPath === "~" || normalizedPath.startsWith("~/")) {
    return expectedHome;
  }
  if (
    normalizedPath === expectedHome ||
    normalizedPath.startsWith(`${expectedHome}/`)
  ) {
    return expectedHome;
  }
  return null;
}

function resolveLocalSessionWorkingDirectory(
  rawPath: string,
  homePath: string | null,
  localMeta: LocalSessionMeta | null | undefined,
  username: string | null,
) {
  if (localMeta?.shellKind === "wsl") {
    if (rawPath === "~") {
      if (!homePath) {
        return resolveWslHomeUncPath(
          localMeta.wslDistribution ?? null,
          username,
        );
      }
      return (
        resolveWslWindowsPath(homePath) ??
        resolveWslUncPath(homePath, localMeta.wslDistribution ?? null)
      );
    }
    if (rawPath.startsWith("~/")) {
      const resolvedHome = homePath
        ? (resolveWslWindowsPath(homePath) ??
          resolveWslUncPath(homePath, localMeta.wslDistribution ?? null))
        : resolveWslHomeUncPath(localMeta.wslDistribution ?? null, username);
      if (!resolvedHome) return null;
      return normalizeLocalPath(
        `${resolvedHome.replace(/[\\/]+$/, "")}\\${rawPath.slice(2).replace(/\//g, "\\")}`,
      );
    }
    return (
      resolveWslWindowsPath(rawPath) ??
      resolveWslUncPath(rawPath, localMeta.wslDistribution ?? null)
    );
  }
  return resolveTrackedWorkingDirectory(rawPath, homePath, true);
}

/** 管理终端路径同步状态与文件面板跳转。 */
export default function useTerminalPathSync({
  enabled,
  filesWidgetVisible,
  sftpEnabled,
  activeSessionId,
  activeSessionProfile,
  isRemoteConnected,
  localSessionMeta,
  currentPath,
  activeSftpAvailability,
  isLocalSession,
  openRemoteDir,
}: UseTerminalPathSyncOptions): UseTerminalPathSyncState {
  const [terminalWorkingDirs, setTerminalWorkingDirs] = useState<
    Record<string, TerminalWorkingDirectory>
  >({});
  const [terminalHomeDirs, setTerminalHomeDirs] = useState<
    Record<string, string>
  >({});
  const [lastSyncedTerminalPaths, setLastSyncedTerminalPaths] = useState<
    Record<string, string>
  >({});
  const [terminalCwdSupportBySession, setTerminalCwdSupportBySession] =
    useState<Record<string, TerminalCwdSupport>>({});
  const [terminalPathSyncStateBySession, setTerminalPathSyncStateBySession] =
    useState<Record<string, TerminalPathSyncState>>({});

  useEffect(() => {
    if (!activeSessionId) return;
    const cancel = scheduleDeferredTask(() => {
      setTerminalCwdSupportBySession((prev) =>
        prev[activeSessionId]
          ? prev
          : { ...prev, [activeSessionId]: "unsupported" },
      );
    });
    return cancel;
  }, [activeSessionId]);

  const activeTerminalPathSyncStatus = useMemo<TerminalPathSyncStatus>(() => {
    if (!enabled || !filesWidgetVisible) {
      return "disabled";
    }
    if (!activeSessionId) return "unsupported";
    const local = isLocalSession(activeSessionId);
    if (!local && !sftpEnabled) {
      return "disabled";
    }
    const cwdSupport =
      terminalCwdSupportBySession[activeSessionId] ?? "unsupported";
    const tracked = terminalWorkingDirs[activeSessionId];
    const meta = localSessionMeta[activeSessionId];
    const inferredLocalHome =
      tracked && meta?.shellKind === "wsl"
        ? inferWslHomePath(tracked.path, tracked.username)
        : null;
    const knownHome =
      terminalHomeDirs[activeSessionId] ??
      inferredLocalHome ??
      (tracked?.path === "~" && !!currentPath ? currentPath : null);
    const localResolvedPath =
      local && tracked
        ? resolveLocalSessionWorkingDirectory(
            tracked.path,
            knownHome,
            meta,
            tracked.username,
          )
        : null;
    const pathSyncState = terminalPathSyncStateBySession[activeSessionId];
    if (
      !local &&
      cwdSupport !== "supported" &&
      activeSftpAvailability === "checking"
    ) {
      return "checking";
    }
    if (cwdSupport !== "supported") {
      return "unsupported";
    }
    if (local && !localResolvedPath) {
      return "unsupported";
    }
    if (!local && activeSftpAvailability === "unsupported") {
      return "unsupported";
    }
    return pathSyncState === "paused-mismatch" ? "paused" : "active";
  }, [
    activeSessionId,
    activeSftpAvailability,
    currentPath,
    enabled,
    filesWidgetVisible,
    isLocalSession,
    localSessionMeta,
    sftpEnabled,
    terminalCwdSupportBySession,
    terminalHomeDirs,
    terminalPathSyncStateBySession,
    terminalWorkingDirs,
  ]);

  useEffect(() => {
    if (!activeSessionId) return;
    const local = isLocalSession(activeSessionId);
    if (!enabled || !filesWidgetVisible) return;
    if (!local && !sftpEnabled) return;
    if (!local && !isRemoteConnected) return;
    const tracked = terminalWorkingDirs[activeSessionId];
    if (!tracked) return;
    if (
      (terminalCwdSupportBySession[activeSessionId] ?? "unsupported") !==
      "supported"
    ) {
      return;
    }
    if (!local && activeSftpAvailability === "unsupported") return;
    const loginUsername = activeSessionProfile?.username?.trim() || null;
    const promptUsername = tracked.username?.trim() || null;
    const syncState =
      terminalPathSyncStateBySession[activeSessionId] ?? "active";
    if (
      !local &&
      loginUsername &&
      promptUsername &&
      loginUsername !== promptUsername
    ) {
      if (syncState !== "paused-mismatch") {
        scheduleDeferredTask(() => {
          setTerminalPathSyncStateBySession((prev) => ({
            ...prev,
            [activeSessionId]: "paused-mismatch",
          }));
        });
        logWarn("terminal.cwd.sync.paused", {
          sessionId: activeSessionId,
          reason: "usernameMismatch",
          loginUsername,
          promptUsername,
        });
      }
      return;
    }
    if (!local && syncState === "paused-mismatch") {
      scheduleDeferredTask(() => {
        setTerminalPathSyncStateBySession((prev) => ({
          ...prev,
          [activeSessionId]: "active",
        }));
      });
      logDebug("terminal.cwd.sync.resumed", {
        sessionId: activeSessionId,
        reason: "usernameMatched",
        loginUsername,
        promptUsername,
      });
    }
    const trackedPath = tracked.path;
    const meta = localSessionMeta[activeSessionId];
    const inferredLocalHome =
      meta?.shellKind === "wsl"
        ? inferWslHomePath(trackedPath, tracked.username)
        : null;
    const knownHome =
      terminalHomeDirs[activeSessionId] ??
      inferredLocalHome ??
      (trackedPath === "~" && !!currentPath ? currentPath : null);
    if (knownHome && terminalHomeDirs[activeSessionId] !== knownHome) {
      scheduleDeferredTask(() => {
        setTerminalHomeDirs((prev) => ({
          ...prev,
          [activeSessionId]: knownHome,
        }));
      });
    }
    const resolvedPath = resolveTrackedWorkingDirectory(
      trackedPath,
      knownHome,
      local,
    );
    const effectiveResolvedPath = local
      ? resolveLocalSessionWorkingDirectory(
          trackedPath,
          knownHome,
          meta,
          tracked.username,
        )
      : resolvedPath;
    if (!effectiveResolvedPath) return;
    if (effectiveResolvedPath === currentPath) {
      scheduleDeferredTask(() => {
        setLastSyncedTerminalPaths((prev) =>
          prev[activeSessionId] === effectiveResolvedPath
            ? prev
            : { ...prev, [activeSessionId]: effectiveResolvedPath },
        );
      });
      return;
    }
    if (lastSyncedTerminalPaths[activeSessionId] === effectiveResolvedPath) {
      return;
    }
    openRemoteDir(effectiveResolvedPath).catch((error) => {
      logWarn("sftp.terminal.directory.sync.failed", {
        sessionId: activeSessionId,
        error: {
          code: "sftp_terminal_directory_sync_failed",
          message: "SFTP directory could not follow the terminal",
          detail: extractErrorMessage(error),
        },
      });
    });
    scheduleDeferredTask(() => {
      setLastSyncedTerminalPaths((prev) => ({
        ...prev,
        [activeSessionId]: effectiveResolvedPath,
      }));
    });
  }, [
    activeSessionId,
    activeSessionProfile,
    activeSftpAvailability,
    currentPath,
    enabled,
    filesWidgetVisible,
    isLocalSession,
    isRemoteConnected,
    lastSyncedTerminalPaths,
    localSessionMeta,
    openRemoteDir,
    sftpEnabled,
    terminalCwdSupportBySession,
    terminalHomeDirs,
    terminalPathSyncStateBySession,
    terminalWorkingDirs,
  ]);

  return {
    activeTerminalPathSyncStatus,
    handleWorkingDirectoryChange: (sessionId, payload) => {
      setTerminalWorkingDirs((prev) =>
        prev[sessionId]?.path === payload.path &&
        prev[sessionId]?.username === payload.username &&
        prev[sessionId]?.source === payload.source
          ? prev
          : { ...prev, [sessionId]: payload },
      );
    },
    handlePathSyncSupportChange: (sessionId, status) => {
      setTerminalCwdSupportBySession((prev) => {
        if (prev[sessionId] === status) return prev;
        return { ...prev, [sessionId]: status };
      });
    },
  };
}
