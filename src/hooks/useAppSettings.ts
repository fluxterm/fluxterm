/**
 * 应用基础设置持久化模块。
 * 职责：
 * 1. 读写 settings.json 配置文件。
 * 2. 管理全局界面偏好（语言、主题、背景图、默认编辑器等）。
 * 3. 负责本地 Shell 列表的初始拉取。
 * 4. 采用“内存态缓存 + 防抖异步落盘”模式。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { debug, warn } from "@/shared/logging/telemetry";
import type { Locale } from "@/i18n";
import type { LocalShellConfig, LocalShellProfile, ThemeId } from "@/types";
import { normalizeLocalShellConfig } from "@/constants/localShellConfig";
import { getGlobalConfigDir, getSettingsPath } from "@/shared/config/paths";
import { extractErrorMessage } from "@/shared/errors/appError";
import { PERSISTENCE_SAVE_DEBOUNCE_MS } from "@/constants/persistence";
import {
  clampBackgroundVideoReplayIntervalSec,
  DEFAULT_BACKGROUND_MEDIA_TYPE,
  DEFAULT_BACKGROUND_RENDER_MODE,
  DEFAULT_BACKGROUND_VIDEO_REPLAY_MODE,
  DEFAULT_BACKGROUND_VIDEO_REPLAY_INTERVAL_SEC,
  inferBackgroundMediaTypeFromAsset,
  normalizeBackgroundMediaType,
  normalizeBackgroundRenderMode,
  normalizeBackgroundVideoReplayMode,
  type BackgroundMediaType,
  type BackgroundRenderMode,
  type BackgroundVideoReplayMode,
} from "@/constants/backgroundMedia";
/** 应用全局配置结构。 */
type AppSettings = {
  version: 1;
  shellId?: string | null;
  localShellProfiles?: Record<string, LocalShellConfig>;
  locale?: Locale;
  themeId?: ThemeId;
  sftpEnabled?: boolean;
  fileDefaultEditorPath?: string | null;
  backgroundImageEnabled?: boolean;
  backgroundImageAsset?: string | null;
  backgroundImageSurfaceAlpha?: number;
  backgroundMediaType?: BackgroundMediaType;
  backgroundRenderMode?: BackgroundRenderMode;
  backgroundVideoReplayMode?: BackgroundVideoReplayMode;
  backgroundVideoReplayIntervalSec?: number;
};

/** 背景图表面透明度阈值。 */
export const MIN_BACKGROUND_IMAGE_SURFACE_ALPHA = 0;
export const MAX_BACKGROUND_IMAGE_SURFACE_ALPHA = 1;
export const DEFAULT_BACKGROUND_IMAGE_SURFACE_ALPHA = 0.52;

/** useAppSettings 返回的操作接口。 */
type UseAppSettingsResult = {
  locale: Locale;
  setLocale: React.Dispatch<React.SetStateAction<Locale>>;
  themeId: ThemeId;
  setThemeId: React.Dispatch<React.SetStateAction<ThemeId>>;
  shellId: string | null;
  setShellId: React.Dispatch<React.SetStateAction<string | null>>;
  localShellProfiles: Record<string, LocalShellConfig>;
  setLocalShellProfiles: React.Dispatch<
    React.SetStateAction<Record<string, LocalShellConfig>>
  >;
  sftpEnabled: boolean;
  setSftpEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  fileDefaultEditorPath: string;
  setFileDefaultEditorPath: React.Dispatch<React.SetStateAction<string>>;
  backgroundImageEnabled: boolean;
  setBackgroundImageEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  backgroundImageAsset: string;
  setBackgroundImageAsset: React.Dispatch<React.SetStateAction<string>>;
  backgroundImageSurfaceAlpha: number;
  setBackgroundImageSurfaceAlpha: React.Dispatch<React.SetStateAction<number>>;
  backgroundMediaType: BackgroundMediaType;
  setBackgroundMediaType: React.Dispatch<
    React.SetStateAction<BackgroundMediaType>
  >;
  backgroundRenderMode: BackgroundRenderMode;
  setBackgroundRenderMode: React.Dispatch<
    React.SetStateAction<BackgroundRenderMode>
  >;
  backgroundVideoReplayMode: BackgroundVideoReplayMode;
  setBackgroundVideoReplayMode: React.Dispatch<
    React.SetStateAction<BackgroundVideoReplayMode>
  >;
  backgroundVideoReplayIntervalSec: number;
  setBackgroundVideoReplayIntervalSec: React.Dispatch<
    React.SetStateAction<number>
  >;
  availableShells: LocalShellProfile[];
  refreshAvailableShells: () => Promise<void>;
  settingsLoaded: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  retrySave: () => void;
};

