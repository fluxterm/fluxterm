/**
 * Main 窗口外观副作用管理。
 * 职责：同步主题变量、页面语言、背景媒体以及浮动窗口首帧显示时机。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import { buildThemeCssVars } from "@/main/theme/buildThemeCssVars";
import { resolveBackgroundAssetUrl } from "@/features/backgrounds/core/assetResolver";
import type { Locale } from "@/i18n";
import type { ThemeId } from "@/types";
import type { ThemePreset } from "@/main/theme/themeContracts";
import type {
  BackgroundMediaType,
  BackgroundRenderMode,
  BackgroundVideoReplayMode,
} from "@/constants/backgroundMedia";
import { extractErrorMessage } from "@/shared/errors/appError";
import { warn } from "@/shared/logging/telemetry";
import {
  resolveDetachedBackgroundImageStyle,
  waitForDetachedBackgroundMediaReady,
  waitForNextPaint,
} from "@/shared/detachedWindowAppearance";

type UseMainAppearanceOptions = {
  locale: Locale;
  themeId: ThemeId;
  activeThemePreset: ThemePreset;
  settingsLoaded: boolean;
  isBackgroundMediaRequested: boolean;
  backgroundImageAsset: string;
  backgroundImageSurfaceAlpha: number;
  backgroundMediaType: BackgroundMediaType;
  backgroundRenderMode: BackgroundRenderMode;
  backgroundVideoReplayMode: BackgroundVideoReplayMode;
  backgroundVideoReplayIntervalSec: number;
  shouldDeferFloatingWindowReveal: boolean;
};

type UseMainAppearanceState = {
  activeBackgroundMediaType: BackgroundMediaType;
  backgroundMediaBlobUrl: string;
  backgroundVideoRef: React.RefObject<HTMLVideoElement | null>;
  handleBackgroundVideoEnded: () => void;
};

/** 管理 Main 窗口主题、背景媒体与浮动窗口显示时机。 */
export default function useMainAppearance({
  locale,
  themeId,
  activeThemePreset,
  settingsLoaded,
  isBackgroundMediaRequested,
  backgroundImageAsset,
  backgroundImageSurfaceAlpha,
  backgroundMediaType,
  backgroundRenderMode,
  backgroundVideoReplayMode,
  backgroundVideoReplayIntervalSec,
  shouldDeferFloatingWindowReveal,
}: UseMainAppearanceOptions): UseMainAppearanceState {
  const [floatingWindowAppearanceReady, setFloatingWindowAppearanceReady] =
    useState(!shouldDeferFloatingWindowReveal);
  const floatingWindowShownRef = useRef(false);
  const backgroundVideoRef = useRef<HTMLVideoElement | null>(null);
  const backgroundVideoReplayTimerRef = useRef<number | null>(null);
  const [backgroundMediaBlobUrl, setBackgroundMediaBlobUrl] = useState("");
  const [activeBackgroundMediaType, setActiveBackgroundMediaType] =
    useState<BackgroundMediaType>("image");

  useEffect(() => {
    const cssVars = buildThemeCssVars(activeThemePreset);
    const root = document.documentElement;
    root.dataset.theme = themeId;
    Object.entries(cssVars).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });
  }, [themeId, activeThemePreset]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--chrome-surface-alpha",
      `${Math.round(backgroundImageSurfaceAlpha * 100)}%`,
    );
  }, [backgroundImageSurfaceAlpha]);

  useEffect(() => {
    let disposed = false;
    let blobUrl: string | null = null;
    let revokeBlobUrl = () => {};
    const root = document.documentElement;
    const scheduleFloatingWindowReveal = () => {
      scheduleDeferredTask(() => {
        setFloatingWindowAppearanceReady(true);
      });
    };
    const applyBackgroundImageMode = (enabled: boolean) => {
      root.dataset.backgroundImageMode = enabled ? "on" : "off";
    };
    const applyDefaultBackground = () => {
      root.style.setProperty("--app-bg-image", "none");
      root.style.setProperty("--app-bg-overlay", "none");
      root.style.setProperty("--app-bg-image-size", "cover");
      root.style.setProperty("--app-bg-image-repeat", "no-repeat");
      root.style.setProperty("--app-bg-image-position", "center center");
      scheduleDeferredTask(() => {
        setBackgroundMediaBlobUrl("");
        setActiveBackgroundMediaType("image");
      });
      applyBackgroundImageMode(false);
    };

    if (!settingsLoaded) {
      return;
    }

    if (!isBackgroundMediaRequested) {
      applyDefaultBackground();
      if (shouldDeferFloatingWindowReveal) {
        scheduleFloatingWindowReveal();
      }
      return;
    }

    const overlay =
      "linear-gradient(0deg, rgba(7, 10, 14, 0.42), rgba(7, 10, 14, 0.42))";
    root.style.setProperty("--app-bg-overlay", overlay);

    void (async () => {
      try {
        const resolvedAsset =
          await resolveBackgroundAssetUrl(backgroundImageAsset);
        blobUrl = resolvedAsset.url;
        revokeBlobUrl = resolvedAsset.revoke;
        if (disposed) {
          resolvedAsset.revoke();
          return;
        }
        if (shouldDeferFloatingWindowReveal) {
          await waitForDetachedBackgroundMediaReady(
            blobUrl,
            backgroundMediaType,
          );
          if (disposed) {
            resolvedAsset.revoke();
            return;
          }
        }
        const style = resolveDetachedBackgroundImageStyle(backgroundRenderMode);
        root.style.setProperty("--app-bg-image-size", style.size);
        root.style.setProperty("--app-bg-image-repeat", style.repeat);
        root.style.setProperty("--app-bg-image-position", style.position);
        const resolvedBlobUrl = blobUrl;
        if (backgroundMediaType === "video") {
          root.style.setProperty("--app-bg-image", "none");
          scheduleDeferredTask(() => {
            setBackgroundMediaBlobUrl(resolvedBlobUrl);
            setActiveBackgroundMediaType("video");
          });
        } else {
          root.style.setProperty("--app-bg-image", `url("${resolvedBlobUrl}")`);
          scheduleDeferredTask(() => {
            setBackgroundMediaBlobUrl("");
            setActiveBackgroundMediaType("image");
          });
        }
        applyBackgroundImageMode(true);
        if (shouldDeferFloatingWindowReveal) {
          await waitForNextPaint(2);
          if (disposed) return;
          scheduleFloatingWindowReveal();
        }
      } catch (error) {
        if (disposed) return;
        applyDefaultBackground();
        if (shouldDeferFloatingWindowReveal) {
          await waitForNextPaint(2);
          if (disposed) return;
          scheduleFloatingWindowReveal();
        }
        void warn(
          JSON.stringify({
            event: "settings.background.image.load.failed",
            asset: backgroundImageAsset,
            error: extractErrorMessage(error),
          }),
        );
      }
    })();

    return () => {
      disposed = true;
      if (!blobUrl) return;
      revokeBlobUrl();
    };
  }, [
    isBackgroundMediaRequested,
    backgroundImageAsset,
    backgroundRenderMode,
    backgroundMediaType,
    settingsLoaded,
    shouldDeferFloatingWindowReveal,
    themeId,
  ]);

  useEffect(() => {
    const video = backgroundVideoRef.current;
    if (!video || !backgroundMediaBlobUrl) return;
    backgroundVideoReplayTimerRef.current = null;
    const syncVisibility = () => {
      if (document.visibilityState !== "visible") {
        video.pause();
        return;
      }
      void video.play().catch(() => {});
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      if (backgroundVideoReplayTimerRef.current) {
        window.clearTimeout(backgroundVideoReplayTimerRef.current);
        backgroundVideoReplayTimerRef.current = null;
      }
    };
  }, [backgroundMediaBlobUrl]);

  useEffect(() => {
    if (!backgroundVideoReplayTimerRef.current) return;
    window.clearTimeout(backgroundVideoReplayTimerRef.current);
    backgroundVideoReplayTimerRef.current = null;
  }, [backgroundVideoReplayMode, backgroundVideoReplayIntervalSec]);

  useLayoutEffect(() => {
    if (!shouldDeferFloatingWindowReveal) return;
    const root = document.documentElement;
    root.dataset.windowSurface = "detached";
    root.dataset.windowAppearance = floatingWindowAppearanceReady
      ? "ready"
      : "pending";
    document.body.style.visibility = floatingWindowAppearanceReady
      ? "visible"
      : "hidden";
    return () => {
      delete root.dataset.windowSurface;
      delete root.dataset.windowAppearance;
      document.body.style.visibility = "";
    };
  }, [floatingWindowAppearanceReady, shouldDeferFloatingWindowReveal]);

  useEffect(() => {
    if (!shouldDeferFloatingWindowReveal) return;
    if (!floatingWindowAppearanceReady) return;
    if (floatingWindowShownRef.current) return;
    floatingWindowShownRef.current = true;
    const current = getCurrentWindow();
    void waitForNextPaint(2).then(() => {
      current
        .show()
        .then(() => current.setFocus().catch(() => {}))
        .catch(() => {});
    });
  }, [floatingWindowAppearanceReady, shouldDeferFloatingWindowReveal]);

  function handleBackgroundVideoEnded() {
    const video = backgroundVideoRef.current;
    if (!video) return;
    if (backgroundVideoReplayMode === "single") return;
    if (backgroundVideoReplayMode === "loop") {
      video.currentTime = 0;
      void video.play().catch(() => {});
      return;
    }
    if (backgroundVideoReplayTimerRef.current) {
      window.clearTimeout(backgroundVideoReplayTimerRef.current);
      backgroundVideoReplayTimerRef.current = null;
    }
    backgroundVideoReplayTimerRef.current = window.setTimeout(() => {
      const currentVideo = backgroundVideoRef.current;
      if (!currentVideo) return;
      currentVideo.currentTime = 0;
      void currentVideo.play().catch(() => {});
    }, backgroundVideoReplayIntervalSec * 1000);
  }

  return {
    activeBackgroundMediaType,
    backgroundMediaBlobUrl,
    backgroundVideoRef,
    handleBackgroundVideoEnded,
  };
}
