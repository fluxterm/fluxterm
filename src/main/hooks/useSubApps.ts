import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Locale } from "@/i18n";
import type { Translate } from "@/i18n";
import {
  SUBAPP_LIFECYCLE_CHANNEL,
  createSubAppWindowLabel,
  type SubAppLifecycleMessage,
} from "@/subapps/core/lifecycle";
import type { SubAppId, SubAppRuntimeStatus } from "@/subapps/types";
import type { ThemeId } from "@/types";
import type {
  BackgroundMediaType,
  BackgroundRenderMode,
  BackgroundVideoReplayMode,
} from "@/constants/backgroundMedia";
import {
  SUBAPP_WINDOW_HEIGHT,
  SUBAPP_WINDOW_MIN_HEIGHT,
  SUBAPP_WINDOW_MIN_WIDTH,
  SUBAPP_WINDOW_WIDTH,
} from "@/constants/windows";
import { isMacOS } from "@/utils/platform";

type SubAppDefinition = {
  id: SubAppId;
  menuLabel: string;
  windowTitle: string;
};

type SubAppRuntimeInfo = {
  id: SubAppId;
  label: string;
  status: SubAppRuntimeStatus;
};

type UseSubAppsOptions = {
  t: Translate;
  appearance: {
    locale: Locale;
    themeId: ThemeId;
    backgroundImageEnabled: boolean;
    backgroundImageAsset: string;
    backgroundImageSurfaceAlpha: number;
    backgroundMediaType: BackgroundMediaType;
    backgroundRenderMode: BackgroundRenderMode;
    backgroundVideoReplayMode: BackgroundVideoReplayMode;
    backgroundVideoReplayIntervalSec: number;
  };
};

type UseSubAppsState = {
  subApps: SubAppRuntimeInfo[];
  launchSubApp: (id: SubAppId) => Promise<void>;
  focusSubApp: (id: SubAppId) => Promise<void>;
  closeSubApp: (id: SubAppId) => Promise<void>;
  connectRdpProfile: (profileId: string) => Promise<void>;
  openAllDevtools: () => void;
  notifyMainShutdown: () => Promise<void>;
};

