/**
 * 会话命令编排模块。
 * 职责：封装连接、断开、重连等会话命令流程，降低 Hook 主体复杂度。
 */
import type { Translate } from "@/i18n";
import type {
  DisconnectReason,
  HostProfile,
  LocalShellConfig,
  LocalSessionMeta,
  LocalShellProfile,
  Session,
  SessionStateUi,
} from "@/types";
import {
  extractErrorMessage,
  translateAppError,
} from "@/shared/errors/appError";
import { warn as logWarn } from "@/shared/logging/telemetry";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type ConnectProfileCommandParams = {
  profile: HostProfile;
  createSshSession: (profile: HostProfile) => Promise<Session>;
  sessionStatesRef: React.RefObject<Record<string, SessionStateUi>>;
  setSessions: Setter<Session[]>;
  attachSessionToWorkspace: (sessionId: string) => void;
  setSessionStates: Setter<Record<string, SessionStateUi>>;
  setSessionReasons: Setter<Record<string, DisconnectReason>>;
  t: Translate;
  logInfo: (message: string) => void;
  logError: (message: string) => void;
  onSessionCreated?: (session: Session) => void;
  shouldSuppressError?: () => boolean;
  openDialog: (payload: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  }) => void;
};

/** 建立远端会话并写入前端状态。 */
export async function connectProfileCommand({
  profile,
  createSshSession,
  sessionStatesRef,
  setSessions,
  attachSessionToWorkspace,
  setSessionStates,
  setSessionReasons,
  t,
  logInfo,
  logError,
  onSessionCreated,
  shouldSuppressError,
  openDialog,
}: ConnectProfileCommandParams) {
  logInfo(
    JSON.stringify({
      event: "ssh.connect.start",
      profileId: profile.id,
      host: profile.host,
      authType: profile.authType,
    }),
  );
  try {
    const result = await createSshSession(profile);
    const existingState = sessionStatesRef.current[result.sessionId];
    logInfo(
      JSON.stringify({
        event: "ssh.connect.session.created",
        profileId: profile.id,
        sessionId: result.sessionId,
      }),
    );
    onSessionCreated?.(result);
    setSessions((prev) => prev.concat(result));
    attachSessionToWorkspace(result.sessionId);
    if (existingState !== "error" && existingState !== "disconnected") {
      setSessionStates((prev) => ({
        ...prev,
        [result.sessionId]: "connecting",
      }));
    }
    setSessionReasons((prev) => {
      const next = { ...prev };
      delete next[result.sessionId];
      return next;
    });
  } catch (err: unknown) {
    if (shouldSuppressError?.()) {
      return;
    }
    const code =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : "";
    const errorMessage = translateAppError(err, t);
    if (code === "ssh_host_key_unknown" || code === "ssh_host_key_mismatch") {
      void logWarn(
        JSON.stringify({
          event: "ssh.connect.hostkey.pending",
          profileId: profile.id,
          host: profile.host,
          error: extractErrorMessage(err),
        }),
      );
      throw err;
    }
    if (code === "security_locked") {
      // 锁定是用户主动触发的受控状态，不属于系统异常，按 warning 记录即可。
      void logWarn(
        JSON.stringify({
          event: "ssh.connect.security.locked",
          profileId: profile.id,
          host: profile.host,
          error: errorMessage,
        }),
      );
    } else {
      logError(
        JSON.stringify({
          event: "ssh.connect.failed",
          profileId: profile.id,
          host: profile.host,
          error: errorMessage,
        }),
      );
    }
    openDialog({
      title: t("dialog.sshErrorTitle"),
      message: errorMessage || t("dialog.sshErrorBody"),
      confirmLabel: t("actions.close"),
    });
    throw err;
  }
}

type ConnectLocalShellCommandParams = {
  shellProfile: LocalShellProfile | null;
  activate?: boolean;
  launchConfig?: LocalShellConfig;
  createLocalShellSession: (
    shellOverride?: string | null,
    launchConfig?: LocalShellConfig,
  ) => Promise<Session>;
  localSessionIdsRef: React.RefObject<Set<string>>;
  setLocalSessionMeta: Setter<Record<string, LocalSessionMeta>>;
  setSessions: Setter<Session[]>;
  attachSessionToWorkspace: (sessionId: string, activate?: boolean) => void;
  setSessionStates: Setter<Record<string, SessionStateUi>>;
  setSessionReasons: Setter<Record<string, DisconnectReason>>;
  t: Translate;
};

