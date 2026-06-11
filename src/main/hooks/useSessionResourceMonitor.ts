/**
 * 会话资源监控管理。
 * 职责：订阅资源快照事件，并根据当前会话与配置启动或停止资源监控。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import { MIN_RESOURCE_MONITOR_INTERVAL_SEC } from "@/hooks/useSessionSettings";
import {
  startLocalResourceMonitor,
  startSshResourceMonitor,
  stopResourceMonitor,
} from "@/features/resource/core/commands";
import { subscribeTauri } from "@/shared/tauri/events";
import type {
  HostProfile,
  SessionResourceSnapshot,
  SessionStateUi,
} from "@/types";

type ResourceMonitorStatus = "disabled" | "checking" | "ready" | "unsupported";

type UseSessionResourceMonitorOptions = {
  enabled: boolean;
  intervalSec: number;
  activeSessionId: string | null;
  activeSessionState: SessionStateUi | null;
  activeSessionProfile: HostProfile | null;
  isLocalSession: (sessionId: string) => boolean;
};

type UseSessionResourceMonitorState = {
  activeResourceSnapshot: SessionResourceSnapshot | null;
  activeResourceMonitorStatus: ResourceMonitorStatus;
};

/** 管理当前活动会话的资源监控生命周期。 */
export default function useSessionResourceMonitor({
  enabled,
  intervalSec,
  activeSessionId,
  activeSessionState,
  activeSessionProfile,
  isLocalSession,
}: UseSessionResourceMonitorOptions): UseSessionResourceMonitorState {
  const activeResourceMonitorSessionIdRef = useRef<string | null>(null);
  const activeResourceMonitorKeyRef = useRef("");
  const previousResourceSessionStateRef = useRef<SessionStateUi | null>(null);
  const [resourceSnapshotsBySession, setResourceSnapshotsBySession] = useState<
    Record<string, SessionResourceSnapshot>
  >({});

  const activeResourceSnapshot = useMemo(() => {
    if (!activeSessionId) return null;
    if (activeSessionState !== "connected") return null;
    return resourceSnapshotsBySession[activeSessionId] ?? null;
  }, [activeSessionId, activeSessionState, resourceSnapshotsBySession]);

  const activeResourceMonitorStatus = useMemo<ResourceMonitorStatus>(() => {
    if (!enabled) return "disabled";
    if (!activeSessionId) return "disabled";
    if (activeSessionState !== "connected") return "disabled";
    const snapshot = resourceSnapshotsBySession[activeSessionId];
    if (!snapshot) return "checking";
    if (snapshot.status === "ready" && snapshot.cpu && snapshot.memory) {
      return "ready";
    }
    return snapshot.status;
  }, [
    activeSessionId,
    activeSessionState,
    enabled,
    resourceSnapshotsBySession,
  ]);

  useEffect(() => {
    const previousState = previousResourceSessionStateRef.current;
    previousResourceSessionStateRef.current = activeSessionState;
    if (!activeSessionId) return;
    if (activeSessionState !== "connected" || previousState === "connected") {
      return;
    }
    const cancel = scheduleDeferredTask(() => {
      setResourceSnapshotsBySession((prev) => {
        if (prev[activeSessionId]?.status !== "unsupported") {
          return prev;
        }
        const next = { ...prev };
        delete next[activeSessionId];
        return next;
      });
    });
    return cancel;
  }, [activeSessionId, activeSessionState]);

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | null = null;

    const registerResourceListener = async () => {
      const unlisten = await subscribeTauri<SessionResourceSnapshot>(
        "session:resource",
        (event) => {
          if (cancelled) return;
          setResourceSnapshotsBySession((prev) => ({
            ...prev,
            [event.payload.sessionId]: event.payload,
          }));
        },
      );
      if (cancelled) {
        unlisten();
        return;
      }
      teardown = unlisten;
    };

    registerResourceListener().catch(() => {});
    return () => {
      cancelled = true;
      teardown?.();
    };
  }, []);

  useEffect(() => {
    const normalizedInterval = Math.max(
      MIN_RESOURCE_MONITOR_INTERVAL_SEC,
      intervalSec,
    );
    const isLocalActiveSession =
      !!activeSessionId && isLocalSession(activeSessionId);
    const desiredMonitorKey =
      enabled &&
      activeSessionId &&
      activeSessionState === "connected" &&
      (isLocalActiveSession || activeSessionProfile)
        ? [
            activeSessionId,
            isLocalActiveSession ? "local" : "ssh",
            activeSessionProfile?.id ?? "local",
            normalizedInterval,
          ].join(":")
        : "";

    const stopMonitorById = async (sessionId: string | null) => {
      if (!sessionId) return;
      await stopResourceMonitor(sessionId).catch(() => {});
    };

    const syncMonitor = async () => {
      if (activeResourceMonitorKeyRef.current === desiredMonitorKey) {
        return;
      }
      activeResourceMonitorKeyRef.current = desiredMonitorKey;

      const previousSessionId = activeResourceMonitorSessionIdRef.current;
      if (!desiredMonitorKey || !activeSessionId) {
        await stopMonitorById(previousSessionId);
        activeResourceMonitorSessionIdRef.current = null;
        return;
      }

      if (
        resourceSnapshotsBySession[activeSessionId]?.status === "unsupported"
      ) {
        await stopMonitorById(previousSessionId);
        activeResourceMonitorSessionIdRef.current = null;
        activeResourceMonitorKeyRef.current = `unsupported:${activeSessionId}`;
        return;
      }

      if (previousSessionId && previousSessionId !== activeSessionId) {
        await stopMonitorById(previousSessionId);
      }

      setResourceSnapshotsBySession((prev) => {
        const existing = prev[activeSessionId];
        if (existing?.status === "checking" || existing?.status === "ready") {
          return prev;
        }
        return {
          ...prev,
          [activeSessionId]: {
            sessionId: activeSessionId,
            sampledAt: Date.now(),
            source: isLocalActiveSession ? "local" : "ssh-linux",
            status: "checking",
            uptimeSeconds: null,
            cpu: null,
            memory: null,
          },
        };
      });

      if (isLocalActiveSession) {
        await startLocalResourceMonitor(activeSessionId, normalizedInterval);
      } else if (activeSessionProfile) {
        await startSshResourceMonitor(
          activeSessionId,
          activeSessionProfile,
          normalizedInterval,
        );
      }

      activeResourceMonitorSessionIdRef.current = activeSessionId;
    };

    syncMonitor().catch(() => {});
  }, [
    activeSessionId,
    activeSessionProfile,
    activeSessionState,
    enabled,
    intervalSec,
    isLocalSession,
    resourceSnapshotsBySession,
  ]);

  useEffect(() => {
    return () => {
      const sessionId = activeResourceMonitorSessionIdRef.current;
      if (!sessionId) return;
      stopResourceMonitor(sessionId).catch(() => {});
    };
  }, []);

  return {
    activeResourceSnapshot,
    activeResourceMonitorStatus,
  };
}
