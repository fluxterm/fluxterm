import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  FiActivity,
  FiClipboard,
  FiVolume2,
  FiVolumeX,
  FiX,
} from "react-icons/fi";
import type { Locale, Translate } from "@/i18n";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import {
  createOperationId,
  logDebug,
  logError,
  logInfo,
  logWarn,
  type LogError,
} from "@/shared/logging";
import type {
  RdpDisplayStrategy,
  RdpInputEvent,
  RdpProfile,
  RdpSessionSnapshot,
} from "@/types";
import type { SubAppId } from "@/subapps/types";
import {
  SUBAPP_LIFECYCLE_CHANNEL,
  createSubAppWindowLabel,
  type SubAppLifecycleMessage,
} from "@/subapps/core/lifecycle";
import SubAppTitleBar from "@/subapps/components/SubAppTitleBar";
import Tooltip from "@/components/ui/menu/Tooltip";
import { isLinuxOS, isMacOS } from "@/utils/platform";
import {
  connectRdpSession,
  createRdpSession,
  decideRdpCertificate,
  disconnectRdpSession,
  listRdpProfiles,
  resizeRdpSession,
  setRdpAudioMuted,
  sendRdpInput,
  setRdpClipboard,
} from "@/features/rdp/core/commands";
import { RdpMainThreadBridge } from "@/subapps/rdp/RdpMainThreadBridge";
import {
  getRdpPerformanceTelemetryStatus,
  getRdpResolutionClass,
  RdpPerformanceCollector,
} from "@/subapps/rdp/performanceTelemetry";
import "./RdpSubApp.css";

const PERFORMANCE_TELEMETRY_ENABLED = import.meta.env.MODE === "telemetry";

type RdpSubAppProps = {
  id: SubAppId;
  locale: Locale;
  t: Translate;
};

type RdpPerfSnapshot = {
  fps: number;
  bridgeState: "idle" | "connecting" | "open" | "closed";
};

type RdpStatusIndicatorTone = "normal" | "degraded" | "error";
type RdpLogLevel = "debug" | "info" | "warn" | "error";

type RdpWireEvent =
  | {
      type: "state";
      state: string;
      message?: string;
      width?: number;
      height?: number;
    }
  | { type: "cursor"; cursor: string }
  | { type: "clipboard"; direction: string; text: string }
  | {
      type: "audio-state";
      state: RdpSessionSnapshot["audioState"];
      muted: boolean;
      message?: string;
    }
  | { type: "input-ack"; kind: string }
  | { type: "error"; code: string; message: string };

type RdpWorkerMessage =
  | {
      type: "bridge-state";
      sessionId: string;
      state?: "open" | "closed" | "error";
      details?: Record<string, unknown>;
    }
  | {
      type: "wire-event";
      sessionId: string;
      payload?: RdpWireEvent;
    }
  | {
      type: "frame-presented";
      sessionId: string;
      frameVersion?: number;
      presentedFrames?: number;
      receivedFrames?: number;
      droppedFrames?: number;
      queueDepthMax?: number;
      renderDurationMs?: number;
      surfaceWidth?: number;
      surfaceHeight?: number;
    }
  | {
      type: "diagnostic";
      sessionId?: string;
      level?: RdpLogLevel;
      event?: string;
      fields?: Record<string, unknown>;
    };

type RdpRendererControlMessage =
  | { type: "set-active"; sessionId: string | null }
  | { type: "connect"; sessionId: string; url: string }
  | { type: "disconnect"; sessionId: string };

type RdpCachedFrameRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  remoteWidth: number;
  remoteHeight: number;
};

type RdpSessionTab = {
  session: RdpSessionSnapshot;
  profile: RdpProfile;
  operationId: string;
  statusText: string;
  errorMessage: string;
  perf: RdpPerfSnapshot;
  remoteCursor: string;
};

const EMPTY_PERF: RdpPerfSnapshot = {
  fps: 0,
  bridgeState: "idle",
};

function getProfileDisplayName(
  profile: Pick<RdpProfile, "name" | "host">,
  t: Translate,
) {
  return (
    profile.name.trim() || profile.host.trim() || t("rdp.profile.fallbackName")
  );
}

function getSessionResolutionValue(session: RdpSessionSnapshot | null) {
  if (!session) return "--";
  if (session.width <= 0 || session.height <= 0) return "--";
  return `${session.width} × ${session.height}`;
}

/** 获取当前会话音频状态的本地化文案。 */
function getSessionAudioStateLabel(
  session: RdpSessionSnapshot | null,
  t: Translate,
) {
  if (!session?.audioEnabled) return t("rdp.audio.state.unavailable");
  if (session.audioMuted) return t("rdp.audio.state.muted");
  return t(`rdp.audio.state.${session.audioState}`);
}

function getStatusIndicatorTone(perf: RdpPerfSnapshot): RdpStatusIndicatorTone {
  if (perf.bridgeState === "closed") {
    return "error";
  }
  if (perf.bridgeState === "open" && perf.fps > 0) {
    return "normal";
  }
  return "degraded";
}

function getClipboardStatusValue(
  profile: Pick<RdpProfile, "clipboardMode"> | null,
  perf: RdpPerfSnapshot,
  t: Translate,
) {
  if (!profile) return t("rdp.statusPanel.state.unavailable");
  if (profile.clipboardMode === "disabled") {
    return t("rdp.statusPanel.state.disabled");
  }
  if (perf.bridgeState === "open") {
    return t("rdp.statusPanel.state.connected");
  }
  return t("rdp.statusPanel.state.disconnected");
}

function getStatusIndicatorToneLabel(
  tone: RdpStatusIndicatorTone,
  t: Translate,
) {
  return t(`rdp.statusPanel.legend.${tone}`);
}

/** 判断当前会话是否仍允许前端重新附着桥接。 */
function canAttachBridge(
  session: RdpSessionSnapshot | null | undefined,
): session is RdpSessionSnapshot & { wsUrl: string } {
  if (!session?.wsUrl) {
    return false;
  }
  return session.state !== "disconnected" && session.state !== "error";
}

function logRdpSubAppEvent(
  level: RdpLogLevel,
  event: string,
  fields?: Record<string, unknown>,
) {
  const operationId =
    typeof fields?.operationId === "string" ? fields.operationId : undefined;
  const safeFields = { ...(fields ?? {}) };
  delete safeFields.operationId;
  const writer = {
    debug: logDebug,
    info: logInfo,
    warn: logWarn,
    error: logError,
  }[level];
  writer(event, safeFields, operationId);
}

function getLogError(error: unknown, code: string, message: string): LogError {
  return {
    code,
    message,
    detail: error instanceof Error ? error.message : String(error),
  };
}

function getSafeWsUrlFields(url: string | null | undefined) {
  if (!url) {
    return {
      hasWsUrl: false,
    };
  }
  try {
    const parsed = new URL(url);
    return {
      hasWsUrl: true,
      wsUrlProtocol: parsed.protocol,
      wsUrlHost: parsed.host,
      wsUrlPathname: parsed.pathname,
      hasToken: parsed.searchParams.has("token"),
    };
  } catch (error) {
    return {
      hasWsUrl: true,
      wsUrlInvalid: true,
      error: getLogError(
        error,
        "rdp_bridge_url_invalid",
        "RDP bridge URL is invalid",
      ),
    };
  }
}

/** 读取当前 RDP 视口尺寸，并做基础下限收敛。 */
function measureSurfaceViewport(surface: HTMLDivElement | null) {
  if (!surface) return null;
  const rect = surface.getBoundingClientRect();
  const width = Math.max(
    Math.floor(surface.clientWidth || rect.width || 0),
    320,
  );
  const height = Math.max(
    Math.floor(surface.clientHeight || rect.height || 0),
    200,
  );
  return { width, height };
}