/** 建立本地 shell 会话并写入前端状态。 */
export async function connectLocalShellCommand({
  shellProfile,
  activate = false,
  launchConfig,
  createLocalShellSession,
  localSessionIdsRef,
  setLocalSessionMeta,
  setSessions,
  attachSessionToWorkspace,
  setSessionStates,
  setSessionReasons,
  t,
}: ConnectLocalShellCommandParams) {
  const session = await createLocalShellSession(
    shellProfile?.id ?? null,
    launchConfig,
  );
  localSessionIdsRef.current.add(session.sessionId);
  setLocalSessionMeta((prev) => ({
    ...prev,
    [session.sessionId]: {
      shellId: shellProfile?.id ?? null,
      label: shellProfile?.label ?? t("session.local"),
      shellKind: shellProfile?.kind ?? "native",
      wslDistribution: shellProfile?.wslDistribution ?? null,
      launchConfig,
    },
  }));
  setSessions((prev) => prev.concat(session));
  attachSessionToWorkspace(session.sessionId, activate);
  setSessionStates((prev) => ({ ...prev, [session.sessionId]: "connected" }));
  setSessionReasons((prev) => {
    const next = { ...prev };
    delete next[session.sessionId];
    return next;
  });
}

type DisconnectSessionCommandParams = {
  sessionId: string;
  state: SessionStateUi | undefined;
  localSession: boolean;
  sendDisconnect: (sessionId: string, localSession: boolean) => Promise<void>;
  detachSessionFromWorkspace: (sessionId: string) => void;
  localSessionIdsRef: React.RefObject<Set<string>>;
  setLocalSessionMeta: Setter<Record<string, LocalSessionMeta>>;
  setSessions: Setter<Session[]>;
  setSessionStates: Setter<Record<string, SessionStateUi>>;
  setSessionReasons: Setter<Record<string, DisconnectReason>>;
  setReconnectInfoBySession: Setter<
    Record<string, { attempt: number; delayMs: number }>
  >;
};

/** 关闭会话并清理关联状态。 */
export async function disconnectSessionCommand({
  sessionId,
  state,
  localSession,
  sendDisconnect,
  detachSessionFromWorkspace,
  localSessionIdsRef,
  setLocalSessionMeta,
  setSessions,
  setSessionStates,
  setSessionReasons,
  setReconnectInfoBySession,
}: DisconnectSessionCommandParams) {
  if (
    state === "connected" ||
    state === "connecting" ||
    state === "reconnecting"
  ) {
    try {
      await sendDisconnect(sessionId, localSession);
    } catch {
      // Ignore if the backend session is already closed.
    }
  }

  if (localSession) {
    localSessionIdsRef.current.delete(sessionId);
    setLocalSessionMeta((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }

  setSessions((prev) => {
    return prev.filter((item) => item.sessionId !== sessionId);
  });
  detachSessionFromWorkspace(sessionId);
  setSessionStates((prev) => {
    const next = { ...prev };
    delete next[sessionId];
    return next;
  });
  setSessionReasons((prev) => {
    const next = { ...prev };
    delete next[sessionId];
    return next;
  });
  setReconnectInfoBySession((prev) => {
    const next = { ...prev };
    delete next[sessionId];
    return next;
  });
}

type ReconnectLocalShellCommandParams = {
  sessionId: string;
  createLocalShellSession: (
    shellOverride?: string | null,
    launchConfig?: LocalShellConfig,
  ) => Promise<Session>;
  localSessionMetaRef: React.RefObject<Record<string, LocalSessionMeta>>;
  setSessionStates: Setter<Record<string, SessionStateUi>>;
  replaceSessionConnection: (
    oldSessionId: string,
    nextSession: Session,
    nextState?: SessionStateUi,
    nextLocalMeta?: LocalSessionMeta,
  ) => void;
  t: Translate;
};

/** 重连本地 shell 会话。 */
export async function reconnectLocalShellCommand({
  sessionId,
  createLocalShellSession,
  localSessionMetaRef,
  setSessionStates,
  replaceSessionConnection,
  t,
}: ReconnectLocalShellCommandParams) {
  setSessionStates((prev) => ({
    ...prev,
    [sessionId]: "reconnecting",
  }));
  try {
    const meta = localSessionMetaRef.current[sessionId];
    const result = await createLocalShellSession(
      meta?.shellId ?? null,
      meta?.launchConfig,
    );
    replaceSessionConnection(sessionId, result, "connected", {
      shellId: meta?.shellId ?? null,
      label: meta?.label ?? t("session.local"),
      shellKind: meta?.shellKind ?? "native",
      wslDistribution: meta?.wslDistribution ?? null,
      launchConfig: meta?.launchConfig,
    });
  } catch {
    setSessionStates((prev) => ({
      ...prev,
      [sessionId]: "disconnected",
    }));
  }
}
