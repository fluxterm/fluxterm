/**
 * @module useFloatingWidgets
 * @description
 * 管理小组件“浮动窗口”生命周期与主窗口联动：
 * 1) 将当前槽位激活组件拆出并创建独立浮动窗口；
 * 2) 通过 BroadcastChannel 同步主题/语言与关闭事件；
 * 3) 浮动窗口关闭时按“关闭组件”语义处理，不自动回收到原槽位；
 * 4) 主窗口关闭时先关闭全部浮动窗口，再关闭主窗口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import type { Locale } from "@/i18n";
import {
  normalizeBackgroundMediaType,
  normalizeBackgroundRenderMode,
  normalizeBackgroundVideoReplayMode,
  type BackgroundMediaType,
  type BackgroundRenderMode,
  type BackgroundVideoReplayMode,
} from "@/constants/backgroundMedia";
import {
  FLOATING_WIDGET_WINDOW_HEIGHT,
  FLOATING_WIDGET_WINDOW_MIN_HEIGHT,
  FLOATING_WIDGET_WINDOW_MIN_WIDTH,
  FLOATING_WIDGET_WINDOW_WIDTH,
} from "@/constants/windows";
import type { ThemeId, WidgetKey } from "@/types";
import type { FloatingWidgetLayout, WidgetSlotId } from "@/layout/types";
import { isMacOS } from "@/utils/platform";

type useFloatingWidgetsProps = {
  floatingWidgetKey?: WidgetKey | null;
  floatingOrigins: FloatingWidgetLayout;
  setFloatingOrigins: React.Dispatch<
    React.SetStateAction<FloatingWidgetLayout>
  >;
  slotGroups: Record<string, { active: WidgetKey | null }>;
  setSlotGroups: React.Dispatch<
    React.SetStateAction<Record<string, { active: WidgetKey | null }>>
  >;
  widgetLabels: Record<WidgetKey, string>;
  layoutCollapsed: Record<"left" | "right" | "bottom", boolean>;
  locale: Locale;
  themeId: ThemeId;
  backgroundImageEnabled: boolean;
  backgroundImageAsset: string;
  backgroundImageSurfaceAlpha: number;
  backgroundMediaType: BackgroundMediaType;
  backgroundRenderMode: BackgroundRenderMode;
  backgroundVideoReplayMode: BackgroundVideoReplayMode;
  backgroundVideoReplayIntervalSec: number;
  setLocale: (locale: Locale) => void;
  setThemeId: (themeId: ThemeId) => void;
  setBackgroundImageEnabled: (enabled: boolean) => void;
  setBackgroundImageAsset: (asset: string) => void;
  setBackgroundImageSurfaceAlpha: (alpha: number) => void;
  setBackgroundMediaType: (type: BackgroundMediaType) => void;
  setBackgroundRenderMode: (mode: BackgroundRenderMode) => void;
  setBackgroundVideoReplayMode: (mode: BackgroundVideoReplayMode) => void;
  setBackgroundVideoReplayIntervalSec: (intervalSec: number) => void;
  onOpenCurrentDevtools?: () => void;
  onMainShutdown?: () => Promise<void> | void;
};

type FloatingWidgetsState = {
  floatingWidgets: Partial<Record<WidgetKey, boolean>>;
  handleFloat: (slot: WidgetSlotId) => Promise<void>;
  focusFloatingWidget: (widget: WidgetKey) => Promise<boolean>;
  restoreWidgetFloating: (widget: WidgetKey) => void;
  openAllDevtools: () => void;
};

function normalizeWidgetKey(value: unknown): WidgetKey | null {
  if (value === "profiles") return "profiles";
  if (value === "rdp") return "rdp";
  if (value === "serial") return "serial";
  if (value === "files") return "files";
  if (value === "transfers") return "transfers";
  if (value === "events") return "events";
  if (value === "history") return "history";
  if (value === "ai") return "ai";
  if (value === "tunnels") return "tunnels";
  if (value === "broadcast") return "broadcast";
  if (value === "logs") return "events";
  return null;
}

function normalizeThemeId(value: unknown): ThemeId | null {
  if (value === "dark" || value === "light") return value;
  if (value === "catppuccin-latte") return value;
  if (value === "catppuccin-frappe") return value;
  if (value === "catppuccin-macchiato") return value;
  if (value === "catppuccin-mocha") return value;
  if (value === "aurora" || value === "sahara") return "dark";
  if (value === "dawn") return "light";
  return null;
}

/** 悬浮窗口控制与同步。 */
export default function useFloatingWidgets({
  floatingWidgetKey: floatingWidgetKeyProp,
  floatingOrigins,
  setFloatingOrigins,
  slotGroups,
  setSlotGroups,
  widgetLabels,
  layoutCollapsed,
  locale,
  themeId,
  backgroundImageEnabled,
  backgroundImageAsset,
  backgroundImageSurfaceAlpha,
  backgroundMediaType,
  backgroundRenderMode,
  backgroundVideoReplayMode,
  backgroundVideoReplayIntervalSec,
  setLocale,
  setThemeId,
  setBackgroundImageEnabled,
  setBackgroundImageAsset,
  setBackgroundImageSurfaceAlpha,
  setBackgroundMediaType,
  setBackgroundRenderMode,
  setBackgroundVideoReplayMode,
  setBackgroundVideoReplayIntervalSec,
  onOpenCurrentDevtools,
  onMainShutdown,
}: useFloatingWidgetsProps): FloatingWidgetsState {
  const isMac = isMacOS();
  const floatingWidgetKey = useMemo<WidgetKey | null>(() => {
    if (typeof floatingWidgetKeyProp !== "undefined") {
      return floatingWidgetKeyProp;
    }
    const match = window.location.hash.match(/widget=([a-z]+)/i);
    if (!match) return null;
    return normalizeWidgetKey(match[1]);
  }, [floatingWidgetKeyProp]);

  const [floatingWidgets, setFloatingWidgets] = useState<
    Partial<Record<WidgetKey, boolean>>
  >({});
  const floatingWindowRef = useRef<Partial<Record<WidgetKey, WebviewWindow>>>(
    {},
  );
  const floatSyncChannelRef = useRef<BroadcastChannel | null>(null);
  const shuttingDownRef = useRef(false);

  /** 主窗口向浮动窗口广播布局与外观状态，保证视觉与语言一致。 */
  const broadcastFloatState = useCallback(() => {
    if (floatingWidgetKey) return;
    if (typeof BroadcastChannel === "undefined") return;
    const channel = floatSyncChannelRef.current;
    if (!channel) return;
    channel.postMessage({
      type: "layout",
      locale,
      themeId,
      backgroundImageEnabled,
      backgroundImageAsset,
      backgroundImageSurfaceAlpha,
      backgroundMediaType,
      backgroundRenderMode,
      backgroundVideoReplayMode,
      backgroundVideoReplayIntervalSec,
      collapsed: layoutCollapsed,
      slots: slotGroups,
    });
  }, [
    backgroundImageAsset,
    backgroundImageEnabled,
    backgroundImageSurfaceAlpha,
    backgroundMediaType,
    backgroundRenderMode,
    backgroundVideoReplayIntervalSec,
    backgroundVideoReplayMode,
    floatingWidgetKey,
    layoutCollapsed,
    locale,
    slotGroups,
    themeId,
  ]);

  const restoreWidgetFloating = useCallback((widget: WidgetKey) => {
    floatSyncChannelRef.current?.postMessage({
      type: "restore",
      widget,
    });
  }, []);

  const cleanupFloatingRuntime = useCallback((widget: WidgetKey) => {
    delete floatingWindowRef.current[widget];
    setFloatingWidgets((prev) => {
      if (!prev[widget]) return prev;
      const next = { ...prev };
      delete next[widget];
      return next;
    });
  }, []);

  /**
   * 浮动窗口配置与主窗口槽位已经解耦。
   * 关闭浮窗时只删除该组件的浮动配置，不会再回收到原始槽位。
   */
  const dismissFloatingWidget = useCallback(
    (widget: WidgetKey) => {
      cleanupFloatingRuntime(widget);
      setFloatingOrigins((prev) => {
        if (!prev[widget]) return prev;
        const next = { ...prev };
        delete next[widget];
        return next;
      });
    },
    [cleanupFloatingRuntime, setFloatingOrigins],
  );

  useEffect(() => {
    /** 浮动窗口主动关闭或刷新时，通知主窗口按“关闭组件”语义清理状态。 */
    if (!floatingWidgetKey) return;
    const onUnload = () => {
      restoreWidgetFloating(floatingWidgetKey);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [floatingWidgetKey, restoreWidgetFloating]);

  useEffect(() => {
    /** 主窗口/浮动窗口之间通过 BroadcastChannel 协调关闭语义与主题同步。 */
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("fluxterm-widget-sync");
    floatSyncChannelRef.current = channel;
    channel.onmessage = (event) => {
      const payload = event.data as
        | {
            type?: string;
            widget?: string;
            locale?: Locale;
            themeId?: ThemeId;
            backgroundImageEnabled?: boolean;
            backgroundImageAsset?: string;
            backgroundImageSurfaceAlpha?: number;
            backgroundMediaType?: BackgroundMediaType;
            backgroundRenderMode?: BackgroundRenderMode;
            backgroundVideoReplayMode?: BackgroundVideoReplayMode;
            backgroundVideoReplayIntervalSec?: number;
          }
        | undefined;
      if (!payload) return;
      if (payload.type === "restore") {
        const widget = normalizeWidgetKey(payload.widget);
        if (!widget) return;
        if (shuttingDownRef.current) {
          cleanupFloatingRuntime(widget);
          return;
        }
        dismissFloatingWidget(widget);
      }
      if (payload.type === "shutdown-all" && floatingWidgetKey) {
        getCurrentWindow()
          .close()
          .catch(() => {});
      }
      if (payload.type === "layout" && floatingWidgetKey) {
        if (payload.locale === "zh-CN" || payload.locale === "en-US") {
          setLocale(payload.locale);
        }
        const normalizedThemeId = normalizeThemeId(payload.themeId);
        if (normalizedThemeId) {
          setThemeId(normalizedThemeId);
        }
        if (typeof payload.backgroundImageEnabled === "boolean") {
          setBackgroundImageEnabled(payload.backgroundImageEnabled);
        }
        if (typeof payload.backgroundImageAsset === "string") {
          setBackgroundImageAsset(payload.backgroundImageAsset);
        }
        if (
          typeof payload.backgroundImageSurfaceAlpha === "number" &&
          Number.isFinite(payload.backgroundImageSurfaceAlpha)
        ) {
          setBackgroundImageSurfaceAlpha(payload.backgroundImageSurfaceAlpha);
        }
        if (typeof payload.backgroundMediaType === "string") {
          setBackgroundMediaType(
            normalizeBackgroundMediaType(payload.backgroundMediaType),
          );
        }
        if (typeof payload.backgroundRenderMode === "string") {
          setBackgroundRenderMode(
            normalizeBackgroundRenderMode(payload.backgroundRenderMode),
          );
        }
        if (typeof payload.backgroundVideoReplayMode === "string") {
          setBackgroundVideoReplayMode(
            normalizeBackgroundVideoReplayMode(
              payload.backgroundVideoReplayMode,
            ),
          );
        }
        if (
          typeof payload.backgroundVideoReplayIntervalSec === "number" &&
          Number.isFinite(payload.backgroundVideoReplayIntervalSec)
        ) {
          setBackgroundVideoReplayIntervalSec(
            payload.backgroundVideoReplayIntervalSec,
          );
        }
      }
      if (payload.type === "devtools:open") {
        onOpenCurrentDevtools?.();
      }
    };
    return () => {
      channel.close();
      if (floatSyncChannelRef.current === channel) {
        floatSyncChannelRef.current = null;
      }
    };
  }, [
    cleanupFloatingRuntime,
    dismissFloatingWidget,
    floatingWidgetKey,
    onOpenCurrentDevtools,
    setBackgroundImageAsset,
    setBackgroundImageEnabled,
    setBackgroundImageSurfaceAlpha,
    setBackgroundMediaType,
    setBackgroundRenderMode,
    setBackgroundVideoReplayIntervalSec,
    setBackgroundVideoReplayMode,
    setLocale,
    setThemeId,
  ]);

  useEffect(() => {
    broadcastFloatState();
  }, [broadcastFloatState]);

  useEffect(() => {
    /**
     * 主窗口关闭时先关闭所有浮动窗口，再关闭主窗口自身。
     * 这里同时使用内存引用和运行时窗口枚举，避免遗漏未记录窗口。
     */
    const current = getCurrentWindow();
    if (current.label !== "main") return () => {};
    const closingRef = { current: false };
    let stopCloseRequested: (() => void) | null = null;

    const closeWindowAndWait = (
      win?: {
        close: () => Promise<unknown>;
        once?: (event: string, handler: () => void) => unknown;
      } | null,
    ) =>
      new Promise<void>((resolve) => {
        if (!win) {
          resolve();
          return;
        }
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve();
        }, 1200);
        if (typeof win.once === "function") {
          try {
            win.once("tauri://destroyed", () => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              resolve();
            });
          } catch {
            // ignore listener errors and fallback to timeout
          }
        }
        win.close().catch(() => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve();
        });
      });

    const unlisten = current.onCloseRequested(async (event) => {
      if (closingRef.current) return;
      closingRef.current = true;
      shuttingDownRef.current = true;
      event.preventDefault();
      floatSyncChannelRef.current?.postMessage({ type: "shutdown-all" });
      await onMainShutdown?.();
      stopCloseRequested?.();
      stopCloseRequested = null;
      const merged = new Map<
        string,
        {
          close: () => Promise<unknown>;
          once?: (event: string, handler: () => void) => unknown;
        }
      >();
      Object.values(floatingWindowRef.current).forEach((win) => {
        if (!win) return;
        merged.set(win.label, win);
      });
      const runtimeWindows = await getAllWindows().catch(() => []);
      runtimeWindows
        .filter(
          (win) =>
            win.label.startsWith("widget-") || win.label.startsWith("subapp-"),
        )
        .forEach((win) => {
          merged.set(win.label, win);
        });
      await Promise.all(
        Array.from(merged.values()).map((win) => closeWindowAndWait(win)),
      );
      current.close().catch(() => {});
    });

    unlisten
      .then((fn) => {
        stopCloseRequested = fn;
      })
      .catch(() => {});

    return () => {
      if (stopCloseRequested) {
        stopCloseRequested();
        stopCloseRequested = null;
        return;
      }
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [onMainShutdown]);

  const openFloatingWindow = useCallback(
    async (slot: WidgetSlotId, widget: WidgetKey) => {
      const existing = floatingWindowRef.current[widget];
      if (existing) {
        await existing.setFocus().catch(() => {});
        return;
      }

      setFloatingWidgets((prev) => ({ ...prev, [widget]: true }));

      try {
        const label = `widget-${widget}`;
        const win = new WebviewWindow(label, {
          url: `/#widget=${widget}`,
          title: widgetLabels[widget],
          width: FLOATING_WIDGET_WINDOW_WIDTH,
          height: FLOATING_WIDGET_WINDOW_HEIGHT,
          minWidth: FLOATING_WIDGET_WINDOW_MIN_WIDTH,
          minHeight: FLOATING_WIDGET_WINDOW_MIN_HEIGHT,
          resizable: true,
          decorations: isMac,
          transparent: !isMac,
          center: true,
          visible: false,
        });
        floatingWindowRef.current[widget] = win;
        // 正常关闭路径以下层窗口销毁为唯一事实源。
        void win.once("tauri://error", () => {
          cleanupFloatingRuntime(widget);
          setFloatingOrigins((prev) => {
            if (!prev[widget]) return prev;
            const next = { ...prev };
            delete next[widget];
            return next;
          });
          setSlotGroups((prev) => {
            const group = prev[slot];
            if (!group || group.active === widget) return prev;
            return {
              ...prev,
              [slot]: {
                active: widget,
              },
            };
          });
        });
        void win.once("tauri://destroyed", () => {
          if (shuttingDownRef.current) {
            cleanupFloatingRuntime(widget);
            return;
          }
          dismissFloatingWidget(widget);
        });
      } catch {
        cleanupFloatingRuntime(widget);
        setFloatingOrigins((prev) => {
          if (!prev[widget]) return prev;
          const next = { ...prev };
          delete next[widget];
          return next;
        });
        setSlotGroups((prev) => {
          const group = prev[slot];
          if (!group || group.active === widget) return prev;
          return {
            ...prev,
            [slot]: {
              active: widget,
            },
          };
        });
      }
    },
    [
      cleanupFloatingRuntime,
      dismissFloatingWidget,
      isMac,
      widgetLabels,
      setFloatingOrigins,
      setSlotGroups,
    ],
  );

  useEffect(() => {
    if (floatingWidgetKey) return;
    // 主窗口已经进入退出流程时，不再根据持久化 floating 配置自动恢复浮窗；
    // 否则某个浮窗刚被 shutdown-all 关闭，又会因为配置仍在而被重新创建。
    if (shuttingDownRef.current) return;
    (
      Object.entries(floatingOrigins) as Array<
        [string, { origin: WidgetSlotId }]
      >
    ).forEach(([widgetKey, value]) => {
      const normalizedWidget = normalizeWidgetKey(widgetKey);
      if (!normalizedWidget) return;
      if (
        floatingWidgets[normalizedWidget] ||
        floatingWindowRef.current[normalizedWidget]
      ) {
        return;
      }
      openFloatingWindow(value.origin, normalizedWidget).catch(() => {});
    });
  }, [floatingWidgetKey, floatingOrigins, floatingWidgets, openFloatingWindow]);

  const handleFloat = useCallback(
    async (slot: WidgetSlotId) => {
      const widget = slotGroups[slot].active;
      if (!widget) return;
      const hasTauriRuntime =
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (!hasTauriRuntime) return;

      setFloatingOrigins((prev) => ({
        ...prev,
        [widget]: { origin: slot },
      }));
      setSlotGroups((prev) => {
        const group = prev[slot];
        if (!group || group.active !== widget) return prev;
        return {
          ...prev,
          [slot]: {
            active: null,
          },
        };
      });
      await openFloatingWindow(slot, widget);
    },
    [openFloatingWindow, setFloatingOrigins, setSlotGroups, slotGroups],
  );

  /** 将已存在的浮动组件窗口带到前台。 */
  const focusFloatingWidget = useCallback(async (widget: WidgetKey) => {
    const current = floatingWindowRef.current[widget];
    if (!current) return false;
    try {
      await current.setFocus();
      return true;
    } catch {
      return false;
    }
  }, []);

  /** 通知所有窗口打开开发者工具。 */
  const openAllDevtools = useCallback(() => {
    floatSyncChannelRef.current?.postMessage({ type: "devtools:open" });
  }, []);

  return {
    floatingWidgets,
    handleFloat,
    focusFloatingWidget,
    restoreWidgetFloating,
    openAllDevtools,
  };
}