/** 等待自动开窗后的视口尺寸稳定，避免首屏仍拿到过渡态大小。 */
async function waitForStableSurfaceViewport(
  surface: HTMLDivElement | null,
  minStableFrames = 2,
  maxFrames = 12,
) {
  if (!surface) return null;

  let previous: { width: number; height: number } | null = null;
  let stableFrames = 0;

  for (let frame = 0; frame < maxFrames; frame += 1) {
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    const measured = measureSurfaceViewport(surface);
    if (!measured) continue;

    if (
      previous &&
      previous.width === measured.width &&
      previous.height === measured.height
    ) {
      stableFrames += 1;
      if (stableFrames >= minStableFrames) {
        return measured;
      }
    } else {
      stableFrames = 0;
      previous = measured;
    }
  }

  return measureSurfaceViewport(surface);
}

/** 根据显示策略计算远端画面在当前视口中的实际显示区域。 */
function resolveDisplayedFrameRect(
  surfaceRect: DOMRect,
  remoteWidth: number,
  remoteHeight: number,
  strategy: RdpDisplayStrategy,
) {
  if (strategy === "stretch") {
    return {
      left: surfaceRect.left,
      top: surfaceRect.top,
      width: surfaceRect.width,
      height: surfaceRect.height,
    };
  }

  const safeRemoteWidth = Math.max(remoteWidth, 1);
  const safeRemoteHeight = Math.max(remoteHeight, 1);
  const widthScale = surfaceRect.width / safeRemoteWidth;
  const heightScale = surfaceRect.height / safeRemoteHeight;
  const scale =
    strategy === "cover"
      ? Math.max(widthScale, heightScale)
      : Math.min(widthScale, heightScale);
  const displayedWidth = safeRemoteWidth * scale;
  const displayedHeight = safeRemoteHeight * scale;
  const offsetX = (surfaceRect.width - displayedWidth) / 2;
  const offsetY = (surfaceRect.height - displayedHeight) / 2;

  return {
    left: surfaceRect.left + offsetX,
    top: surfaceRect.top + offsetY,
    width: displayedWidth,
    height: displayedHeight,
  };
}

/** 将配置中的显示策略映射为 canvas 的 object-fit。 */
function getCanvasObjectFit(strategy: RdpDisplayStrategy) {
  switch (strategy) {
    case "cover":
      return "cover";
    case "stretch":
      return "fill";
    default:
      return "contain";
  }
}

