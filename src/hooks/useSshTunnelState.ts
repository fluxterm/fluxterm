import { useCallback, useEffect, useMemo, useState } from "react";
import { info as logInfo, warn as logWarn } from "@/shared/logging/telemetry";
import {
  closeAllSshTunnels,
  closeSshTunnel,
  listSshTunnels,
  openSshTunnel,
} from "@/features/tunnel/core/commands";
import { registerTunnelListeners } from "@/features/tunnel/core/listeners";
import type { SshTunnelRuntime, SshTunnelSpec } from "@/types";

/** SSH 隧道状态管理。 */
export default function useSshTunnelState(activeSessionId: string | null) {
  const [tunnelsBySession, setTunnelsBySession] = useState<
    Record<string, SshTunnelRuntime[]>
  >({});

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void registerTunnelListeners((payload) => {
      if (disposed) return;
      logInfo(
        JSON.stringify({
          event: "ssh.tunnel.update",
          sessionId: payload.sessionId,
          tunnelId: payload.tunnelId,
          kind: payload.kind,
          status: payload.status,
          bindHost: payload.bindHost,
          bindPort: payload.bindPort,
        }),
      ).catch(() => {});
      setTunnelsBySession((prev) => {
        const list = prev[payload.sessionId] ?? [];
        const next = list.filter((item) => item.tunnelId !== payload.tunnelId);
        if (payload.status !== "stopped") {
          next.push(payload);
        }
        const index = next.findIndex(
          (item) => item.tunnelId === payload.tunnelId,
        );
        if (payload.status !== "stopped" && index >= 0) {
          next[index] = payload;
        }
        return { ...prev, [payload.sessionId]: next };
      });
    }).then((callback) => {
      if (disposed) {
        callback();
        return;
      }
      unlisten = callback;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!activeSessionId) return;
    const list = await listSshTunnels(activeSessionId);
    setTunnelsBySession((prev) => ({ ...prev, [activeSessionId]: list }));
  }, [activeSessionId]);

  const open = useCallback(
    async (spec: SshTunnelSpec) => {
      if (!activeSessionId) return null;
      logInfo(
        JSON.stringify({
          event: "ssh.tunnel.open.start",
          sessionId: activeSessionId,
          kind: spec.kind,
          bindHost: spec.bindHost,
          bindPort: spec.bindPort,
          targetHost: spec.targetHost ?? null,
          targetPort: spec.targetPort ?? null,
        }),
      ).catch(() => {});
      try {
        const runtime = await openSshTunnel(activeSessionId, spec);
        logInfo(
          JSON.stringify({
            event: "ssh.tunnel.open.success",
            sessionId: activeSessionId,
            tunnelId: runtime.tunnelId,
            bindPort: runtime.bindPort,
          }),
        ).catch(() => {});
        await refresh();
        return runtime;
      } catch (error) {
        logWarn(
          JSON.stringify({
            event: "ssh.tunnel.open.failed",
            sessionId: activeSessionId,
            message: error instanceof Error ? error.message : String(error),
          }),
        ).catch(() => {});
        await refresh().catch(() => {});
        throw error;
      }
    },
    [activeSessionId, refresh],
  );

  const close = useCallback(
    async (tunnelId: string) => {
      if (!activeSessionId) return;
      logInfo(
        JSON.stringify({
          event: "ssh.tunnel.close.start",
          sessionId: activeSessionId,
          tunnelId,
        }),
      ).catch(() => {});
      try {
        await closeSshTunnel(activeSessionId, tunnelId);
        setTunnelsBySession((prev) => ({
          ...prev,
          [activeSessionId]: (prev[activeSessionId] ?? []).filter(
            (item) => item.tunnelId !== tunnelId,
          ),
        }));
        await refresh();
      } catch (error) {
        logWarn(
          JSON.stringify({
            event: "ssh.tunnel.close.failed",
            sessionId: activeSessionId,
            tunnelId,
            message: error instanceof Error ? error.message : String(error),
          }),
        ).catch(() => {});
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "ssh_tunnel_not_found"
        ) {
          await refresh().catch(() => {});
        }
        throw error;
      }
    },
    [activeSessionId, refresh],
  );

  const closeAll = useCallback(async () => {
    if (!activeSessionId) return;
    logInfo(
      JSON.stringify({
        event: "ssh.tunnel.close.all.start",
        sessionId: activeSessionId,
      }),
    ).catch(() => {});
    try {
      await closeAllSshTunnels(activeSessionId);
      setTunnelsBySession((prev) => ({ ...prev, [activeSessionId]: [] }));
      await refresh();
    } catch (error) {
      logWarn(
        JSON.stringify({
          event: "ssh.tunnel.close.all.failed",
          sessionId: activeSessionId,
          message: error instanceof Error ? error.message : String(error),
        }),
      ).catch(() => {});
      throw error;
    }
  }, [activeSessionId, refresh]);

  useEffect(() => {
    if (!activeSessionId) return;
    queueMicrotask(() => {
      void refresh().catch(() => {});
    });
  }, [activeSessionId, refresh]);

  const activeTunnels = useMemo(
    () => (activeSessionId ? (tunnelsBySession[activeSessionId] ?? []) : []),
    [activeSessionId, tunnelsBySession],
  );

  return {
    activeTunnels,
    refresh,
    open,
    close,
    closeAll,
  };
}
