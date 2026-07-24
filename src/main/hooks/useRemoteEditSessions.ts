/**
 * 远程文件编辑会话管理。
 * 职责：维护远程编辑快照、监听本地文件变更，并处理上传确认流程。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import type { DialogPayload, ToastPayload } from "@/hooks/useNotices";
import {
  confirmRemoteEditUpload,
  dismissRemoteEditPending,
  listRemoteEditSessions,
  openLocalFile,
  openRemoteFileForEditing,
} from "@/features/file-open/core/commands";
import { registerRemoteEditListener } from "@/features/file-open/core/listeners";
import { translateAppError } from "@/shared/errors/appError";
import type {
  HostProfile,
  RemoteEditSnapshot,
  Session,
  SessionStateUi,
  SftpEntry,
} from "@/types";
import type { Translate } from "@/i18n";

type UseRemoteEditSessionsOptions = {
  sessions: Session[];
  profiles: HostProfile[];
  sessionStates: Record<string, SessionStateUi>;
  fileDefaultEditorPath: string;
  t: Translate;
  pushToast: (payload: ToastPayload) => void;
  openDialog: (payload: DialogPayload) => void;
};

type UseRemoteEditSessionsState = {
  remoteEditSessions: Record<string, RemoteEditSnapshot>;
  openManagedRemoteFile: (sessionId: string, entry: SftpEntry) => Promise<void>;
  openManagedLocalFile: (entry: SftpEntry) => Promise<void>;
};

/** 管理远程编辑实例和上传确认交互。 */
export default function useRemoteEditSessions({
  sessions,
  profiles,
  sessionStates,
  fileDefaultEditorPath,
  t,
  pushToast,
  openDialog,
}: UseRemoteEditSessionsOptions): UseRemoteEditSessionsState {
  const [remoteEditSessions, setRemoteEditSessions] = useState<
    Record<string, RemoteEditSnapshot>
  >({});
  const [remoteEditAutoUploadBySession, setRemoteEditAutoUploadBySession] =
    useState<Record<string, boolean>>({});
  const remoteEditSessionsRef = useRef<Record<string, RemoteEditSnapshot>>({});

  useEffect(() => {
    remoteEditSessionsRef.current = remoteEditSessions;
  }, [remoteEditSessions]);

  useEffect(() => {
    const cancel = scheduleDeferredTask(() => {
      setRemoteEditSessions((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, item]) => {
            return sessionStates[item.sessionId] === "connected";
          }),
        ),
      );
      setRemoteEditAutoUploadBySession((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([sessionId]) => sessionStates[sessionId] === "connected",
          ),
        ),
      );
    });
    return cancel;
  }, [sessionStates]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listRemoteEditSessions()
      .then((items) => {
        if (disposed) return;
        setRemoteEditSessions(() =>
          Object.fromEntries(items.map((item) => [item.instanceId, item])),
        );
      })
      .catch(() => {});

    void registerRemoteEditListener((payload) => {
      const previous =
        remoteEditSessionsRef.current[payload.instanceId] ?? null;
      if (previous?.status === "uploading" && payload.status === "synced") {
        pushToast({
          level: "success",
          message: t("sftp.remoteEdit.uploadSuccess", {
            name: payload.fileName,
          }),
        });
      }
      if (
        payload.status === "sync_failed" &&
        payload.lastError &&
        previous?.lastError !== payload.lastError
      ) {
        const translatedMessage = payload.lastErrorCode
          ? translateAppError(
              {
                code: payload.lastErrorCode,
                message: payload.lastError,
              },
              t,
            )
          : payload.lastError;
        pushToast({
          level: "error",
          message: translatedMessage,
        });
      }
      setRemoteEditSessions((current) => ({
        ...current,
        [payload.instanceId]: payload,
      }));
      if (payload.status !== "pending_confirm") {
        return;
      }
      if (sessionStates[payload.sessionId] !== "connected") {
        return;
      }
      if (remoteEditAutoUploadBySession[payload.sessionId]) {
        void confirmRemoteEditUpload(payload.instanceId).catch((error) => {
          pushToast({
            level: "error",
            message: translateAppError(error, t),
          });
        });
        return;
      }
      const session = sessions.find(
        (sessionItem) => sessionItem.sessionId === payload.sessionId,
      );
      const profile = session?.profileId
        ? (profiles.find((item) => item.id === session.profileId) ?? null)
        : null;
      const serverLabel =
        profile?.name && profile.host
          ? `${profile.name} (${profile.host})`
          : profile?.host || profile?.name || payload.sessionId;
      openDialog({
        title: t("sftp.remoteEdit.confirmTitle"),
        message: t("sftp.remoteEdit.confirmMessage", {
          name: payload.fileName,
          server: serverLabel,
          path: payload.remotePath,
        }),
        confirmLabel: t("actions.upload"),
        secondaryLabel: t("sftp.remoteEdit.confirmAllInSession"),
        cancelLabel: t("actions.cancel"),
        onConfirm: () => {
          void confirmRemoteEditUpload(payload.instanceId).catch((error) => {
            pushToast({
              level: "error",
              message: translateAppError(error, t),
            });
          });
        },
        onSecondary: () => {
          setRemoteEditAutoUploadBySession((current) => ({
            ...current,
            [payload.sessionId]: true,
          }));
          void confirmRemoteEditUpload(payload.instanceId).catch((error) => {
            pushToast({
              level: "error",
              message: translateAppError(error, t),
            });
          });
        },
        onCancel: () => {
          void dismissRemoteEditPending(payload.instanceId).catch(() => {});
        },
      });
    }).then((listener) => {
      if (disposed) {
        void listener();
        return;
      }
      unlisten = listener;
    });

    return () => {
      disposed = true;
      if (unlisten) {
        void unlisten();
      }
    };
  }, [
    openDialog,
    profiles,
    pushToast,
    remoteEditAutoUploadBySession,
    sessionStates,
    sessions,
    t,
  ]);

  const openManagedRemoteFile = useCallback(
    async (sessionId: string, entry: SftpEntry) => {
      const session = sessions.find(
        (sessionItem) => sessionItem.sessionId === sessionId,
      );
      const profile = session?.profileId
        ? (profiles.find((item) => item.id === session.profileId) ?? null)
        : null;
      const opened = await openRemoteFileForEditing(
        sessionId,
        {
          host: profile?.host?.trim() || "unknown-host",
          username: profile?.username?.trim() || "unknown-user",
          port:
            typeof profile?.port === "number" && profile.port > 0
              ? profile.port
              : 22,
        },
        entry,
        fileDefaultEditorPath,
      );
      pushToast({
        level: "success",
        message: opened.trackChanges
          ? t("sftp.remoteEdit.openedTracked", { name: entry.name })
          : t("sftp.remoteEdit.openedExternal", { name: entry.name }),
      });
      if (opened.trackChanges) {
        setRemoteEditSessions((current) => ({
          ...current,
          [opened.instanceId]: opened,
        }));
      }
    },
    [fileDefaultEditorPath, profiles, pushToast, sessions, t],
  );

  const openManagedLocalFile = useCallback(
    async (entry: SftpEntry) => {
      await openLocalFile(entry.path, fileDefaultEditorPath);
    },
    [fileDefaultEditorPath],
  );

  return {
    remoteEditSessions,
    openManagedRemoteFile,
    openManagedLocalFile,
  };
}