/** 限制背景图透明度范围。 */
function clampBackgroundImageSurfaceAlpha(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_BACKGROUND_IMAGE_SURFACE_ALPHA;
  return Math.min(
    MAX_BACKGROUND_IMAGE_SURFACE_ALPHA,
    Math.max(MIN_BACKGROUND_IMAGE_SURFACE_ALPHA, value),
  );
}

/** 规范化并回退不支持的主题 ID。 */
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

/** 根据系统安装的 shell 列表解析最优默认项。 */
function resolveDefaultShellId(shells: LocalShellProfile[]) {
  if (!shells.length) return null;
  const preferred = shells.find((shell) => shell.id === "powershell");
  if (preferred) return preferred.id;
  return shells[0].id;
}

/**
 * 应用设置持久化 Hook。
 * 初始值优先尝试跟随系统（语言），随后通过异步 I/O 从 settings.json 加载覆盖。
 */
export default function useAppSettings({
  themeIds,
  defaultThemeId,
}: {
  themeIds: ThemeId[];
  defaultThemeId: ThemeId;
}): UseAppSettingsResult {
  const [locale, setLocale] = useState<Locale>(() => {
    // 初始状态尝试从系统语言获取。
    const sysLang = navigator.language.toLowerCase();
    return sysLang.startsWith("zh") ? "zh-CN" : "en-US";
  });
  const [themeId, setThemeId] = useState<ThemeId>(defaultThemeId);
  const [availableShells, setAvailableShells] = useState<LocalShellProfile[]>(
    [],
  );
  const [shellId, setShellId] = useState<string | null>(null);
  const [localShellProfiles, setLocalShellProfiles] = useState<
    Record<string, LocalShellConfig>
  >({});
  const [sftpEnabled, setSftpEnabled] = useState(true);
  const [fileDefaultEditorPath, setFileDefaultEditorPath] = useState("");
  const [backgroundImageEnabled, setBackgroundImageEnabled] = useState(false);
  const [backgroundImageAsset, setBackgroundImageAsset] = useState("");
  const [backgroundImageSurfaceAlpha, setBackgroundImageSurfaceAlpha] =
    useState(DEFAULT_BACKGROUND_IMAGE_SURFACE_ALPHA);
  const [backgroundMediaType, setBackgroundMediaType] = useState(
    DEFAULT_BACKGROUND_MEDIA_TYPE,
  );
  const [backgroundRenderMode, setBackgroundRenderMode] = useState(
    DEFAULT_BACKGROUND_RENDER_MODE,
  );
  const [backgroundVideoReplayMode, setBackgroundVideoReplayMode] = useState(
    DEFAULT_BACKGROUND_VIDEO_REPLAY_MODE,
  );
  const [
    backgroundVideoReplayIntervalSec,
    setBackgroundVideoReplayIntervalSec,
  ] = useState(DEFAULT_BACKGROUND_VIDEO_REPLAY_INTERVAL_SEC);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveRetryToken, setSaveRetryToken] = useState(0);

  // 持久化辅助引用。
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const lastSavedConfigRef = useRef<string>("");
  const pendingShellIdRef = useRef<string | null>(null);

  /** 从磁盘读取全量设置并反填内存状态。 */
  const loadSettings = useCallback(async () => {
    try {
      const path = await getSettingsPath();
      if (!(await exists(path))) {
        void debug(
          JSON.stringify({
            event: "settings.load.skip",
            reason: "file-not-exists",
          }),
        );
        return;
      }
      const raw = await readTextFile(path);
      const parsed = JSON.parse(raw) as AppSettings;
      if (parsed?.shellId) {
        pendingShellIdRef.current = parsed.shellId;
      }
      if (
        parsed?.localShellProfiles &&
        typeof parsed.localShellProfiles === "object"
      ) {
        const nextProfiles: Record<string, LocalShellConfig> = {};
        Object.entries(parsed.localShellProfiles).forEach(([id, cfg]) => {
          if (!id || !cfg || typeof cfg !== "object") return;
          nextProfiles[id] = normalizeLocalShellConfig(cfg);
        });
        setLocalShellProfiles(nextProfiles);
      }
      if (parsed?.locale === "zh-CN" || parsed?.locale === "en-US") {
        setLocale(parsed.locale);
      }
      if (typeof parsed?.sftpEnabled === "boolean") {
        setSftpEnabled(parsed.sftpEnabled);
      }
      if (typeof parsed?.fileDefaultEditorPath === "string") {
        setFileDefaultEditorPath(parsed.fileDefaultEditorPath);
      }
      if (typeof parsed?.backgroundImageEnabled === "boolean") {
        setBackgroundImageEnabled(parsed.backgroundImageEnabled);
      }
      if (typeof parsed?.backgroundImageAsset === "string") {
        setBackgroundImageAsset(parsed.backgroundImageAsset);
        if (!parsed?.backgroundMediaType) {
          setBackgroundMediaType(
            inferBackgroundMediaTypeFromAsset(parsed.backgroundImageAsset),
          );
        }
      }
      if (typeof parsed?.backgroundImageSurfaceAlpha === "number") {
        setBackgroundImageSurfaceAlpha(
          clampBackgroundImageSurfaceAlpha(parsed.backgroundImageSurfaceAlpha),
        );
      }
      if (typeof parsed?.backgroundMediaType === "string") {
        setBackgroundMediaType(
          normalizeBackgroundMediaType(parsed.backgroundMediaType),
        );
      }
      if (typeof parsed?.backgroundRenderMode === "string") {
        setBackgroundRenderMode(
          normalizeBackgroundRenderMode(parsed.backgroundRenderMode),
        );
      }
      if (typeof parsed?.backgroundVideoReplayMode === "string") {
        setBackgroundVideoReplayMode(
          normalizeBackgroundVideoReplayMode(parsed.backgroundVideoReplayMode),
        );
      }
      if (typeof parsed?.backgroundVideoReplayIntervalSec === "number") {
        setBackgroundVideoReplayIntervalSec(
          clampBackgroundVideoReplayIntervalSec(
            parsed.backgroundVideoReplayIntervalSec,
          ),
        );
      }
      const normalizedThemeId = normalizeThemeId(parsed?.themeId);
      if (normalizedThemeId && themeIds.includes(normalizedThemeId)) {
        setThemeId(normalizedThemeId);
      }
      void debug(
        JSON.stringify({
          event: "settings.loaded",
          keyCount: Object.keys(parsed ?? {}).length,
          hasShellId: typeof parsed?.shellId === "string",
          hasBackgroundMedia: typeof parsed?.backgroundImageAsset === "string",
        }),
      );
    } catch (error) {
      void warn(
        JSON.stringify({
          event: "settings.load.failed",
          error: extractErrorMessage(error),
        }),
      );
    }
  }, [themeIds]);

  /** 重新拉取系统可用的本地 Shell 列表，并在必要时修正当前选中项。 */
  const refreshAvailableShells = useCallback(async () => {
    const shells = await invoke<LocalShellProfile[]>("local_shell_list");
    setAvailableShells(shells);
    const fallbackId = resolveDefaultShellId(shells);
    setShellId((current) => {
      // 手动重新扫描时优先保留用户当前选择；首次启动时则回退到磁盘中的已保存选择。
      const preferred = current ?? pendingShellIdRef.current;
      const preferredAvailable =
        !!preferred && shells.some((shell) => shell.id === preferred);
      const selected = (preferredAvailable ? preferred : fallbackId) ?? null;

      void debug(
        JSON.stringify({
          event: "settings.refresh.shell",
          savedShellId: preferred ?? null,
          availableShellIds: shells.map((shell) => shell.id),
          selectedShellId: selected,
          fallbackUsed: !!preferred && !preferredAvailable,
        }),
      );

      return selected;
    });
  }, []);

  /** 将最新设置写入磁盘。 */
  async function saveSettings(payload: AppSettings) {
    const dir = await getGlobalConfigDir();
    await mkdir(dir, { recursive: true });
    const path = await getSettingsPath();
    await writeTextFile(path, JSON.stringify(payload, null, 2));
  }

  // 同步 HTML 语言标记。
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // 启动流水线：加载设置 -> 拉取 Shell 列表 -> 完成就绪标记。
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await loadSettings();
        await refreshAvailableShells();
      } catch {
        if (!active) return;
        setAvailableShells([]);
        setShellId(null);
        void warn(JSON.stringify({ event: "settings.init.shell.failed" }));
      } finally {
        if (active) {
          loadedRef.current = true;
          setSettingsLoaded(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [loadSettings, refreshAvailableShells]);

  // 自动防抖异步保存。
  useEffect(() => {
    if (!loadedRef.current) return;

    const currentSettings: AppSettings = {
      version: 1,
      shellId,
      localShellProfiles,
      locale,
      themeId,
      sftpEnabled,
      fileDefaultEditorPath: fileDefaultEditorPath.trim() || null,
      backgroundImageEnabled,
      backgroundImageAsset: backgroundImageAsset.trim() || null,
      backgroundImageSurfaceAlpha: clampBackgroundImageSurfaceAlpha(
        backgroundImageSurfaceAlpha,
      ),
      backgroundMediaType: normalizeBackgroundMediaType(backgroundMediaType),
      backgroundRenderMode: normalizeBackgroundRenderMode(backgroundRenderMode),
      backgroundVideoReplayMode: normalizeBackgroundVideoReplayMode(
        backgroundVideoReplayMode,
      ),
      backgroundVideoReplayIntervalSec: clampBackgroundVideoReplayIntervalSec(
        backgroundVideoReplayIntervalSec,
      ),
    };

    const settingsStr = JSON.stringify(currentSettings);
    // 脏检查打破循环。
    if (settingsStr === lastSavedConfigRef.current) {
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    setSaveState("saving");
    setSaveError(null);

    void debug(
      JSON.stringify({
        event: "settings.save.scheduled",
        debounce: PERSISTENCE_SAVE_DEBOUNCE_MS,
      }),
    );

    saveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          await saveSettings(currentSettings);
          lastSavedConfigRef.current = settingsStr;
          setSaveState("saved");
          void debug(JSON.stringify({ event: "settings.persisted" }));
        } catch (error) {
          setSaveState("error");
          setSaveError(extractErrorMessage(error));
          void warn(
            JSON.stringify({
              event: "settings.save.failed",
              error: extractErrorMessage(error),
            }),
          );
        }
      })();
    }, PERSISTENCE_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    shellId,
    localShellProfiles,
    locale,
    themeId,
    sftpEnabled,
    fileDefaultEditorPath,
    backgroundImageEnabled,
    backgroundImageAsset,
    backgroundImageSurfaceAlpha,
    backgroundMediaType,
    backgroundRenderMode,
    backgroundVideoReplayMode,
    backgroundVideoReplayIntervalSec,
    settingsLoaded,
    saveRetryToken,
  ]);

  /** 手动触发一次设置重试保存。 */
  function retrySave() {
    setSaveRetryToken((current) => current + 1);
  }

  return {
    locale,
    setLocale,
    themeId,
    setThemeId,
    shellId,
    setShellId,
    localShellProfiles,
    setLocalShellProfiles,
    sftpEnabled,
    setSftpEnabled,
    fileDefaultEditorPath,
    setFileDefaultEditorPath,
    backgroundImageEnabled,
    setBackgroundImageEnabled,
    backgroundImageAsset,
    setBackgroundImageAsset,
    backgroundImageSurfaceAlpha,
    setBackgroundImageSurfaceAlpha,
    backgroundMediaType,
    setBackgroundMediaType,
    backgroundRenderMode,
    setBackgroundRenderMode,
    backgroundVideoReplayMode,
    setBackgroundVideoReplayMode,
    backgroundVideoReplayIntervalSec,
    setBackgroundVideoReplayIntervalSec,
    availableShells,
    refreshAvailableShells,
    settingsLoaded,
    saveState,
    saveError,
    retrySave,
  };
}