/** RDP 子应用。 */
export default function RdpSubApp({ id, locale, t }: RdpSubAppProps) {
  const isMac = useMemo(() => isMacOS(), []);
  const isLinux = useMemo(() => isLinuxOS(), []);
  const windowLabel = useMemo(() => createSubAppWindowLabel(id), [id]);
  const closingRef = useRef(false);
  const cleanupInFlightRef = useRef<Promise<void> | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const mainThreadBridgeRef = useRef<RdpMainThreadBridge | null>(null);
  const rendererCleanupTimerRef = useRef<number | null>(null);
  const canvasTransferredRef = useRef(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const lastSyncTextRef = useRef<string | null>(null);

  const [sessions, setSessions] = useState<RdpSessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const sessionsRef = useRef<RdpSessionTab[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const statusPanelRef = useRef<HTMLDivElement | null>(null);
  const frameVersionBySessionRef = useRef<Record<string, number>>({});
  const presentedFrameCountBySessionRef = useRef<Record<string, number>>({});
  const renderedSizeBySessionRef = useRef<
    Record<string, { width: number; height: number }>
  >({});
  const performanceCollectorsRef = useRef<
    Record<string, RdpPerformanceCollector>
  >({});
  const performanceIntervalMsRef = useRef(1000);
  const cachedFrameRectRef = useRef<RdpCachedFrameRect | null>(null);
  const pendingMouseMoveRef = useRef<{
    sessionId: string;
    input: RdpInputEvent;
  } | null>(null);
  const mouseMoveRafRef = useRef<number | null>(null);
  const presentedFpsRuntimeRef = useRef<{
    frameCount: number;
    windowStartAt: number;
    lastSeenFrameVersion: number;
    lastReportedFps: number;
    rafId: number | null;
  }>({
    frameCount: 0,
    windowStartAt: 0,
    lastSeenFrameVersion: 0,
    lastReportedFps: -1,
    rafId: null,
  });

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!PERFORMANCE_TELEMETRY_ENABLED) return;
    void getRdpPerformanceTelemetryStatus().then((status) => {
      if (status.enabled && status.domains.includes("rdp")) {
        performanceIntervalMsRef.current = status.intervalMs;
        Object.values(performanceCollectorsRef.current).forEach((collector) =>
          collector.setIntervalMs(status.intervalMs),
        );
      }
    });
    return () => {
      performanceCollectorsRef.current = {};
    };
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const activeTab = useMemo(
    () =>
      sessions.find((item) => item.session.sessionId === activeSessionId) ??
      null,
    [activeSessionId, sessions],
  );

  const activePerf = activeTab?.perf ?? EMPTY_PERF;
  const statusLineText =
    activeTab?.statusText ?? t("rdp.status.noActiveSession");
  const showDisconnectedOverlay = activeTab?.session.state === "disconnected";
  const canToggleFullscreen = Boolean(
    activeTab && activeTab.session.state !== "disconnected",
  );
  const statusIndicatorTone = getStatusIndicatorTone(activePerf);
  const clipboardStatusValue = getClipboardStatusValue(
    activeTab?.profile ?? null,
    activePerf,
    t,
  );
  const audioStatusValue = getSessionAudioStateLabel(
    activeTab?.session ?? null,
    t,
  );
  const canToggleAudio = Boolean(
    activeTab?.session.audioEnabled &&
    activeTab.session.state !== "disconnected" &&
    activeTab.session.state !== "error",
  );

  /** 统一全屏切换逻辑，确保 Tauri 窗口和 DOM 状态同步 */
  const handleFullscreenToggle = useCallback(async (toFullscreen: boolean) => {
    const shell = shellRef.current;
    const appWindow = getCurrentWindow();
    if (!shell) return;

    try {
      if (toFullscreen) {
        // 进入全屏
        if (await appWindow.isMaximized()) {
          await appWindow.unmaximize(); // 解除最大化确保覆盖 Windows 任务栏
        }
        await appWindow.setFullscreen(true);
        // 同步 DOM 全屏状态，以便使用 :fullscreen 伪类并保持浏览器标准行为
        if (document.fullscreenElement !== shell) {
          await shell.requestFullscreen().catch(() => {});
        }
        setIsFullscreen(true);
      } else {
        // 退出全屏
        if (document.fullscreenElement) {
          await document.exitFullscreen().catch(() => {});
        }
        await appWindow.setFullscreen(false);
        setIsFullscreen(false);
      }
    } catch (err) {
      logRdpSubAppEvent("warn", "rdp.fullscreen.transition.failed", {
        error: getLogError(
          err,
          "rdp_fullscreen_transition_failed",
          "RDP fullscreen transition failed",
        ),
      });
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    void handleFullscreenToggle(!isFullscreen);
  }, [handleFullscreenToggle, isFullscreen]);

  // 监听 DOM 全屏变化（例如用户按 Esc 退出）
  useEffect(() => {
    const onFullscreenChange = () => {
      const isDomFullscreen = document.fullscreenElement === shellRef.current;
      // 若 DOM 状态与记录的内部状态不一致（通常是 DOM 侧主动退出），则同步窗口状态
      if (!isDomFullscreen && isFullscreen) {
        void handleFullscreenToggle(false);
      }
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [handleFullscreenToggle, isFullscreen]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F11") {
        if (!canToggleFullscreen) return;
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      if (event.key === "Escape" && statusPanelOpen) {
        event.preventDefault();
        setStatusPanelOpen(false);
        return;
      }
      if (event.key === "Escape" && isFullscreen) {
        event.preventDefault();
        void handleFullscreenToggle(false);
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [
    canToggleFullscreen,
    toggleFullscreen,
    isFullscreen,
    statusPanelOpen,
    handleFullscreenToggle,
  ]);

  useEffect(() => {
    const cancel = scheduleDeferredTask(() => {
      setStatusPanelOpen(false);
    });
    return cancel;
  }, [activeSessionId]);

  useEffect(() => {
    if (!isFullscreen) return;
    surfaceRef.current?.focus();
  }, [isFullscreen]);

  /** 统一更新某个会话标签的状态。 */
  const updateSessionTab = useCallback(
    (sessionId: string, updater: (tab: RdpSessionTab) => RdpSessionTab) => {
      setSessions((prev) =>
        prev.map((tab) =>
          tab.session.sessionId === sessionId ? updater(tab) : tab,
        ),
      );
    },
    [],
  );

  /** 重置当前活动会话的可见呈现 FPS 采样窗口，避免切换标签后沿用旧计数。 */
  const resetPresentedFpsSampler = useCallback(
    (sessionId: string | null) => {
      const runtime = presentedFpsRuntimeRef.current;
      runtime.frameCount = 0;
      runtime.windowStartAt = performance.now();
      runtime.lastSeenFrameVersion = sessionId
        ? (presentedFrameCountBySessionRef.current[sessionId] ?? 0)
        : 0;
      runtime.lastReportedFps = -1;
      if (sessionId) {
        updateSessionTab(sessionId, (tab) => ({
          ...tab,
          perf: { ...tab.perf, fps: 0 },
        }));
      }
    },
    [updateSessionTab],
  );

  /** 同步本地剪贴板到远端。 */
  const syncLocalClipboardToRemote = useCallback(async () => {
    if (!activeTab || activePerf.bridgeState !== "open") return;
    if (activeTab.profile.clipboardMode === "disabled") return;

    try {
      const text = await readText();
      if (typeof text === "string" && text !== lastSyncTextRef.current) {
        lastSyncTextRef.current = text;
        void setRdpClipboard(activeTab.session.sessionId, text, {
          operationId: activeTab.operationId,
        });
      }
    } catch {
      // 忽略剪贴板读取失败
    }
  }, [activePerf.bridgeState, activeTab]);

  useEffect(() => {
    if (!activeSessionId || activePerf.bridgeState !== "open") return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncLocalClipboardToRemote();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [activePerf.bridgeState, activeSessionId, syncLocalClipboardToRemote]);

  /** 处理运行时状态、光标、剪贴板和错误事件。 */
  const handleWireEvent = useCallback(
    (sessionId: string, payload: RdpWireEvent) => {
      if (payload.type === "state") {
        const isTerminalState =
          payload.state === "error" || payload.state === "disconnected";
        if (isTerminalState) {
          mainThreadBridgeRef.current?.disconnect(sessionId);
          workerRef.current?.postMessage({
            type: "disconnect",
            sessionId,
          });
        }
        updateSessionTab(sessionId, (tab) => ({
          ...tab,
          statusText:
            payload.message === "desktop resized"
              ? tab.statusText
              : (payload.message ?? tab.statusText),
          errorMessage:
            payload.state === "error"
              ? tab.errorMessage || t("rdp.status.sessionErrorHint")
              : tab.errorMessage,
          perf:
            payload.state === "error" || payload.state === "disconnected"
              ? { ...tab.perf, bridgeState: "closed" }
              : tab.perf,
          session: {
            ...tab.session,
            state: payload.state as RdpSessionSnapshot["state"],
            wsUrl: isTerminalState ? null : tab.session.wsUrl,
            width:
              typeof payload.width === "number"
                ? payload.width
                : tab.session.width,
            height:
              typeof payload.height === "number"
                ? payload.height
                : tab.session.height,
          },
        }));
        return;
      }
      if (payload.type === "cursor") {
        updateSessionTab(sessionId, (tab) => ({
          ...tab,
          remoteCursor: payload.cursor || "crosshair",
        }));
        return;
      }
      if (payload.type === "clipboard") {
        const operationId =
          sessionsRef.current.find((tab) => tab.session.sessionId === sessionId)
            ?.operationId ?? null;
        logRdpSubAppEvent("debug", "rdp.clipboard.sync", {
          operationId,
          sessionId,
          direction: payload.direction,
          textLength: payload.text.length,
        });
        if (payload.direction === "remote-to-local") {
          lastSyncTextRef.current = payload.text;
          void writeText(payload.text);
        }
        return;
      }
      if (payload.type === "audio-state") {
        updateSessionTab(sessionId, (tab) => ({
          ...tab,
          session: {
            ...tab.session,
            audioState: payload.state,
            audioMuted: payload.muted,
          },
        }));
        return;
      }
      if (payload.type === "error") {
        updateSessionTab(sessionId, (tab) => ({
          ...tab,
          errorMessage: payload.message || payload.code,
          statusText: t("rdp.status.runtimeError"),
          perf: { ...tab.perf, bridgeState: "closed" },
        }));
      }
    },
    [t, updateSessionTab],
  );

  /** 保持最新的回调引用，避免 Worker 因依赖变化频繁重启 */
  const handlersRef = useRef({
    locale,
    t,
    updateSessionTab,
    handleWireEvent,
    resetPresentedFpsSampler,
  });
  useEffect(() => {
    handlersRef.current = {
      locale,
      t,
      updateSessionTab,
      handleWireEvent,
      resetPresentedFpsSampler,
    };
  }, [locale, t, updateSessionTab, handleWireEvent, resetPresentedFpsSampler]);

  /** 统一处理 Worker 与主线程 fallback 的渲染通道事件。 */
  const handleRendererMessage = useCallback((message: RdpWorkerMessage) => {
    const { type } = message;
    const current = handlersRef.current;

    if (type === "bridge-state") {
      const { sessionId, state } = message;
      const operationId =
        sessionsRef.current.find((tab) => tab.session.sessionId === sessionId)
          ?.operationId ?? null;
      if (state === "open") {
        logRdpSubAppEvent("debug", "rdp.bridge.connected", {
          operationId,
          sessionId,
          ...(message.details ?? {}),
        });
      } else if (state === "error") {
        logRdpSubAppEvent("warn", "rdp.bridge.failed", {
          operationId,
          sessionId,
          ...(message.details ?? {}),
          error: {
            code: "rdp_bridge_failed",
            message: "RDP renderer bridge failed",
          },
        });
      } else {
        logRdpSubAppEvent("debug", "rdp.bridge.disconnected", {
          operationId,
          sessionId,
          ...(message.details ?? {}),
        });
      }
      current.updateSessionTab(sessionId, (tab) => ({
        ...tab,
        perf: {
          ...tab.perf,
          bridgeState: state === "error" ? "closed" : (state ?? "closed"),
        },
      }));
      if (state !== "open") {
        current.resetPresentedFpsSampler(
          activeSessionIdRef.current === sessionId ? sessionId : null,
        );
      }
      return;
    }

    if (type === "wire-event" && message.payload) {
      current.handleWireEvent(message.sessionId, message.payload);
      return;
    }

    if (
      type === "frame-presented" &&
      typeof message.frameVersion === "number"
    ) {
      frameVersionBySessionRef.current[message.sessionId] =
        message.frameVersion;
      const presentedFrames = Math.max(1, message.presentedFrames ?? 1);
      presentedFrameCountBySessionRef.current[message.sessionId] =
        (presentedFrameCountBySessionRef.current[message.sessionId] ?? 0) +
        presentedFrames;
      if (
        typeof message.surfaceWidth === "number" &&
        message.surfaceWidth > 0 &&
        typeof message.surfaceHeight === "number" &&
        message.surfaceHeight > 0
      ) {
        renderedSizeBySessionRef.current[message.sessionId] = {
          width: message.surfaceWidth,
          height: message.surfaceHeight,
        };
      }
      if (PERFORMANCE_TELEMETRY_ENABLED) {
        const streamId = sessionsRef.current.find(
          (tab) => tab.session.sessionId === message.sessionId,
        )?.session.performanceStreamId;
        if (streamId) {
          const collector =
            performanceCollectorsRef.current[streamId] ??
            new RdpPerformanceCollector(
              streamId,
              performanceIntervalMsRef.current,
            );
          performanceCollectorsRef.current[streamId] = collector;
          collector.recordPresented(
            presentedFrames,
            message.queueDepthMax ?? 0,
            message.receivedFrames ?? presentedFrames,
            message.droppedFrames ?? 0,
            message.renderDurationMs ?? 0,
          );
        }
      }
      return;
    }

    if (type === "diagnostic") {
      const operationId = message.sessionId
        ? (sessionsRef.current.find(
            (tab) => tab.session.sessionId === message.sessionId,
          )?.operationId ?? null)
        : null;
      logRdpSubAppEvent("debug", "rdp.renderer.diagnostic", {
        operationId,
        sessionId: message.sessionId ?? null,
        diagnosticKind: message.event ?? "unspecified",
        ...(message.fields ?? {}),
      });
    }
  }, []);

  /** 向当前可用渲染通道发送控制消息。 */
  const postRendererControl = useCallback(
    (message: RdpRendererControlMessage) => {
      const mainThreadBridge = mainThreadBridgeRef.current;
      if (mainThreadBridge) {
        if (message.type === "set-active") {
          mainThreadBridge.setActiveSession(message.sessionId);
        } else if (message.type === "connect") {
          mainThreadBridge.connect(message.sessionId, message.url);
        } else if (message.type === "disconnect") {
          mainThreadBridge.disconnect(message.sessionId);
        }
        return true;
      }

      const worker = workerRef.current;
      if (!worker) {
        return false;
      }
      worker.postMessage(message);
      return true;
    },
    [],
  );

  /** 返回当前渲染通道类型，便于日志定位是否使用 fallback。 */
  const getRendererMode = useCallback(() => {
    if (mainThreadBridgeRef.current) return "main-thread";
    if (workerRef.current) return "worker";
    return "none";
  }, []);

  /** 在关闭后端流之前提交指定会话的前端尾窗口。 */
  const flushPerformanceCollector = useCallback(
    async (sessionId: string) => {
      if (!PERFORMANCE_TELEMETRY_ENABLED) return;
      const tab = sessionsRef.current.find(
        (item) => item.session.sessionId === sessionId,
      );
      const streamId = tab?.session.performanceStreamId;
      if (!tab || !streamId) return;
      const collector = performanceCollectorsRef.current[streamId];
      if (!collector) return;
      const renderedSize = renderedSizeBySessionRef.current[sessionId];
      const width = renderedSize?.width ?? tab.session.width;
      const height = renderedSize?.height ?? tab.session.height;
      await collector.flushFinal(width, height, {
        rendererMode: getRendererMode(),
        visibility:
          document.visibilityState === "hidden" ? "hidden" : "visible",
        resolutionClass: getRdpResolutionClass(width, height),
      });
      delete performanceCollectorsRef.current[streamId];
    },
    [getRendererMode],
  );

  const refreshCachedFrameRect = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface || !activeTab) {
      cachedFrameRectRef.current = null;
      return null;
    }
    const surfaceRect = surface.getBoundingClientRect();
    if (activeTab.session.width <= 0 || activeTab.session.height <= 0) {
      cachedFrameRectRef.current = null;
      return null;
    }
    const frameRect = resolveDisplayedFrameRect(
      surfaceRect,
      activeTab.session.width,
      activeTab.session.height,
      activeTab.profile.displayStrategy,
    );
    const cached = {
      ...frameRect,
      remoteWidth: activeTab.session.width,
      remoteHeight: activeTab.session.height,
    };
    cachedFrameRectRef.current = cached;
    return cached;
  }, [activeTab]);

  useEffect(() => {
    refreshCachedFrameRect();
  }, [
    activeSessionId,
    activeTab?.session.width,
    activeTab?.session.height,
    activeTab?.profile.displayStrategy,
    isFullscreen,
    refreshCachedFrameRect,
  ]);

  /** 初始化 Web Worker 和 OffscreenCanvas */
  useEffect(() => {
    if (rendererCleanupTimerRef.current !== null) {
      window.clearTimeout(rendererCleanupTimerRef.current);
      rendererCleanupTimerRef.current = null;
    }

    const scheduleRendererCleanup = () => {
      if (rendererCleanupTimerRef.current !== null) {
        window.clearTimeout(rendererCleanupTimerRef.current);
      }
      // React StrictMode 会在开发态执行一次 setup → cleanup → setup。
      // 延后销毁可让第二次 setup 复用已接管 canvas 的 renderer，同时真实卸载仍会完成清理。
      rendererCleanupTimerRef.current = window.setTimeout(() => {
        rendererCleanupTimerRef.current = null;
        workerRef.current?.terminate();
        workerRef.current = null;
        mainThreadBridgeRef.current?.terminate();
        mainThreadBridgeRef.current = null;
      }, 0);
    };

    if (
      canvasRef.current &&
      !workerRef.current &&
      !mainThreadBridgeRef.current
    ) {
      const canvas = canvasRef.current;
      logRdpSubAppEvent("debug", "rdp.worker.init.started", {
        hasCanvas: true,
        hasTransferControlToOffscreen:
          typeof canvas.transferControlToOffscreen === "function",
        preferMainThreadFallback: isLinux,
      });

      const createMainThreadBridge = (reason: string) => {
        try {
          mainThreadBridgeRef.current = new RdpMainThreadBridge(canvas, {
            onBridgeState: (event) =>
              handleRendererMessage({
                type: "bridge-state",
                sessionId: event.sessionId,
                state: event.state,
                details: event.details,
              }),
            onWireEvent: (sessionId, payload) =>
              handleRendererMessage({
                type: "wire-event",
                sessionId,
                payload,
              }),
            onFramePresented: (sessionId, frameVersion, performance) =>
              handleRendererMessage({
                type: "frame-presented",
                sessionId,
                frameVersion,
                presentedFrames: performance.presentedFrames,
                receivedFrames: performance.receivedFrames,
                droppedFrames: performance.droppedFrames,
                queueDepthMax: performance.queueDepthMax,
                renderDurationMs: performance.renderDurationMs,
                surfaceWidth: performance.surfaceWidth,
                surfaceHeight: performance.surfaceHeight,
              }),
            onDiagnostic: (level, event, fields, sessionId) =>
              handleRendererMessage({
                type: "diagnostic",
                level,
                event,
                sessionId,
                fields,
              }),
          });
          logRdpSubAppEvent("debug", "rdp.renderer.fallback.ready", {
            reason,
            rendererMode: "main-thread",
          });
          return true;
        } catch (error) {
          logRdpSubAppEvent("error", "rdp.renderer.fallback.failed", {
            reason,
            error: getLogError(
              error,
              "rdp_renderer_fallback_failed",
              "RDP renderer fallback failed",
            ),
          });
          return false;
        }
      };

      // Linux Tauri 使用 WebKitGTK，部分发行版会在 Worker 内创建 WebGL 时失败。
      // 一旦真实 canvas 被 transferControlToOffscreen() 转移，主线程就无法再复用它做回退渲染。
      // 因此 Linux 先固定走主线程 WebGL fallback，避免“Worker 初始化失败后无法恢复”的空白状态。
      if (isLinux && createMainThreadBridge("linux_webkitgtk")) {
        return scheduleRendererCleanup;
      }

      try {
        const offscreen = canvas.transferControlToOffscreen();
        canvasTransferredRef.current = true;
        const worker = new Worker(new URL("./rdp.worker.ts", import.meta.url), {
          type: "module",
        });

        worker.onmessage = (event: MessageEvent<RdpWorkerMessage>) => {
          handleRendererMessage(event.data);
        };

        worker.onerror = (event) => {
          logRdpSubAppEvent("error", "rdp.worker.runtime.error", {
            error: {
              code: "rdp_worker_runtime_error",
              message: "RDP renderer worker failed",
              detail: event.message,
            },
            lineno: event.lineno,
            colno: event.colno,
          });
        };
        worker.onmessageerror = () => {
          logRdpSubAppEvent("warn", "rdp.worker.message.failed", {
            error: {
              code: "rdp_worker_message_failed",
              message: "RDP renderer worker message failed",
            },
          });
        };
        worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
        workerRef.current = worker;
      } catch (error) {
        logRdpSubAppEvent("error", "rdp.worker.init.failed", {
          hasTransferControlToOffscreen:
            typeof canvas.transferControlToOffscreen === "function",
          error: getLogError(
            error,
            "rdp_worker_initialization_failed",
            "RDP renderer worker initialization failed",
          ),
        });
        if (!canvasTransferredRef.current) {
          createMainThreadBridge("worker_init_failed");
        }
      }
    }
    return scheduleRendererCleanup;
  }, [handleRendererMessage, isLinux]);

  useEffect(() => {
    pendingMouseMoveRef.current = null;
    if (mouseMoveRafRef.current !== null) {
      window.cancelAnimationFrame(mouseMoveRafRef.current);
      mouseMoveRafRef.current = null;
    }
    const cancel = scheduleDeferredTask(() => {
      postRendererControl({
        type: "set-active",
        sessionId: activeSessionId,
      });
      resetPresentedFpsSampler(activeSessionId);
    });
    return cancel;
  }, [activeSessionId, postRendererControl, resetPresentedFpsSampler]);

  useEffect(() => {
    return () => {
      pendingMouseMoveRef.current = null;
      if (mouseMoveRafRef.current !== null) {
        window.cancelAnimationFrame(mouseMoveRafRef.current);
        mouseMoveRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const runtime = presentedFpsRuntimeRef.current;

    /**
     * 当前 FPS 是“可见呈现估算值”：
     * 1. 仅在窗口可见、桥接已打开且活动会话画面版本实际变化时计数；
     * 2. 它比 worker 内部的提交次数更接近用户看到的画面变化频率；
     * 3. 但它仍无法观测 WebView/Tauri 宿主合成、系统 VSync、显示器刷新和遮挡后的最终上屏结果，
     *    因此不是严格意义上的“用户肉眼实际看到的真实 FPS”。
     */
    const tick = (now: number) => {
      const sessionId = activeSessionId;
      if (PERFORMANCE_TELEMETRY_ENABLED) {
        for (const tab of sessionsRef.current) {
          const streamId = tab.session.performanceStreamId;
          if (!streamId) continue;
          const tabSessionId = tab.session.sessionId;
          const renderedSize = renderedSizeBySessionRef.current[tabSessionId];
          const width = renderedSize?.width ?? tab.session.width;
          const height = renderedSize?.height ?? tab.session.height;
          const collector =
            performanceCollectorsRef.current[streamId] ??
            new RdpPerformanceCollector(
              streamId,
              performanceIntervalMsRef.current,
            );
          performanceCollectorsRef.current[streamId] = collector;
          collector.flushIfDue(now, width, height, {
            rendererMode: getRendererMode(),
            visibility:
              document.visibilityState === "hidden" ? "hidden" : "visible",
            resolutionClass: getRdpResolutionClass(width, height),
          });
        }
      }
      if (
        sessionId &&
        document.visibilityState === "visible" &&
        activePerf.bridgeState === "open"
      ) {
        const presentedFrameCount =
          presentedFrameCountBySessionRef.current[sessionId] ?? 0;
        if (presentedFrameCount !== runtime.lastSeenFrameVersion) {
          runtime.frameCount +=
            presentedFrameCount - runtime.lastSeenFrameVersion;
          runtime.lastSeenFrameVersion = presentedFrameCount;
        }

        if (runtime.windowStartAt === 0) {
          runtime.windowStartAt = now;
        }

        const elapsed = now - runtime.windowStartAt;
        if (elapsed >= 1000) {
          const fps = Math.round((runtime.frameCount * 1000) / elapsed);
          if (fps !== runtime.lastReportedFps) {
            updateSessionTab(sessionId, (tab) => ({
              ...tab,
              perf: { ...tab.perf, fps },
            }));
            runtime.lastReportedFps = fps;
          }
          runtime.frameCount = 0;
          runtime.windowStartAt = now;
        }
      } else if (sessionId) {
        if (runtime.lastReportedFps !== 0) {
          updateSessionTab(sessionId, (tab) => ({
            ...tab,
            perf: { ...tab.perf, fps: 0 },
          }));
          runtime.lastReportedFps = 0;
        }
        runtime.frameCount = 0;
        runtime.windowStartAt = now;
        runtime.lastSeenFrameVersion =
          presentedFrameCountBySessionRef.current[sessionId] ?? 0;
      }

      runtime.rafId = window.requestAnimationFrame(tick);
    };

    runtime.rafId = window.requestAnimationFrame(tick);
    return () => {
      if (runtime.rafId !== null) {
        window.cancelAnimationFrame(runtime.rafId);
        runtime.rafId = null;
      }
    };
  }, [
    activePerf.bridgeState,
    activeSessionId,
    activeTab,
    getRendererMode,
    updateSessionTab,
  ]);

  /** 从标签栏移除会话，并在需要时切换到邻近会话。 */
  /** 关闭标签后优先切到相邻标签，避免 activeSessionId 悬空。 */
  const removeSessionTab = useCallback(
    (sessionId: string) => {
      let nextActiveId: string | null = null;
      setSessions((prev) => {
        const index = prev.findIndex(
          (tab) => tab.session.sessionId === sessionId,
        );
        if (index === -1) return prev;
        const nextTabs = prev.filter(
          (tab) => tab.session.sessionId !== sessionId,
        );
        nextActiveId =
          nextTabs[index]?.session.sessionId ??
          nextTabs[index - 1]?.session.sessionId ??
          nextTabs[0]?.session.sessionId ??
          null;
        return nextTabs;
      });
      setActiveSessionId((current) =>
        current === sessionId ? nextActiveId : current,
      );
      postRendererControl({ type: "disconnect", sessionId });
    },
    [postRendererControl],
  );

  /** 关闭最后一个标签前先同步清空本地状态，避免统一关窗时重复断开同一会话。 */
  const clearLastSessionTab = useCallback(
    (sessionId: string) => {
      setSessions([]);
      setActiveSessionId(null);
      sessionsRef.current = [];
      postRendererControl({ type: "disconnect", sessionId });
    },
    [postRendererControl],
  );

  const resizeRuntimeRef = useRef<{
    timer: number | null;
    inFlight: boolean;
    pending: { width: number; height: number } | null;
    lastRequested: { width: number; height: number } | null;
  }>({
    timer: null,
    inFlight: false,
    pending: null,
    lastRequested: null,
  });

  /** 统一执行后端的尺寸更新。 */
  const flushResize = useCallback(() => {
    const rr = resizeRuntimeRef.current;
    if (!activeTab || rr.inFlight || !rr.pending) return;

    const { width, height } = rr.pending;

    // 过滤重复的相同尺寸请求
    if (
      rr.lastRequested?.width === width &&
      rr.lastRequested?.height === height
    ) {
      rr.pending = null;
      return;
    }

    rr.inFlight = true;
    rr.lastRequested = { width, height };
    rr.pending = null;

    void resizeRdpSession(activeTab.session.sessionId, width, height, {
      operationId: activeTab.operationId,
    })
      .then((next) => {
        updateSessionTab(activeTab.session.sessionId, (tab) => ({
          ...tab,
          session: next,
        }));
      })
      .catch(() => {})
      .finally(() => {
        rr.inFlight = false;
        // 如果在执行期间又有新的尺寸需求，递归执行
        if (rr.pending) {
          flushResize();
        }
      });
  }, [activeTab, updateSessionTab]);

  /** 对窗口跟随模式的 resize 做节流收敛。 */
  const scheduleResize = useCallback(
    (width: number, height: number) => {
      const rr = resizeRuntimeRef.current;
      rr.pending = { width, height };

      if (rr.timer !== null) {
        window.clearTimeout(rr.timer);
      }

      // 增加 60ms 的稳定期，防止拖拽过程中的中间态导致闪屏
      rr.timer = window.setTimeout(() => {
        rr.timer = null;
        flushResize();
      }, 60);
    },
    [flushResize],
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !activeTab) return;
    const observer = new ResizeObserver((entries) => {
      refreshCachedFrameRect();
      const entry = entries[0];
      if (!entry || activeTab.profile.resolutionMode !== "window_sync") return;
      if (activePerf.bridgeState !== "open") return;
      const width = Math.max(Math.floor(entry.contentRect.width), 320);
      const height = Math.max(Math.floor(entry.contentRect.height), 200);
      scheduleResize(width, height);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [
    activePerf.bridgeState,
    activeTab,
    activeTab?.profile.resolutionMode,
    refreshCachedFrameRect,
    scheduleResize,
  ]);

  /** 在桥接刚进入 open 状态时主动同步一次当前视口尺寸，避免错过首次 ResizeObserver 回调。 */
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !activeTab) return;
    if (activeTab.profile.resolutionMode !== "window_sync") return;
    if (activePerf.bridgeState !== "open") return;

    const rect = surface.getBoundingClientRect();
    const width = Math.max(Math.floor(rect.width), 320);
    const height = Math.max(Math.floor(rect.height), 200);
    scheduleResize(width, height);
  }, [
    activePerf.bridgeState,
    activeTab,
    activeTab?.profile.resolutionMode,
    scheduleResize,
  ]);

  useEffect(() => {
    handleSurfaceBlur();
    if (!activeTab) {
      return;
    }
    if (!canAttachBridge(activeTab.session)) {
      logRdpSubAppEvent("warn", "rdp.bridge.connect.skipped", {
        operationId: activeTab.operationId,
        sessionId: activeTab.session.sessionId,
        reason: "session_not_attachable",
        sessionState: activeTab.session.state,
        rendererMode: getRendererMode(),
        bridgeState: activeTab.perf.bridgeState,
        ...getSafeWsUrlFields(activeTab.session.wsUrl),
      });
      postRendererControl({
        type: "disconnect",
        sessionId: activeTab.session.sessionId,
      });
      return;
    }

    if (getRendererMode() === "none") {
      logRdpSubAppEvent("warn", "rdp.bridge.connect.skipped", {
        operationId: activeTab.operationId,
        sessionId: activeTab.session.sessionId,
        reason: "renderer_unavailable",
        sessionState: activeTab.session.state,
        rendererMode: "none",
        bridgeState: activeTab.perf.bridgeState,
        ...getSafeWsUrlFields(activeTab.session.wsUrl),
      });
      return;
    }

    logRdpSubAppEvent("debug", "rdp.bridge.connect.dispatch", {
      operationId: activeTab.operationId,
      sessionId: activeTab.session.sessionId,
      sessionState: activeTab.session.state,
      rendererMode: getRendererMode(),
      bridgeState: activeTab.perf.bridgeState,
      ...getSafeWsUrlFields(activeTab.session.wsUrl),
    });
    postRendererControl({
      type: "connect",
      sessionId: activeTab.session.sessionId,
      url: activeTab.session.wsUrl,
    });

    return () => {
      handleSurfaceBlur();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, activeTab?.session.sessionId, activeTab?.session.wsUrl]);

  /** 子应用只消费已保存的 RDP Profile，不再承担 Profile 配置编辑。 */
  const connectFromProfile = useCallback(
    async (profile: RdpProfile, operationId = createOperationId()) => {
      setGlobalError("");
      try {
        let initialSize: { width: number; height: number } | undefined;
        if (profile.resolutionMode === "window_sync") {
          initialSize =
            (await waitForStableSurfaceViewport(surfaceRef.current)) ??
            undefined;
          if (!initialSize) {
            throw new Error(t("rdp.error.viewportUnavailable"));
          }
        }
        const created = await createRdpSession(profile.id, initialSize, {
          operationId,
        });
        const connected = await connectRdpSession(created.sessionId, {
          operationId,
        });
        const newTab: RdpSessionTab = {
          session: connected,
          profile,
          operationId,
          statusText: t("rdp.status.waitingBridge"),
          errorMessage: "",
          perf: { ...EMPTY_PERF },
          remoteCursor: "crosshair",
        };
        setSessions((prev) => [...prev, newTab]);
        setActiveSessionId(connected.sessionId);
      } catch (error) {
        setGlobalError(error instanceof Error ? error.message : String(error));
      }
    },
    [t],
  );

  /** 主窗口双击 Profile 后只传 profileId，子应用负责解析并真正建立连接。 */
  const handleConnectProfileById = useCallback(
    async (profileId: string) => {
      const operationId = createOperationId();
      const resolved = (await listRdpProfiles({ operationId })).find(
        (item) => item.id === profileId,
      );
      if (!resolved) {
        logRdpSubAppEvent("warn", "rdp.profile.resolve.failed", {
          operationId,
          profileId,
          error: {
            code: "rdp_profile_not_found",
            message: "RDP profile was not found",
          },
        });
        setGlobalError(t("rdp.error.profileNotFound"));
        return;
      }
      await connectFromProfile(resolved, operationId);
    },
    [connectFromProfile, t],
  );

  /** 关闭窗口前统一断开全部会话，避免后端运行时残留。 */
  const cleanupAllSessions = useCallback(async () => {
    if (cleanupInFlightRef.current) {
      await cleanupInFlightRef.current;
      return;
    }

    const task = (async () => {
      const currentSessions = [...sessionsRef.current];
      if (currentSessions.length === 0) return;

      await Promise.allSettled(
        currentSessions.map(async ({ session }) => {
          const operationId =
            sessionsRef.current.find(
              (tab) => tab.session.sessionId === session.sessionId,
            )?.operationId ?? createOperationId();
          try {
            await flushPerformanceCollector(session.sessionId);
            await disconnectRdpSession(session.sessionId, { operationId });
          } catch {
            // 忽略单个会话断开失败，尽量继续清理剩余会话。
          } finally {
            postRendererControl({
              type: "disconnect",
              sessionId: session.sessionId,
            });
          }
        }),
      );

      setSessions([]);
      setActiveSessionId(null);
      sessionsRef.current = [];
    })();

    cleanupInFlightRef.current = task;
    try {
      await task;
    } finally {
      cleanupInFlightRef.current = null;
    }
  }, [flushPerformanceCollector, postRendererControl]);

  /** 统一执行子应用关闭，确保只触发一次异步清理。 */
  const requestWindowClose = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    await cleanupAllSessions();
    await getCurrentWindow()
      .close()
      .catch(() => {});
  }, [cleanupAllSessions]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SUBAPP_LIFECYCLE_CHANNEL);
    channel.onmessage = (event) => {
      const payload = event.data as SubAppLifecycleMessage | undefined;
      if (!payload) return;
      if (payload.type === "subapp:main-shutdown") {
        void requestWindowClose();
        return;
      }
      if (
        payload.type === "subapp:close-request" &&
        payload.id === id &&
        payload.label === windowLabel
      ) {
        void requestWindowClose();
        return;
      }
      if (
        payload.type === "subapp:rdp-connect" &&
        payload.target.id === id &&
        payload.target.label === windowLabel
      ) {
        void handleConnectProfileById(payload.profileId);
      }
    };
    const onUnload = () => {
      channel.postMessage({
        type: "subapp:closed",
        id,
        label: windowLabel,
        source: "subapp",
      } satisfies SubAppLifecycleMessage);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      channel.close();
    };
  }, [handleConnectProfileById, id, requestWindowClose, windowLabel]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    // 直接关闭子应用窗口时先断开全部 RDP 会话，避免运行时残留影响后续再次连接。
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closingRef.current) return;
        event.preventDefault();
        await requestWindowClose();
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [requestWindowClose]);

  /** 主动关闭某个会话标签，并同步断开后端会话。 */
  async function handleCloseSession(sessionId: string) {
    setGlobalError("");
    const isLastSession =
      sessionsRef.current.length === 1 &&
      sessionsRef.current[0]?.session.sessionId === sessionId;
    const operationId =
      sessionsRef.current.find((tab) => tab.session.sessionId === sessionId)
        ?.operationId ?? createOperationId();
    try {
      await flushPerformanceCollector(sessionId);
      await disconnectRdpSession(sessionId, { operationId });
      if (isLastSession) {
        clearLastSessionTab(sessionId);
        await requestWindowClose();
        return;
      }
      removeSessionTab(sessionId);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleActivateSession(sessionId: string) {
    setActiveSessionId(sessionId);
  }

  /** 发送 RDP 输入前先确认当前仍有活动会话。 */
  function sendInput(input: RdpInputEvent) {
    if (!activeTab) return;
    void sendRdpInput(activeTab.session.sessionId, input).catch(() => {});
  }

  /** 将高频鼠标移动合并到下一帧，只发送最新坐标。 */
  function scheduleMouseMoveInput(sessionId: string, input: RdpInputEvent) {
    pendingMouseMoveRef.current = { sessionId, input };
    if (mouseMoveRafRef.current !== null) return;
    mouseMoveRafRef.current = window.requestAnimationFrame(() => {
      mouseMoveRafRef.current = null;
      const pending = pendingMouseMoveRef.current;
      pendingMouseMoveRef.current = null;
      if (!pending) return;
      void sendRdpInput(pending.sessionId, pending.input).catch(() => {});
    });
  }

  /** 前端只做事件采集与字段透传，Unicode / 扫描码分流由后端运行时统一决定。 */
  function buildKeyboardInput(
    kind: "key_down" | "key_up",
    event: React.KeyboardEvent<HTMLDivElement>,
  ): RdpInputEvent {
    return {
      kind,
      text: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    };
  }

  /** 记录按下键集合，确保 keydown/keyup 成对发给远端。 */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    event.preventDefault();
    pressedKeysRef.current.add(event.code);
    sendInput(buildKeyboardInput("key_down", event));
  }

  /** 键释放时同步移除本地按下状态。 */
  function handleKeyUp(event: React.KeyboardEvent<HTMLDivElement>) {
    event.preventDefault();
    pressedKeysRef.current.delete(event.code);
    sendInput(buildKeyboardInput("key_up", event));
  }

  /** 远端画面失焦时补发所有 key_up，避免修饰键在远端会话中卡住。 */
  function handleSurfaceBlur() {
    if (!activeTab || pressedKeysRef.current.size === 0) return;
    for (const code of pressedKeysRef.current) {
      void sendRdpInput(activeTab.session.sessionId, {
        kind: "key_up",
        code,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      }).catch(() => {});
    }
    pressedKeysRef.current.clear();
  }

  /**
   * 将浏览器坐标映射到远端桌面像素坐标。
   */
  function handleMouse(
    kind: string,
    event: React.MouseEvent<HTMLDivElement> | React.WheelEvent<HTMLDivElement>,
  ) {
    if (!activeTab) return;
    if ("currentTarget" in event) {
      event.currentTarget.focus();
    }

    const frameRect = cachedFrameRectRef.current ?? refreshCachedFrameRect();
    const localX = frameRect ? event.clientX - frameRect.left : 0;
    const localY = frameRect ? event.clientY - frameRect.top : 0;

    const x = frameRect
      ? Math.max(
          0,
          Math.min(
            frameRect.remoteWidth,
            (localX / frameRect.width) * frameRect.remoteWidth,
          ),
        )
      : 0;
    const y = frameRect
      ? Math.max(
          0,
          Math.min(
            frameRect.remoteHeight,
            (localY / frameRect.height) * frameRect.remoteHeight,
          ),
        )
      : 0;

    const input = {
      kind,
      x,
      y,
      button: "button" in event ? event.button : undefined,
      deltaX: "deltaX" in event ? event.deltaX : undefined,
      deltaY: "deltaY" in event ? event.deltaY : undefined,
    };

    if (kind === "mouse_move") {
      scheduleMouseMoveInput(activeTab.session.sessionId, input);
      return;
    }
    sendInput(input);
  }

  /** 响应运行时给出的证书决策请求。 */
  async function handleCertDecision(accept: boolean) {
    if (!activeTab) return;
    try {
      const next = await decideRdpCertificate(
        activeTab.session.sessionId,
        accept,
        { operationId: activeTab.operationId },
      );
      updateSessionTab(activeTab.session.sessionId, (tab) => ({
        ...tab,
        session: next,
      }));
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : String(error));
    }
  }

  /** 切换当前活动会话的本地静音状态。 */
  async function handleToggleAudioMute() {
    if (!activeTab || !canToggleAudio) return;
    const nextMuted = !activeTab.session.audioMuted;
    try {
      await setRdpAudioMuted(activeTab.session.sessionId, nextMuted, {
        operationId: activeTab.operationId,
      });
      updateSessionTab(activeTab.session.sessionId, (tab) => ({
        ...tab,
        session: {
          ...tab.session,
          audioMuted: nextMuted,
        },
      }));
    } catch (error) {
      logRdpSubAppEvent("warn", "rdp.audio.mute.failed", {
        operationId: activeTab.operationId,
        sessionId: activeTab.session.sessionId,
        error: getLogError(
          error,
          "rdp_audio_mute_failed",
          "RDP audio mute update failed",
        ),
      });
    }
  }

  return (
    <div
      ref={shellRef}
      className={`subapp-shell rdp-subapp-shell ${isFullscreen ? "is-fullscreen" : ""}`.trim()}
      data-page="rdp-subapp"
    >
      {!isMac && !isFullscreen ? (
        <SubAppTitleBar title="FluxTerm" t={t} />
      ) : null}
      <main className="subapp-content rdp-subapp-content">
        <article className="rdp-layout" data-ui="rdp-layout">
          {/* 顶部栏拆成“可滚动标签区 + 固定操作区”，
              避免配置入口跟随标签一起被横向滚走。 */}
          <div className="rdp-tabbar" data-slot="rdp-tabbar">
            <div className="rdp-tabbar-scroll" data-slot="rdp-tablist">
              {sessions.map((tab) => {
                const isActive = tab.session.sessionId === activeSessionId;
                const isDisconnected = tab.session.state === "disconnected";
                const tabLabel = isDisconnected
                  ? `${getProfileDisplayName(tab.profile, t)} · ${t("rdp.status.sessionDisconnected")}`
                  : getProfileDisplayName(tab.profile, t);
                return (
                  <button
                    key={tab.session.sessionId}
                    type="button"
                    className={`rdp-tab ${isActive ? "is-active" : ""} ${isDisconnected ? "is-disconnected" : ""}`.trim()}
                    data-ui="rdp-tab"
                    onClick={() => handleActivateSession(tab.session.sessionId)}
                  >
                    <span className={`rdp-tab-dot is-${tab.session.state}`} />
                    <span className="rdp-tab-copy">{tabLabel}</span>
                    <span
                      className="rdp-tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleCloseSession(tab.session.sessionId);
                      }}
                    >
                      ×
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="rdp-tabbar-actions" data-slot="rdp-tabbar-actions">
              <Tooltip
                content={
                  <span className="rdp-tooltip-shortcut">
                    {t("rdp.tooltip.fullscreenShortcut")}
                  </span>
                }
                placement="bottom"
                disabled={!canToggleFullscreen}
              >
                <button
                  type="button"
                  className="rdp-fullscreen-toggle"
                  data-ui="rdp-fullscreen-toggle"
                  onClick={() => void toggleFullscreen()}
                  disabled={!canToggleFullscreen}
                >
                  {isFullscreen
                    ? t("rdp.actions.exitFullscreen")
                    : t("rdp.actions.enterFullscreen")}
                </button>
              </Tooltip>
            </div>
          </div>

          <div className="rdp-viewport" data-slot="rdp-viewport">
            {globalError ? (
              <div className="rdp-banner rdp-banner-error">{globalError}</div>
            ) : null}

            <div
              ref={surfaceRef}
              className="rdp-surface"
              data-ui="rdp-viewport-surface"
              style={{ cursor: activeTab?.remoteCursor ?? "default" }}
              tabIndex={0}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onBlur={handleSurfaceBlur}
              onFocus={() => void syncLocalClipboardToRemote()}
              onMouseEnter={() => void syncLocalClipboardToRemote()}
              onMouseDown={(event) => handleMouse("mouse_down", event)}
              onMouseUp={(event) => handleMouse("mouse_up", event)}
              onMouseMove={(event) => handleMouse("mouse_move", event)}
              onWheel={(event) => handleMouse("wheel", event)}
            >
              {/* 无活动会话时保留 OffscreenCanvas 绑定，但隐藏 DOM canvas，
                  避免最后一帧在空态 overlay 下形成残留黑块。 */}
              <canvas
                ref={canvasRef}
                className={`rdp-canvas ${activeTab ? "" : "is-hidden"}`.trim()}
                style={{
                  objectFit: activeTab
                    ? getCanvasObjectFit(activeTab.profile.displayStrategy)
                    : "contain",
                }}
              />

              {activeTab?.errorMessage ? (
                <div
                  className="rdp-overlay rdp-stage-message"
                  data-ui="rdp-error"
                >
                  <strong>{t("rdp.status.error")}</strong>
                  <span>{activeTab.errorMessage}</span>
                </div>
              ) : showDisconnectedOverlay ? (
                <div
                  className="rdp-overlay rdp-stage-message"
                  data-ui="rdp-disconnected"
                >
                  <strong>{t("rdp.status.sessionDisconnected")}</strong>
                </div>
              ) : null}

              {activeTab?.session.certificatePrompt ? (
                <div
                  className="rdp-overlay rdp-cert-dialog"
                  data-ui="rdp-cert-dialog"
                >
                  <strong>{t("rdp.cert.title")}</strong>
                  <p>{activeTab.session.certificatePrompt.subject}</p>
                  <p>{activeTab.session.certificatePrompt.fingerprint}</p>
                  <div className="rdp-cert-actions">
                    <button
                      type="button"
                      onClick={() => void handleCertDecision(false)}
                    >
                      {t("rdp.cert.reject")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCertDecision(true)}
                    >
                      {t("rdp.cert.accept")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          {/* 底栏默认展示状态/活动会话/指标三块信息，
              窄宽度下通过 CSS 收敛成只显示左侧状态。 */}
          <div className="rdp-statusbar" data-slot="rdp-statusbar">
            <div
              className="rdp-footer-section rdp-footer-section-left"
              data-slot="rdp-statusbar-left"
            >
              <p className="rdp-status-line" data-ui="rdp-status">
                {statusLineText}
              </p>
            </div>
            <div
              className="rdp-footer-section rdp-footer-section-center"
              data-slot="rdp-statusbar-center"
            >
              <span className="rdp-session-counter">
                {t("rdp.header.activeSessions", {
                  value: String(sessions.length),
                })}
              </span>
            </div>
            <div
              className="rdp-footer-section rdp-footer-section-right rdp-metrics"
              data-slot="rdp-statusbar-right"
              data-ui="rdp-metrics"
            >
              <span>
                {t("rdp.metrics.resolution", {
                  value: getSessionResolutionValue(activeTab?.session ?? null),
                })}
              </span>
              <button
                type="button"
                className="rdp-audio-toggle"
                data-ui="rdp-audio-toggle"
                data-state={activeTab?.session.audioState ?? "idle"}
                aria-label={
                  activeTab?.session.audioMuted
                    ? t("rdp.audio.actions.unmute")
                    : t("rdp.audio.actions.mute")
                }
                aria-pressed={activeTab?.session.audioMuted ?? false}
                disabled={!canToggleAudio}
                onClick={() => void handleToggleAudioMute()}
              >
                {activeTab?.session.audioMuted ? (
                  <FiVolumeX aria-hidden="true" />
                ) : (
                  <FiVolume2 aria-hidden="true" />
                )}
              </button>
              <div
                ref={statusPanelRef}
                className="rdp-status-panel-anchor"
                data-slot="rdp-status-panel-anchor"
              >
                <button
                  type="button"
                  className="rdp-status-trigger"
                  data-ui="rdp-status-trigger"
                  data-tone={statusIndicatorTone}
                  aria-label={t("rdp.statusPanel.triggerAriaLabel")}
                  aria-haspopup="dialog"
                  aria-expanded={statusPanelOpen}
                  onClick={() => setStatusPanelOpen((open) => !open)}
                >
                  <FiActivity aria-hidden="true" />
                  <span className="rdp-status-trigger-dot" aria-hidden="true" />
                </button>
                {statusPanelOpen ? (
                  <div
                    className="rdp-status-panel"
                    data-ui="rdp-status-panel"
                    role="dialog"
                    aria-label={t("rdp.statusPanel.title")}
                  >
                    <div className="rdp-status-panel-header">
                      <span>{t("rdp.statusPanel.title")}</span>
                      <button
                        type="button"
                        className="rdp-status-panel-close"
                        data-ui="rdp-status-panel-close"
                        aria-label={t("rdp.statusPanel.closeAriaLabel")}
                        onClick={() => setStatusPanelOpen(false)}
                      >
                        <FiX aria-hidden="true" />
                      </button>
                    </div>
                    <div
                      className="rdp-status-panel-row"
                      data-slot="rdp-status-frame-rate"
                    >
                      <span className="rdp-status-panel-label">
                        <FiActivity aria-hidden="true" />
                        <span>{t("rdp.statusPanel.frameRate")}</span>
                      </span>
                      <strong>
                        {t("rdp.statusPanel.frameRateValue", {
                          value: String(activePerf.fps),
                        })}
                      </strong>
                    </div>
                    <div
                      className="rdp-status-panel-row"
                      data-slot="rdp-status-clipboard"
                    >
                      <span className="rdp-status-panel-label">
                        <FiClipboard aria-hidden="true" />
                        <span>{t("rdp.statusPanel.clipboard")}</span>
                      </span>
                      <strong>{clipboardStatusValue}</strong>
                    </div>
                    <div
                      className="rdp-status-panel-row"
                      data-slot="rdp-status-audio"
                    >
                      <span className="rdp-status-panel-label">
                        {activeTab?.session.audioMuted ? (
                          <FiVolumeX aria-hidden="true" />
                        ) : (
                          <FiVolume2 aria-hidden="true" />
                        )}
                        <span>{t("rdp.statusPanel.audio")}</span>
                      </span>
                      <strong>{audioStatusValue}</strong>
                    </div>
                    <div
                      className="rdp-status-panel-legend"
                      data-slot="rdp-status-legend"
                    >
                      <div className="rdp-status-panel-legend-title">
                        {t("rdp.statusPanel.legendTitle")}
                      </div>
                      <div className="rdp-status-panel-legend-list">
                        {(
                          [
                            "normal",
                            "degraded",
                            "error",
                          ] as RdpStatusIndicatorTone[]
                        ).map((tone) => (
                          <div
                            key={tone}
                            className="rdp-status-panel-legend-item"
                            data-tone={tone}
                          >
                            <span
                              className="rdp-status-panel-legend-dot"
                              aria-hidden="true"
                            />
                            <span>{getStatusIndicatorToneLabel(tone, t)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </article>
      </main>
    </div>
  );
}