/** Main 侧 SubApp 生命周期与窗口管理。 */
export default function useSubApps({
  t,
  appearance,
}: UseSubAppsOptions): UseSubAppsState {
  const isMac = isMacOS();
  const defs = useMemo<SubAppDefinition[]>(
    () => [
      {
        id: "proxy",
        menuLabel: t("subapp.proxy.menuLabel"),
        windowTitle: t("subapp.proxy.title"),
      },
      {
        id: "rdp",
        menuLabel: t("subapp.rdp.menuLabel"),
        windowTitle: t("subapp.rdp.title"),
      },
    ],
    [t],
  );
  const windowRef = useRef<Partial<Record<SubAppId, WebviewWindow>>>({});
  const channelRef = useRef<BroadcastChannel | null>(null);
  const pendingRdpConnectQueueRef = useRef<string[]>([]);
  const pendingRdpConnectTimerRef = useRef<number | null>(null);
  const [statusById, setStatusById] = useState<
    Record<SubAppId, SubAppRuntimeStatus>
  >({
    proxy: "idle",
    rdp: "idle",
  });
  const statusByIdRef = useRef(statusById);

  useEffect(() => {
    statusByIdRef.current = statusById;
  }, [statusById]);

  useEffect(() => {
    return () => {
      if (pendingRdpConnectTimerRef.current !== null) {
        window.clearTimeout(pendingRdpConnectTimerRef.current);
        pendingRdpConnectTimerRef.current = null;
      }
    };
  }, []);

  const postLifecycleMessage = useCallback(
    (message: SubAppLifecycleMessage) => {
      channelRef.current?.postMessage(message);
    },
    [],
  );
  const syncAppearance = useCallback(
    (target?: { id: SubAppId; label: string }) => {
      postLifecycleMessage({
        type: "subapp:appearance-sync",
        source: "main",
        target,
        locale: appearance.locale,
        themeId: appearance.themeId,
        backgroundImageEnabled: appearance.backgroundImageEnabled,
        backgroundImageAsset: appearance.backgroundImageAsset,
        backgroundImageSurfaceAlpha: appearance.backgroundImageSurfaceAlpha,
        backgroundMediaType: appearance.backgroundMediaType,
        backgroundRenderMode: appearance.backgroundRenderMode,
        backgroundVideoReplayMode: appearance.backgroundVideoReplayMode,
        backgroundVideoReplayIntervalSec:
          appearance.backgroundVideoReplayIntervalSec,
      });
    },
    [appearance, postLifecycleMessage],
  );

  const setRuntimeStatus = useCallback(
    (id: SubAppId, status: SubAppRuntimeStatus) => {
      setStatusById((prev) => {
        if (prev[id] === status) return prev;
        // BroadcastChannel 的 ready 事件到达后，可能会立刻继续派发后续命令。
        // 这里同步维护 ref，避免首次打开子应用时因为 React 状态尚未提交而漏发待连接请求。
        const next = { ...prev, [id]: status };
        statusByIdRef.current = next;
        return next;
      });
    },
    [],
  );

  const clearWindowRuntime = useCallback(
    (id: SubAppId) => {
      delete windowRef.current[id];
      if (id === "rdp") {
        if (pendingRdpConnectTimerRef.current !== null) {
          window.clearTimeout(pendingRdpConnectTimerRef.current);
          pendingRdpConnectTimerRef.current = null;
        }
        pendingRdpConnectQueueRef.current = [];
      }
      setRuntimeStatus(id, "idle");
    },
    [setRuntimeStatus],
  );

  const flushPendingRdpCommands = useCallback(
    ({ deferForStartup = false }: { deferForStartup?: boolean } = {}) => {
      if (statusByIdRef.current.rdp !== "ready") return;
      const label = createSubAppWindowLabel("rdp");
      const dispatchPendingConnects = () => {
        if (statusByIdRef.current.rdp !== "ready") return;
        if (!pendingRdpConnectQueueRef.current.length) return;
        const queue = [...pendingRdpConnectQueueRef.current];
        pendingRdpConnectQueueRef.current = [];
        queue.forEach((profileId) => {
          postLifecycleMessage({
            type: "subapp:rdp-connect",
            source: "main",
            target: { id: "rdp", label },
            profileId,
          });
        });
      };
      if (!pendingRdpConnectQueueRef.current.length) return;
      if (pendingRdpConnectTimerRef.current !== null) {
        window.clearTimeout(pendingRdpConnectTimerRef.current);
        pendingRdpConnectTimerRef.current = null;
      }
      if (import.meta.env.DEV && deferForStartup) {
        // dev 模式下 React StrictMode / HMR 会让子应用首轮 effect 抖动，
        // 延后一次连接指令派发，等子窗口监听稳定后再发送。
        pendingRdpConnectTimerRef.current = window.setTimeout(() => {
          pendingRdpConnectTimerRef.current = null;
          dispatchPendingConnects();
        }, 300);
        return;
      }
      dispatchPendingConnects();
    },
    [postLifecycleMessage],
  );

  const closeSubApp = useCallback(
    async (id: SubAppId) => {
      const label = createSubAppWindowLabel(id);
      postLifecycleMessage({
        type: "subapp:close-request",
        id,
        label,
        source: "main",
        reason: "menu",
      });
      const current = windowRef.current[id];
      if (!current) return;
      await current.close().catch(() => {});
    },
    [postLifecycleMessage],
  );

  useEffect(() => {
    const current = getCurrentWindow();
    if (current.label !== "main") return () => {};
    if (typeof BroadcastChannel === "undefined") return () => {};
    const channel = new BroadcastChannel(SUBAPP_LIFECYCLE_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event) => {
      const payload = event.data as SubAppLifecycleMessage | undefined;
      if (!payload) return;
      if (payload.type === "subapp:ready") {
        setRuntimeStatus(payload.id, "ready");
        syncAppearance({ id: payload.id, label: payload.label });
        if (payload.id === "rdp") {
          flushPendingRdpCommands({ deferForStartup: true });
        }
        return;
      }
      if (
        payload.type === "subapp:close-request" &&
        payload.source === "subapp"
      ) {
        closeSubApp(payload.id).catch(() => {});
        return;
      }
      if (payload.type === "subapp:closed") {
        clearWindowRuntime(payload.id);
      }
    };
    return () => {
      channel.close();
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
    };
  }, [
    clearWindowRuntime,
    closeSubApp,
    flushPendingRdpCommands,
    setRuntimeStatus,
    syncAppearance,
  ]);

  useEffect(() => {
    syncAppearance();
  }, [syncAppearance]);

  const focusSubApp = useCallback(
    async (id: SubAppId) => {
      const current = windowRef.current[id];
      if (!current) return;
      await current.setFocus().catch(() => {});
      postLifecycleMessage({
        type: "subapp:focused",
        id,
        label: createSubAppWindowLabel(id),
        source: "main",
      });
    },
    [postLifecycleMessage],
  );

  const launchSubApp = useCallback(
    async (id: SubAppId) => {
      const existing = windowRef.current[id];
      if (existing) {
        await focusSubApp(id);
        return;
      }
      const def = defs.find((item) => item.id === id);
      if (!def) return;
      const label = createSubAppWindowLabel(id);
      setRuntimeStatus(id, "launching");
      try {
        const win = new WebviewWindow(label, {
          url: `/#subapp=${id}`,
          title: def.windowTitle,
          width: SUBAPP_WINDOW_WIDTH,
          height: SUBAPP_WINDOW_HEIGHT,
          minWidth: SUBAPP_WINDOW_MIN_WIDTH,
          minHeight: SUBAPP_WINDOW_MIN_HEIGHT,
          resizable: true,
          decorations: isMac,
          transparent: !isMac,
          center: true,
          visible: false,
        });
        windowRef.current[id] = win;
        postLifecycleMessage({
          type: "subapp:launch",
          id,
          label,
          source: "main",
        });
        syncAppearance({ id, label });
        void win.once("tauri://destroyed", () => {
          clearWindowRuntime(id);
        });
        void win.once("tauri://error", () => {
          clearWindowRuntime(id);
        });
      } catch {
        clearWindowRuntime(id);
      }
    },
    [
      clearWindowRuntime,
      defs,
      focusSubApp,
      isMac,
      postLifecycleMessage,
      setRuntimeStatus,
      syncAppearance,
    ],
  );

  const notifyMainShutdown = useCallback(() => {
    postLifecycleMessage({
      type: "subapp:main-shutdown",
      source: "main",
    });
    return Promise.resolve();
  }, [postLifecycleMessage]);

  /** 主窗口只分发“连接这个 Profile”的意图，实际 RDP runtime 仍由子应用独占。 */
  const connectRdpProfile = useCallback(
    async (profileId: string) => {
      pendingRdpConnectQueueRef.current = [
        ...pendingRdpConnectQueueRef.current.filter(
          (item) => item !== profileId,
        ),
        profileId,
      ];
      if (pendingRdpConnectTimerRef.current !== null) {
        window.clearTimeout(pendingRdpConnectTimerRef.current);
        pendingRdpConnectTimerRef.current = null;
      }
      const isRdpReady = statusByIdRef.current.rdp === "ready";
      if (isRdpReady) {
        // Windows 聚焦全屏窗口时可能暂停 Main WebView，必须先派发连接意图。
        flushPendingRdpCommands();
      }
      await launchSubApp("rdp");
      if (!isRdpReady) {
        flushPendingRdpCommands({ deferForStartup: true });
      }
    },
    [flushPendingRdpCommands, launchSubApp],
  );

  /** 打开所有已创建子应用窗口的开发者工具，供主窗口 About 面板统一触发。 */
  const openAllDevtools = useCallback(() => {
    (
      Object.entries(windowRef.current) as Array<
        [SubAppId, WebviewWindow | undefined]
      >
    ).forEach(([id, win]) => {
      if (!win) return;
      postLifecycleMessage({
        type: "subapp:devtools-open",
        source: "main",
        target: {
          id,
          label: createSubAppWindowLabel(id),
        },
      });
    });
  }, [postLifecycleMessage]);

  const subApps = useMemo<SubAppRuntimeInfo[]>(
    () =>
      defs.map((def) => ({
        id: def.id,
        label: def.menuLabel,
        status: statusById[def.id] ?? "idle",
      })),
    [defs, statusById],
  );

  return {
    subApps,
    launchSubApp,
    focusSubApp,
    closeSubApp,
    connectRdpProfile,
    openAllDevtools,
    notifyMainShutdown,
  };
}
