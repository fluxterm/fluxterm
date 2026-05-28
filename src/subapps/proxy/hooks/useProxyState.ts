import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProxyRuntime, ProxySpec } from "@/types";
import {
  closeAllProxies,
  closeProxy,
  listProxies,
  openProxy,
} from "@/features/proxy/core/commands";
import { registerProxyListeners } from "@/features/proxy/core/listeners";
import { createTraceId, logTelemetry } from "@/shared/logging/telemetry";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";

type ProxyTimelineEvent = {
  id: string;
  at: number;
  level: "info" | "warn" | "error";
  event: string;
  proxyId?: string;
  message: string;
  code?: string;
};

type ProxyErrorBucket = {
  code: string;
  count: number;
  lastAt: number;
  lastMessage: string;
};

/** 代理子应用状态管理。 */
export default function useProxyState() {
  const [proxies, setProxies] = useState<ProxyRuntime[]>([]);
  const [loading, setLoading] = useState(false);
  const [timeline, setTimeline] = useState<ProxyTimelineEvent[]>([]);

  const pushTimeline = useCallback(
    (event: Omit<ProxyTimelineEvent, "id" | "at">) => {
      setTimeline((prev) => {
        const next: ProxyTimelineEvent[] = [
          {
            ...event,
            id: crypto.randomUUID(),
            at: Date.now(),
          },
          ...prev,
        ];
        return next.slice(0, 120);
      });
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listProxies();
      setProxies(list);
      pushTimeline({
        level: "info",
        event: "proxy.list.success",
        message: `list=${list.length}`,
      });
      logTelemetry("debug", "proxy.list.success", {
        count: list.length,
      }).catch(() => {});
    } catch (error) {
      pushTimeline({
        level: "warn",
        event: "proxy.list.failed",
        message: error instanceof Error ? error.message : String(error),
        code: "proxy_list_failed",
      });
      logTelemetry("warn", "proxy.list.failed", {
        error: {
          code: "proxy_list_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {});
      throw error;
    } finally {
      setLoading(false);
    }
  }, [pushTimeline]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void registerProxyListeners((payload) => {
      logTelemetry("debug", "proxy.runtime.update", {
        proxyId: payload.proxyId,
        protocol: payload.protocol,
        status: payload.status,
        bindHost: payload.bindHost,
        bindPort: payload.bindPort,
        activeConnections: payload.activeConnections,
        bytesIn: payload.bytesIn,
        bytesOut: payload.bytesOut,
      }).catch(() => {});
      if (payload.lastError?.message) {
        pushTimeline({
          level: "warn",
          event: "proxy.runtime.error",
          proxyId: payload.proxyId,
          message: payload.lastError.message,
          code: payload.lastError.code,
        });
      }
      if (disposed) return;
      setProxies((prev) => {
        const next = prev.filter((item) => item.proxyId !== payload.proxyId);
        if (payload.status !== "stopped") {
          next.push(payload);
        }
        return next.sort((a, b) => a.proxyId.localeCompare(b.proxyId));
      });
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [pushTimeline]);

  useEffect(() => {
    const cancel = scheduleDeferredTask(() => {
      void refresh().catch(() => {});
    });
    return cancel;
  }, [refresh]);

  const totals = useMemo(() => {
    return proxies.reduce(
      (acc, item) => {
        acc.activeConnections += item.activeConnections;
        acc.bytesIn += item.bytesIn;
        acc.bytesOut += item.bytesOut;
        return acc;
      },
      { activeConnections: 0, bytesIn: 0, bytesOut: 0 },
    );
  }, [proxies]);

  const create = useCallback(
    async (spec: ProxySpec) => {
      const traceId = createTraceId();
      logTelemetry("debug", "proxy.create.start", {
        traceId,
        protocol: spec.protocol,
        bindHost: spec.bindHost,
        bindPort: spec.bindPort,
        authEnabled: Boolean(spec.auth),
      }).catch(() => {});
      try {
        await openProxy(spec, traceId);
        pushTimeline({
          level: "info",
          event: "proxy.create.success",
          message: `${spec.protocol} ${spec.bindHost}:${spec.bindPort}`,
        });
        logTelemetry("debug", "proxy.create.success", {
          traceId,
          protocol: spec.protocol,
          bindHost: spec.bindHost,
          bindPort: spec.bindPort,
        }).catch(() => {});
      } catch (error) {
        pushTimeline({
          level: "warn",
          event: "proxy.create.failed",
          message: error instanceof Error ? error.message : String(error),
          code: "proxy_create_failed",
        });
        logTelemetry("warn", "proxy.create.failed", {
          traceId,
          protocol: spec.protocol,
          bindHost: spec.bindHost,
          bindPort: spec.bindPort,
          error: {
            code: "proxy_create_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }).catch(() => {});
        throw error;
      }
    },
    [pushTimeline],
  );

  const close = useCallback(
    async (proxyId: string) => {
      const traceId = createTraceId();
      logTelemetry("debug", "proxy.close.start", {
        traceId,
        proxyId,
      }).catch(() => {});
      try {
        await closeProxy(proxyId, traceId);
        pushTimeline({
          level: "info",
          event: "proxy.close.success",
          proxyId,
          message: proxyId,
        });
        logTelemetry("debug", "proxy.close.success", {
          traceId,
          proxyId,
        }).catch(() => {});
      } catch (error) {
        pushTimeline({
          level: "warn",
          event: "proxy.close.failed",
          proxyId,
          message: error instanceof Error ? error.message : String(error),
          code: "proxy_close_failed",
        });
        logTelemetry("warn", "proxy.close.failed", {
          traceId,
          proxyId,
          error: {
            code: "proxy_close_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }).catch(() => {});
        throw error;
      }
    },
    [pushTimeline],
  );

  const closeAll = useCallback(async () => {
    const traceId = createTraceId();
    logTelemetry("debug", "proxy.close.all.start", {
      traceId,
    }).catch(() => {});
    try {
      await closeAllProxies(traceId);
      pushTimeline({
        level: "info",
        event: "proxy.close.all.success",
        message: "close all",
      });
      logTelemetry("debug", "proxy.close.all.success", {
        traceId,
      }).catch(() => {});
    } catch (error) {
      pushTimeline({
        level: "warn",
        event: "proxy.close.all.failed",
        message: error instanceof Error ? error.message : String(error),
        code: "proxy_close_all_failed",
      });
      logTelemetry("warn", "proxy.close.all.failed", {
        traceId,
        error: {
          code: "proxy_close_all_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {});
      throw error;
    }
  }, [pushTimeline]);

  const errorBuckets = useMemo<ProxyErrorBucket[]>(() => {
    const map = new Map<string, ProxyErrorBucket>();
    timeline.forEach((item) => {
      if (!item.code) return;
      const key = item.code;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, {
          code: key,
          count: 1,
          lastAt: item.at,
          lastMessage: item.message,
        });
        return;
      }
      prev.count += 1;
      if (item.at > prev.lastAt) {
        prev.lastAt = item.at;
        prev.lastMessage = item.message;
      }
    });
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [timeline]);

  return {
    proxies,
    loading,
    totals,
    timeline,
    errorBuckets,
    refresh,
    create,
    close,
    closeAll,
  };
}
