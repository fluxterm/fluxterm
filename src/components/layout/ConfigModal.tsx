import { useEffect, useState, type CSSProperties } from "react";
import { error as logError } from "@/shared/logging/telemetry";
import { open as openDialogFile } from "@tauri-apps/plugin-dialog";
import {
  copyFile,
  exists,
  mkdir,
  readFile,
  remove,
} from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Locale, Translate } from "@/i18n";
import Modal from "@/components/ui/modal/Modal";
import Button from "@/components/ui/button";
import Select from "@/components/ui/select";
import Tooltip from "@/components/ui/menu/Tooltip";
import { useNotices } from "@/hooks/useNotices";
import useKeyedDraftState from "@/hooks/useKeyedDraftState";
import {
  getAppConfigDir,
  getAppDataDir,
  getBackgroundImageAssetPath,
  getBackgroundImagesDir,
  toBackgroundImageAsset,
} from "@/shared/config/paths";
import type { AiProviderVendor, AiProviderView } from "@/features/ai/types";
import type { SecurityStatus } from "@/features/security/types";
import {
  DEFAULT_RESOURCE_MONITOR_INTERVAL_SEC,
  type HostKeyPolicy,
  MAX_SCROLLBACK,
  MIN_RESOURCE_MONITOR_INTERVAL_SEC,
  MIN_SCROLLBACK,
} from "@/hooks/useSessionSettings";
import {
  DEFAULT_TERMINAL_CURSOR_STYLE,
  type TerminalCursorStyle,
} from "@/constants/terminalCursorStyle";
import {
  MAX_BACKGROUND_IMAGE_SURFACE_ALPHA,
  MIN_BACKGROUND_IMAGE_SURFACE_ALPHA,
} from "@/hooks/useAppSettings";
import type { ThemeId } from "@/types";
import type { TranslationKey } from "@/i18n";
import {
  BUILTIN_WALLPAPERS,
  getBuiltinWallpaperByAsset,
  isBuiltinWallpaperAsset,
} from "@/constants/builtinWallpapers";
import {
  BACKGROUND_IMAGE_EXTENSIONS,
  BACKGROUND_MEDIA_EXTENSIONS,
  BACKGROUND_VIDEO_EXTENSIONS,
  clampBackgroundVideoReplayIntervalSec,
  normalizeBackgroundMediaType,
  normalizeBackgroundRenderMode,
  normalizeBackgroundVideoReplayMode,
  type BackgroundMediaType,
  type BackgroundRenderMode,
  type BackgroundVideoReplayMode,
} from "@/constants/backgroundMedia";
import "@/components/layout/ConfigModal.css";
import { extractErrorMessage } from "@/shared/errors/appError";
import { translateAppError } from "@/shared/errors/appError";
import {
  AI_PROVIDER_PRESETS,
  getAiProviderPreset,
} from "@/constants/aiProviders";
import type {
  ConfigSectionItem,
  ConfigSectionKey,
} from "@/main/config/configNavigation";

type SaveState = "idle" | "saving" | "saved" | "error";

function getErrorMessage(error: unknown) {
  return extractErrorMessage(error);
}

/** 从完整路径提取程序文件名，用于配置页简洁展示。 */
function getProgramNameFromPath(path: string) {
  if (!path) return "";
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

type ConfigModalProps = {
  open: boolean;
  activeSection: ConfigSectionKey;
  sections: ConfigSectionItem[];
  locale: Locale;
  themeId: ThemeId;
  shellId: string | null;
  availableShells: Array<{ id: string; label: string }>;
  themes: Record<ThemeId, { labelKey: TranslationKey }>;
  sftpEnabled?: boolean;
  fileDefaultEditorPath?: string;
  backgroundImageEnabled?: boolean;
  backgroundImageAsset?: string;
  backgroundImageSurfaceAlpha?: number;
  backgroundMediaType?: BackgroundMediaType;
  backgroundRenderMode?: BackgroundRenderMode;
  backgroundVideoReplayMode?: BackgroundVideoReplayMode;
  backgroundVideoReplayIntervalSec?: number;
  aiSelectionMaxChars?: number;
  aiSessionRecentOutputMaxChars?: number;
  aiRequestTimeoutMs?: number;
  aiDebugLoggingEnabled?: boolean;
  aiActiveProviderId?: string;
  aiProviders?: AiProviderView[];
  securityStatus?: SecurityStatus;
  securityLoaded?: boolean;
  securityBusy?: boolean;
  webLinksEnabled?: boolean;
  commandAutocompleteEnabled?: boolean;
  selectionAutoCopyEnabled?: boolean;
  autoReconnectOnPoweroff?: boolean;
  autoReconnectOnReboot?: boolean;
  cursorStyle?: TerminalCursorStyle;
  scrollback?: number;
  terminalPathSyncEnabled?: boolean;
  resourceMonitorEnabled?: boolean;
  resourceMonitorIntervalSec?: number;
  hostKeyPolicy?: HostKeyPolicy;
  onSftpEnabledChange?: (enabled: boolean) => void;
  onLocaleChange?: (locale: Locale) => void;
  onThemeChange?: (themeId: ThemeId) => void;
  onShellChange?: (shellId: string | null) => void;
  onFileDefaultEditorPathChange?: (value: string) => void;
  onBackgroundImageEnabledChange?: (enabled: boolean) => void;
  onBackgroundImageAssetChange?: (value: string) => void;
  onBackgroundImageSurfaceAlphaChange?: (value: number) => void;
  onBackgroundMediaTypeChange?: (value: BackgroundMediaType) => void;
  onBackgroundRenderModeChange?: (value: BackgroundRenderMode) => void;
  onBackgroundVideoReplayModeChange?: (
    value: BackgroundVideoReplayMode,
  ) => void;
  onBackgroundVideoReplayIntervalSecChange?: (value: number) => void;
  onAiSelectionMaxCharsChange?: (value: number) => void;
  onAiSessionRecentOutputMaxCharsChange?: (value: number) => void;
  onAiRequestTimeoutMsChange?: (value: number) => void;
  onAiDebugLoggingEnabledChange?: (enabled: boolean) => void;
  onAiActiveProviderIdChange?: (value: string) => void;
  onAiPresetProviderCreate?: (input: {
    vendor?: AiProviderVendor;
    name: string;
    model: string;
    apiKey: string;
  }) => Promise<string | void> | string | void;
  onAiCompatibleProviderCreate?: (input: {
    name: string;
    baseUrl: string;
    model: string;
    apiKey: string;
  }) => Promise<string | void> | string | void;
  onAiProviderNameChange?: (providerId: string, value: string) => void;
  onAiProviderBaseUrlChange?: (providerId: string, value: string) => void;
  onAiProviderModelChange?: (providerId: string, value: string) => void;
  onAiProviderVendorChange?: (
    providerId: string,
    vendor: AiProviderVendor,
  ) => void;
  onAiProviderApiKeyReplace?: (
    providerId: string,
    value: string,
  ) => Promise<void> | void;
  onAiProviderApiKeyClear?: (providerId: string) => Promise<void> | void;
  onAiProviderRemove?: (providerId: string) => void;
  onAiProviderTest?: (providerId: string) => Promise<void> | void;
  onSecurityUnlock?: (password: string) => Promise<void> | void;
  onSecurityLock?: () => Promise<void> | void;
  onSecurityEnableStrongProtection?: (password: string) => Promise<void> | void;
  onSecurityChangePassword?: (
    currentPassword: string,
    nextPassword: string,
  ) => Promise<void> | void;
  onSecurityEnableWeakProtection?: () => Promise<void> | void;
  onWebLinksEnabledChange?: (enabled: boolean) => void;
  onCommandAutocompleteEnabledChange?: (enabled: boolean) => void;
  onSelectionAutoCopyEnabledChange?: (enabled: boolean) => void;
  onAutoReconnectOnPoweroffChange?: (enabled: boolean) => void;
  onAutoReconnectOnRebootChange?: (enabled: boolean) => void;
  onCursorStyleChange?: (value: TerminalCursorStyle) => void;
  onScrollbackChange?: (value: number) => void;
  onTerminalPathSyncEnabledChange?: (enabled: boolean) => void;
  onResourceMonitorEnabledChange?: (enabled: boolean) => void;
  onResourceMonitorIntervalSecChange?: (value: number) => void;
  onHostKeyPolicyChange?: (value: HostKeyPolicy) => void;
  appSaveState?: SaveState;
  appSaveError?: string | null;
  onAppSaveRetry?: () => void;
  aiSaveState?: SaveState;
  aiSaveError?: string | null;
  onAiSaveRetry?: () => void;
  sessionSaveState?: SaveState;
  sessionSaveError?: string | null;
  onSessionSaveRetry?: () => void;
  onClose: () => void;
  onSectionChange: (section: ConfigSectionKey) => void;
  t: Translate;
};

function getTranslatedErrorMessage(error: unknown, t: Translate) {
  return translateAppError(error, t);
}

function normalizeConfigDirectoryPath(path: string) {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return path.replace(/\//g, "\\");
  }
  return path;
}

function clampBackgroundImageSurfaceAlpha(value: number) {
  if (!Number.isFinite(value)) return MIN_BACKGROUND_IMAGE_SURFACE_ALPHA;
  return Math.min(
    MAX_BACKGROUND_IMAGE_SURFACE_ALPHA,
    Math.max(MIN_BACKGROUND_IMAGE_SURFACE_ALPHA, value),
  );
}

/** 把内部 surface alpha 映射为用户可理解的透明度百分比。 */
function toBackgroundTransparencyPercent(surfaceAlpha: number) {
  const clamped = clampBackgroundImageSurfaceAlpha(surfaceAlpha);
  return Math.min(100, Math.max(1, Math.round((1 - clamped) * 100)));
}

/** 把用户设置的透明度百分比映射回内部 surface alpha。 */
function fromBackgroundTransparencyPercent(percentage: number) {
  const normalized = Math.min(100, Math.max(1, Math.round(percentage)));
  return clampBackgroundImageSurfaceAlpha((100 - normalized) / 100);
}

async function sha256Hex(bytes: Uint8Array) {
  const normalized = new Uint8Array(bytes.byteLength);
  normalized.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", normalized);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 配置模态框：承载顶部“配置”菜单的统一内容容器。
 * 约束：本组件内新增菜单项如果需要下拉选择，必须优先复用通用 `Select` 组件，
 * 不要回退到原生 `<select>`，以保持样式、键盘导航与关闭行为一致。
 */
export default function ConfigModal({
  open,
  activeSection,
  sections,
  locale,
  themeId,
  shellId,
  availableShells,
  themes,
  sftpEnabled = true,
  fileDefaultEditorPath = "",
  backgroundImageEnabled = false,
  backgroundImageAsset = "",
  backgroundImageSurfaceAlpha = 0.52,
  backgroundMediaType = "image",
  backgroundRenderMode = "cover",
  backgroundVideoReplayMode = "loop",
  backgroundVideoReplayIntervalSec = 8,
  aiSelectionMaxChars = 1500,
  aiSessionRecentOutputMaxChars = 1200,
  aiRequestTimeoutMs = 20000,
  aiDebugLoggingEnabled = true,
  aiActiveProviderId = "",
  aiProviders = [],
  securityStatus = {
    provider: "embedded",
    locked: false,
    encryptionEnabled: true,
  },
  securityLoaded = false,
  securityBusy = false,
  webLinksEnabled = true,
  commandAutocompleteEnabled = true,
  selectionAutoCopyEnabled = false,
  autoReconnectOnPoweroff = false,
  autoReconnectOnReboot = true,
  cursorStyle = DEFAULT_TERMINAL_CURSOR_STYLE,
  scrollback = 3000,
  terminalPathSyncEnabled = true,
  resourceMonitorEnabled = false,
  resourceMonitorIntervalSec = DEFAULT_RESOURCE_MONITOR_INTERVAL_SEC,
  hostKeyPolicy = "ask",
  onSftpEnabledChange,
  onLocaleChange,
  onThemeChange,
  onShellChange,
  onFileDefaultEditorPathChange,
  onBackgroundImageEnabledChange,
  onBackgroundImageAssetChange,
  onBackgroundImageSurfaceAlphaChange,
  onBackgroundMediaTypeChange,
  onBackgroundRenderModeChange,
  onBackgroundVideoReplayModeChange,
  onBackgroundVideoReplayIntervalSecChange,
  onAiSelectionMaxCharsChange,
  onAiSessionRecentOutputMaxCharsChange,
  onAiRequestTimeoutMsChange,
  onAiDebugLoggingEnabledChange,
  onAiActiveProviderIdChange,
  onAiPresetProviderCreate,
  onAiCompatibleProviderCreate,
  onAiProviderNameChange,
  onAiProviderBaseUrlChange,
  onAiProviderModelChange,
  onAiProviderVendorChange,
  onAiProviderApiKeyReplace,
  onAiProviderApiKeyClear,
  onAiProviderRemove,
  onAiProviderTest,
  onSecurityUnlock,
  onSecurityLock,
  onSecurityEnableStrongProtection,
  onSecurityChangePassword,
  onSecurityEnableWeakProtection,
  onWebLinksEnabledChange,
  onCommandAutocompleteEnabledChange,
  onSelectionAutoCopyEnabledChange,
  onAutoReconnectOnPoweroffChange,
  onAutoReconnectOnRebootChange,
  onCursorStyleChange,
  onScrollbackChange,
  onTerminalPathSyncEnabledChange,
  onResourceMonitorEnabledChange,
  onResourceMonitorIntervalSecChange,
  onHostKeyPolicyChange,
  appSaveState = "idle",
  appSaveError = null,
  onAppSaveRetry,
  aiSaveState = "idle",
  aiSaveError = null,
  onAiSaveRetry,
  sessionSaveState = "idle",
  sessionSaveError = null,
  onSessionSaveRetry,
  onClose,
  onSectionChange,
  t,
}: ConfigModalProps) {
  const { pushToast, openDialog } = useNotices();
  const [configDir, setConfigDir] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [defaultEditorPathDraft, setDefaultEditorPathDraft] =
    useKeyedDraftState(fileDefaultEditorPath, fileDefaultEditorPath);
  const [aiSelectionMaxCharsDraft, setAiSelectionMaxCharsDraft] =
    useKeyedDraftState(
      String(aiSelectionMaxChars),
      String(aiSelectionMaxChars),
    );
  const [
    aiSessionRecentOutputMaxCharsDraft,
    setAiSessionRecentOutputMaxCharsDraft,
  ] = useKeyedDraftState(
    String(aiSessionRecentOutputMaxChars),
    String(aiSessionRecentOutputMaxChars),
  );
  const [aiRequestTimeoutMsDraft, setAiRequestTimeoutMsDraft] =
    useKeyedDraftState(String(aiRequestTimeoutMs), String(aiRequestTimeoutMs));
  // 数字输入使用本地草稿字符串，允许用户先清空再继续输入。
  const [scrollbackDraft, setScrollbackDraft] = useKeyedDraftState(
    String(scrollback),
    String(scrollback),
  );
  const [resourceMonitorIntervalDraft, setResourceMonitorIntervalDraft] =
    useKeyedDraftState(
      String(resourceMonitorIntervalSec),
      String(resourceMonitorIntervalSec),
    );
  const [
    backgroundVideoReplayIntervalDraft,
    setBackgroundVideoReplayIntervalDraft,
  ] = useKeyedDraftState(
    String(
      clampBackgroundVideoReplayIntervalSec(backgroundVideoReplayIntervalSec),
    ),
    String(
      clampBackgroundVideoReplayIntervalSec(backgroundVideoReplayIntervalSec),
    ),
  );
  const [editingProviderId, setEditingProviderId] = useState("");
  const [editingProviderDraftKey, setEditingProviderDraftKey] = useState(0);
  const editingProvider =
    aiProviders.find((provider) => provider.id === editingProviderId) ?? null;
  const [editingProviderNameDraft, setEditingProviderNameDraft] =
    useKeyedDraftState(
      `${editingProviderDraftKey}:${editingProvider?.id ?? ""}:name:${editingProvider?.name ?? ""}`,
      editingProvider?.name ?? "",
    );
  const [editingProviderBaseUrlDraft, setEditingProviderBaseUrlDraft] =
    useKeyedDraftState(
      `${editingProviderDraftKey}:${editingProvider?.id ?? ""}:baseUrl:${editingProvider?.baseUrl ?? ""}`,
      editingProvider?.baseUrl ?? "",
    );
  const [editingProviderModelDraft, setEditingProviderModelDraft] =
    useKeyedDraftState(
      `${editingProviderDraftKey}:${editingProvider?.id ?? ""}:model:${editingProvider?.model ?? ""}`,
      editingProvider?.model ?? "",
    );
  const [editingProviderVendorDraft, setEditingProviderVendorDraft] =
    useKeyedDraftState(
      `${editingProviderDraftKey}:${editingProvider?.id ?? ""}:vendor:${editingProvider?.vendor ?? ""}`,
      editingProvider?.vendor ?? "deepseek",
    );
  const [editingProviderApiKeyDraft, setEditingProviderApiKeyDraft] =
    useKeyedDraftState(
      `${editingProviderDraftKey}:${editingProvider?.id ?? ""}:apiKey`,
      "",
    );
  const [quickPresetVendorDraft, setQuickPresetVendorDraft] =
    useState<AiProviderVendor>("deepseek");
  const [quickPresetNameDraft, setQuickPresetNameDraft] = useState("");
  const [quickPresetModelDraft, setQuickPresetModelDraft] = useKeyedDraftState(
    quickPresetVendorDraft,
    getAiProviderPreset(quickPresetVendorDraft)?.models[0] ?? "",
  );
  const [quickPresetApiKeyDraft, setQuickPresetApiKeyDraft] = useState("");
  const [quickPresetCreating, setQuickPresetCreating] = useState(false);
  const [compatibleNameDraft, setCompatibleNameDraft] = useState("");
  const [compatibleBaseUrlDraft, setCompatibleBaseUrlDraft] = useState("");
  const [compatibleModelDraft, setCompatibleModelDraft] = useState("");
  const [compatibleApiKeyDraft, setCompatibleApiKeyDraft] = useState("");
  const [compatibleCreating, setCompatibleCreating] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState("");
  const [updatingProviderSecretId, setUpdatingProviderSecretId] = useState("");
  const securityDraftSourceKey = `${activeSection}:${securityStatus.provider}:${securityStatus.locked}`;
  const [securityPasswordDraft, setSecurityPasswordDraft] = useKeyedDraftState(
    securityDraftSourceKey,
    "",
  );
  const [securityConfirmPasswordDraft, setSecurityConfirmPasswordDraft] =
    useKeyedDraftState(securityDraftSourceKey, "");
  const [securityCurrentPasswordDraft, setSecurityCurrentPasswordDraft] =
    useKeyedDraftState(securityDraftSourceKey, "");
  const [securityNextPasswordDraft, setSecurityNextPasswordDraft] =
    useKeyedDraftState(securityDraftSourceKey, "");
  const [
    securityNextPasswordConfirmDraft,
    setSecurityNextPasswordConfirmDraft,
  ] = useKeyedDraftState(securityDraftSourceKey, "");
  const isDeveloperMode = import.meta.env.DEV;
  const normalizedBackgroundMediaType =
    normalizeBackgroundMediaType(backgroundMediaType);
  const normalizedBackgroundRenderMode =
    normalizeBackgroundRenderMode(backgroundRenderMode);
  const normalizedBackgroundVideoReplayMode =
    normalizeBackgroundVideoReplayMode(backgroundVideoReplayMode);
  const normalizedBackgroundVideoReplayIntervalSec =
    clampBackgroundVideoReplayIntervalSec(backgroundVideoReplayIntervalSec);
  const backgroundTransparencyPercent = toBackgroundTransparencyPercent(
    backgroundImageSurfaceAlpha,
  );
  const isBackgroundVideoMode = normalizedBackgroundMediaType === "video";
  const selectedBuiltinWallpaper =
    getBuiltinWallpaperByAsset(backgroundImageAsset);
  const isBuiltinBackgroundSelected = !!selectedBuiltinWallpaper;
  const backgroundMediaDisplayName = selectedBuiltinWallpaper
    ? `${t("config.app.backgroundMediaSourceBuiltin")} · ${selectedBuiltinWallpaper.label}`
    : backgroundImageAsset || t("config.app.backgroundMediaPlaceholder");
  const isBackgroundImageModeActive =
    backgroundImageEnabled && !!backgroundImageAsset;
  const effectiveModalSurfaceAlpha = isBackgroundImageModeActive
    ? backgroundImageSurfaceAlpha
    : 0.76;
  const isDefaultEditorPathDirty =
    defaultEditorPathDraft.trim() !== fileDefaultEditorPath.trim();
  const hasUnsavedHighRiskChanges = isDefaultEditorPathDirty;

  useEffect(() => {
    if (!open || activeSection !== "app-directory") return;
    getAppConfigDir()
      .then((path) => {
        setConfigDir(normalizeConfigDirectoryPath(path));
      })
      .catch(() => {
        setConfigDir("");
      });
    getAppDataDir()
      .then((path) => {
        setDataDir(normalizeConfigDirectoryPath(path));
      })
      .catch(() => {
        setDataDir("");
      });
  }, [activeSection, open]);

  async function pickBackgroundMedia() {
    try {
      const selected = await openDialogFile({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Media",
            extensions: BACKGROUND_MEDIA_EXTENSIONS,
          },
          {
            name: "Images",
            extensions: BACKGROUND_IMAGE_EXTENSIONS,
          },
          {
            name: "Videos",
            extensions: BACKGROUND_VIDEO_EXTENSIONS,
          },
        ],
      });
      if (!selected || Array.isArray(selected)) return;
      const extMatch = selected.match(/\.([A-Za-z0-9]+)$/);
      const ext = extMatch?.[1]?.toLowerCase();
      if (!ext || !BACKGROUND_MEDIA_EXTENSIONS.includes(ext)) {
        pushToast({
          level: "error",
          message: t("config.app.backgroundMediaUnsupported"),
        });
        return;
      }

      const sourceBytes = await readFile(selected);
      const hash = await sha256Hex(sourceBytes);
      const backgroundsDir = await getBackgroundImagesDir();
      await mkdir(backgroundsDir, { recursive: true });
      const fileName = `bg-${hash}.${ext}`;
      const targetPath = await getBackgroundImageAssetPath(
        toBackgroundImageAsset(fileName),
      );
      if (!(await exists(targetPath))) {
        await copyFile(selected, targetPath);
      }

      onBackgroundImageAssetChange?.(toBackgroundImageAsset(fileName));
      onBackgroundImageEnabledChange?.(true);
      onBackgroundMediaTypeChange?.(
        BACKGROUND_VIDEO_EXTENSIONS.includes(ext) ? "video" : "image",
      );
    } catch (error) {
      const message = getErrorMessage(error);
      const normalized = message.toLowerCase();
      const likelyPermissionDenied =
        normalized.includes("forbidden") ||
        normalized.includes("denied") ||
        normalized.includes("not allowed") ||
        normalized.includes("scope");
      pushToast({
        level: "error",
        durationMs: 9000,
        message: likelyPermissionDenied
          ? `${t("config.app.backgroundMediaPermissionDenied")}\n${message}`
          : message,
      });
    }
  }

  function selectBuiltinWallpaper(asset: string) {
    onBackgroundImageAssetChange?.(asset);
    onBackgroundImageEnabledChange?.(true);
    onBackgroundMediaTypeChange?.("image");
  }

  // 数值草稿在失焦、回车或关闭模态框时统一提交；非法输入回退到当前生效值。
  function commitScrollbackDraft() {
    const value = scrollbackDraft.trim();
    if (!value) {
      setScrollbackDraft(String(scrollback));
      return;
    }
    const next = Number(value);
    if (!Number.isFinite(next)) {
      setScrollbackDraft(String(scrollback));
      return;
    }
    onScrollbackChange?.(next);
  }

  function commitResourceMonitorIntervalDraft() {
    const value = resourceMonitorIntervalDraft.trim();
    if (!value) {
      setResourceMonitorIntervalDraft(String(resourceMonitorIntervalSec));
      return;
    }
    const next = Number(value);
    if (!Number.isFinite(next)) {
      setResourceMonitorIntervalDraft(String(resourceMonitorIntervalSec));
      return;
    }
    onResourceMonitorIntervalSecChange?.(next);
  }

  function commitBackgroundVideoReplayIntervalDraft() {
    const value = backgroundVideoReplayIntervalDraft.trim();
    if (!value) {
      setBackgroundVideoReplayIntervalDraft(
        String(normalizedBackgroundVideoReplayIntervalSec),
      );
      return;
    }
    const next = clampBackgroundVideoReplayIntervalSec(Number(value));
    setBackgroundVideoReplayIntervalDraft(String(next));
    onBackgroundVideoReplayIntervalSecChange?.(next);
  }

  function commitDefaultEditorPathDraft() {
    onFileDefaultEditorPathChange?.(defaultEditorPathDraft.trim());
  }

  function commitAiSelectionMaxCharsDraft() {
    const value = aiSelectionMaxCharsDraft.trim();
    if (!value) {
      setAiSelectionMaxCharsDraft(String(aiSelectionMaxChars));
      return;
    }
    const next = Number(value);
    if (!Number.isFinite(next)) {
      setAiSelectionMaxCharsDraft(String(aiSelectionMaxChars));
      return;
    }
    onAiSelectionMaxCharsChange?.(next);
  }

  function commitAiSessionRecentOutputMaxCharsDraft() {
    const value = aiSessionRecentOutputMaxCharsDraft.trim();
    if (!value) {
      setAiSessionRecentOutputMaxCharsDraft(
        String(aiSessionRecentOutputMaxChars),
      );
      return;
    }
    const next = Number(value);
    if (!Number.isFinite(next)) {
      setAiSessionRecentOutputMaxCharsDraft(
        String(aiSessionRecentOutputMaxChars),
      );
      return;
    }
    onAiSessionRecentOutputMaxCharsChange?.(next);
  }

  function commitAiRequestTimeoutMsDraft() {
    const value = aiRequestTimeoutMsDraft.trim();
    if (!value) {
      setAiRequestTimeoutMsDraft(String(aiRequestTimeoutMs));
      return;
    }
    const next = Number(value);
    if (!Number.isFinite(next)) {
      setAiRequestTimeoutMsDraft(String(aiRequestTimeoutMs));
      return;
    }
    onAiRequestTimeoutMsChange?.(next);
  }

  function isProviderNameDuplicate(name: string, excludeId?: string) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return false;
    return aiProviders.some(
      (provider) =>
        provider.id !== excludeId &&
        provider.name.trim().toLowerCase() === normalized,
    );
  }

  function openProviderEditor(provider: AiProviderView) {
    setEditingProviderDraftKey((current) => current + 1);
    setEditingProviderId(provider.id);
  }

  async function saveEditingProvider() {
    if (!editingProvider) return;
    const nextName = editingProviderNameDraft.trim();
    if (!nextName) {
      pushToast({
        level: "error",
        message: t("config.ai.providerNameRequired"),
      });
      return;
    }
    if (isProviderNameDuplicate(nextName, editingProvider.id)) {
      pushToast({
        level: "error",
        message: t("config.ai.providerNameDuplicate"),
      });
      return;
    }

    const nextModel = editingProviderModelDraft.trim();
    if (!nextModel) {
      pushToast({
        level: "error",
        message: t("config.ai.providerModelRequired"),
      });
      return;
    }

    const nextBaseUrl = editingProviderBaseUrlDraft.trim();
    if (editingProvider.mode === "compatible" && !nextBaseUrl) {
      pushToast({
        level: "error",
        message: t("config.ai.providerBaseUrlRequired"),
      });
      return;
    }

    const nextVendor = editingProviderVendorDraft as AiProviderVendor;
    const nextApiKey = editingProviderApiKeyDraft.trim();
    setUpdatingProviderSecretId(editingProvider.id);
    try {
      if (nextName !== editingProvider.name.trim()) {
        onAiProviderNameChange?.(editingProvider.id, nextName);
      }
      if (
        editingProvider.mode === "preset" &&
        nextVendor !== editingProvider.vendor
      ) {
        onAiProviderVendorChange?.(editingProvider.id, nextVendor);
      }
      if (
        editingProvider.mode === "compatible" &&
        nextBaseUrl !== editingProvider.baseUrl.trim()
      ) {
        onAiProviderBaseUrlChange?.(editingProvider.id, nextBaseUrl);
      }
      if (nextModel !== editingProvider.model.trim()) {
        onAiProviderModelChange?.(editingProvider.id, nextModel);
      }
      if (nextApiKey) {
        await onAiProviderApiKeyReplace?.(editingProvider.id, nextApiKey);
        pushToast({
          level: "success",
          message: t("config.ai.providerApiKeySaved"),
        });
      }
      setEditingProviderApiKeyDraft("");
      setEditingProviderId("");
    } catch (error) {
      pushToast({
        level: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setUpdatingProviderSecretId("");
    }
  }

  async function clearEditingProviderApiKey() {
    if (!editingProvider) return;
    setUpdatingProviderSecretId(editingProvider.id);
    try {
      await onAiProviderApiKeyClear?.(editingProvider.id);
      setEditingProviderApiKeyDraft("");
      pushToast({
        level: "success",
        message: t("config.ai.providerApiKeyCleared"),
      });
    } catch (error) {
      pushToast({
        level: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setUpdatingProviderSecretId("");
    }
  }

  function renderProviderList(
    list: AiProviderView[],
    options?: { removable?: boolean },
  ) {
    if (!list.length) return null;
    return (
      <div className="config-openai-list">
        {list.map((provider) => {
          const isActive = provider.id === aiActiveProviderId;
          return (
            <div key={provider.id} className="config-openai-item">
              <span className="config-openai-item-main">
                <span className="config-openai-item-title">
                  {provider.name || t("config.ai.providerUnnamed")}
                </span>
              </span>
              <span className="config-openai-item-actions">
                {isActive ? (
                  <span className="config-openai-status">
                    {t("config.ai.providerCurrentBadge")}
                  </span>
                ) : null}
                <span
                  role="button"
                  tabIndex={0}
                  className="config-openai-badge"
                  onClick={(event) => {
                    event.stopPropagation();
                    openProviderEditor(provider);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openProviderEditor(provider);
                  }}
                >
                  {t("config.ai.providerEdit")}
                </span>
                {options?.removable ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className="config-openai-badge"
                    onClick={(event) => {
                      event.stopPropagation();
                      const isRemovingActive =
                        provider.id === aiActiveProviderId;
                      onAiProviderRemove?.(provider.id);
                      if (editingProviderId === provider.id) {
                        setEditingProviderId("");
                      }
                      if (isRemovingActive) {
                        onAiActiveProviderIdChange?.("");
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      const isRemovingActive =
                        provider.id === aiActiveProviderId;
                      onAiProviderRemove?.(provider.id);
                      if (editingProviderId === provider.id) {
                        setEditingProviderId("");
                      }
                      if (isRemovingActive) {
                        onAiActiveProviderIdChange?.("");
                      }
                    }}
                  >
                    {t("config.ai.providerRemove")}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  /** 渲染统一的配置持久化状态提示。 */
  function renderSaveStatus(
    state: SaveState,
    error: string | null,
    onRetry?: () => void,
  ) {
    if (state === "idle") return null;
    return (
      <div className={`config-save-status is-${state}`}>
        <span>
          {state === "saving" && t("config.saveState.saving")}
          {state === "saved" && t("config.saveState.saved")}
          {state === "error" && t("config.saveState.failed")}
        </span>
        {state === "error" ? (
          <div className="config-save-status-error">
            {error || t("config.saveState.failed")}
          </div>
        ) : null}
        {state === "error" && onRetry ? (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t("config.saveState.retry")}
          </Button>
        ) : null}
      </div>
    );
  }

  /** 按当前分区选择对应的状态源，保证不同设置域文案一致。 */
  function renderActiveSectionSaveStatus() {
    if (
      activeSection === "general" ||
      activeSection === "language" ||
      activeSection === "personalization" ||
      activeSection === "security" ||
      activeSection === "app-directory"
    ) {
      return renderSaveStatus(appSaveState, appSaveError, onAppSaveRetry);
    }
    if (
      activeSection === "session-settings" ||
      activeSection === "session-window" ||
      activeSection === "session-shell"
    ) {
      return renderSaveStatus(
        sessionSaveState,
        sessionSaveError,
        onSessionSaveRetry,
      );
    }
    if (
      activeSection === "ai-settings" ||
      activeSection === "ai-provider-manage" ||
      activeSection === "ai-provider-quick" ||
      activeSection === "ai-provider-compat"
    ) {
      if (!aiActiveProviderId && aiSaveState === "error") {
        return null;
      }
      return renderSaveStatus(aiSaveState, aiSaveError, onAiSaveRetry);
    }
    return null;
  }

  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  function handleClose() {
    // 低风险数值项在关闭前提交，高风险字段改为显式保存并在离开时确认是否丢弃草稿。
    commitAiSelectionMaxCharsDraft();
    commitAiSessionRecentOutputMaxCharsDraft();
    commitScrollbackDraft();
    commitResourceMonitorIntervalDraft();
    commitBackgroundVideoReplayIntervalDraft();
    if (hasUnsavedHighRiskChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }

  // 按统一配置分区渲染内容，标题栏菜单与侧栏导航共用同一套 section key。
  function renderSectionContent() {
    if (activeSection === "general") {
      const defaultEditorProgramName = getProgramNameFromPath(
        defaultEditorPathDraft,
      );
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.general")}</h3>
          {renderActiveSectionSaveStatus()}
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.app.sftpEnabled")}
              </span>
              <span className="config-toggle-desc">
                {t("config.app.sftpEnabledHint")}
              </span>
            </div>
            <input
              type="checkbox"
              autoComplete="off"
              checked={sftpEnabled}
              onChange={(event) => onSftpEnabledChange?.(event.target.checked)}
            />
          </label>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-head">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.app.fileDefaultEditorPath")}
                </span>
              </div>
            </div>
            <div className="config-file-picker config-file-picker-align-end">
              <Tooltip
                content={
                  defaultEditorPathDraft ||
                  t("config.app.fileDefaultEditorUnset")
                }
              >
                <div
                  className={`config-file-picker-path config-file-picker-path-single-line ${
                    defaultEditorProgramName ? "" : "empty"
                  }`.trim()}
                >
                  {defaultEditorProgramName ||
                    t("config.app.fileDefaultEditorUnset")}
                </div>
              </Tooltip>
              <div className="config-file-picker-actions config-file-picker-actions-nowrap">
                <Button
                  variant="ghost"
                  size="sm"
                  className="config-bg-image-action-button"
                  onClick={() => {
                    void (async () => {
                      const selected = await openDialogFile({
                        multiple: false,
                        directory: false,
                      });
                      if (!selected || Array.isArray(selected)) return;
                      setDefaultEditorPathDraft(selected);
                    })();
                  }}
                >
                  {t("config.app.pickEditor")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="config-bg-image-action-button"
                  disabled={!defaultEditorPathDraft}
                  onClick={() => {
                    setDefaultEditorPathDraft("");
                  }}
                >
                  {t("actions.clear")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="config-bg-image-action-button"
                  disabled={!isDefaultEditorPathDirty}
                  onClick={commitDefaultEditorPathDraft}
                >
                  {t("actions.save")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    if (activeSection === "language") {
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.language")}</h3>
          {renderActiveSectionSaveStatus()}
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("settings.language")}
              </span>
            </div>
            <div className="config-select-control">
              <Select
                value={locale}
                options={[
                  { value: "zh-CN", label: t("language.zh-CN") },
                  { value: "en-US", label: t("language.en-US") },
                ]}
                onChange={(value) => onLocaleChange?.(value as Locale)}
                aria-label={t("settings.language")}
              />
            </div>
          </label>
        </div>
      );
    }
    if (activeSection === "personalization") {
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.personalization")}</h3>
          {renderActiveSectionSaveStatus()}
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">{t("settings.theme")}</span>
            </div>
            <div className="config-select-control">
              <Select
                value={themeId}
                options={Object.entries(themes).map(([key, theme]) => ({
                  value: key,
                  label: t(theme.labelKey),
                }))}
                onChange={(value) => onThemeChange?.(value as ThemeId)}
                aria-label={t("settings.theme")}
              />
            </div>
          </label>
          <label className="config-toggle-card config-range-setting">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.app.backgroundImageSurfaceAlpha")}
              </span>
              <span className="config-toggle-desc">
                {t("config.app.backgroundImageSurfaceAlphaHint")}
              </span>
            </div>
            <span className="config-range-control">
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={backgroundTransparencyPercent}
                onChange={(event) =>
                  onBackgroundImageSurfaceAlphaChange?.(
                    fromBackgroundTransparencyPercent(
                      Number(event.currentTarget.value),
                    ),
                  )
                }
                aria-label={t("config.app.backgroundImageSurfaceAlpha")}
              />
              <span className="config-range-value">
                {backgroundTransparencyPercent}%
              </span>
            </span>
          </label>
          <div className="config-toggle-card config-feature-group">
            <label className="config-toggle-head">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.app.backgroundMedia")}
                </span>
                <span className="config-toggle-desc">
                  {t("config.app.backgroundMediaHint")}
                </span>
              </div>
              <input
                type="checkbox"
                checked={backgroundImageEnabled && !!backgroundImageAsset}
                disabled={!backgroundImageAsset}
                onChange={(event) =>
                  onBackgroundImageEnabledChange?.(event.target.checked)
                }
              />
            </label>
            <Tooltip content={backgroundMediaDisplayName}>
              <div
                className={`config-file-picker-path config-file-picker-path-single-line ${
                  backgroundImageAsset ? "" : "empty"
                }`.trim()}
              >
                {backgroundMediaDisplayName}
              </div>
            </Tooltip>
            <div className="config-subsetting config-subsetting-stack">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.app.builtinWallpapers")}
                </span>
              </div>
              <div className="config-wallpaper-grid">
                {BUILTIN_WALLPAPERS.map((wallpaper) => {
                  const isActive = backgroundImageAsset === wallpaper.asset;
                  return (
                    <button
                      key={wallpaper.id}
                      type="button"
                      className={`config-wallpaper-card ${
                        isActive ? "active" : ""
                      }`.trim()}
                      aria-label={wallpaper.label}
                      title={wallpaper.label}
                      onClick={() => {
                        selectBuiltinWallpaper(wallpaper.asset);
                      }}
                    >
                      <span
                        className={`config-wallpaper-card-preview tone-${wallpaper.tone}`}
                        style={
                          {
                            "--config-wallpaper-preview": `url("${wallpaper.url}")`,
                          } as CSSProperties
                        }
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="config-subsetting">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.app.backgroundRenderMode")}
                </span>
              </div>
              <div className="config-select-control">
                <Select
                  value={normalizedBackgroundRenderMode}
                  options={[
                    {
                      value: "cover",
                      label: t("config.app.backgroundRenderMode.cover"),
                    },
                    {
                      value: "contain",
                      label: t("config.app.backgroundRenderMode.contain"),
                    },
                    {
                      value: "tile",
                      label: t("config.app.backgroundRenderMode.tile"),
                    },
                  ]}
                  onChange={(value) =>
                    onBackgroundRenderModeChange?.(
                      value as BackgroundRenderMode,
                    )
                  }
                  aria-label={t("config.app.backgroundRenderMode")}
                />
              </div>
            </label>
            {isBackgroundVideoMode ? (
              <>
                <label className="config-subsetting">
                  <div className="config-toggle-copy">
                    <span className="config-toggle-title">
                      {t("config.app.backgroundVideoReplayMode")}
                    </span>
                  </div>
                  <div className="config-select-control">
                    <Select
                      value={normalizedBackgroundVideoReplayMode}
                      options={[
                        {
                          value: "loop",
                          label: t("config.app.backgroundVideoReplayMode.loop"),
                        },
                        {
                          value: "single",
                          label: t(
                            "config.app.backgroundVideoReplayMode.single",
                          ),
                        },
                        {
                          value: "interval",
                          label: t(
                            "config.app.backgroundVideoReplayMode.interval",
                          ),
                        },
                      ]}
                      onChange={(value) =>
                        onBackgroundVideoReplayModeChange?.(
                          value as BackgroundVideoReplayMode,
                        )
                      }
                      aria-label={t("config.app.backgroundVideoReplayMode")}
                    />
                  </div>
                </label>
                {normalizedBackgroundVideoReplayMode === "interval" ? (
                  <label className="config-subsetting">
                    <div className="config-toggle-copy">
                      <span className="config-toggle-title">
                        {t("config.app.backgroundVideoReplayIntervalSec")}
                      </span>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="config-number-input"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={backgroundVideoReplayIntervalDraft}
                      onChange={(event) =>
                        setBackgroundVideoReplayIntervalDraft(
                          event.target.value,
                        )
                      }
                      onBlur={commitBackgroundVideoReplayIntervalDraft}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        commitBackgroundVideoReplayIntervalDraft();
                      }}
                    />{" "}
                  </label>
                ) : null}
              </>
            ) : null}
            <div className="config-file-picker-actions">
              <Button
                variant="ghost"
                size="sm"
                className="config-bg-image-action-button"
                onClick={() => {
                  void pickBackgroundMedia();
                }}
              >
                {t("config.app.pickBackgroundMedia")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="config-bg-image-action-button"
                disabled={!backgroundImageAsset}
                onClick={() => {
                  void (async () => {
                    try {
                      const assetToDelete = backgroundImageAsset;
                      if (
                        assetToDelete &&
                        !isBuiltinWallpaperAsset(assetToDelete)
                      ) {
                        const targetPath =
                          await getBackgroundImageAssetPath(assetToDelete);
                        if (await exists(targetPath)) {
                          await remove(targetPath);
                        }
                      }
                      onBackgroundImageAssetChange?.("");
                      onBackgroundImageEnabledChange?.(false);
                      onBackgroundMediaTypeChange?.("image");
                    } catch (error) {
                      pushToast({
                        level: "error",
                        message: getErrorMessage(error),
                      });
                    }
                  })();
                }}
              >
                {t(
                  isBuiltinBackgroundSelected
                    ? "config.app.clearBackgroundMedia"
                    : "config.app.deleteBackgroundMedia",
                )}
              </Button>
            </div>
          </div>
        </div>
      );
    }
    if (activeSection === "security") {
      const isWeakMode = securityStatus.provider === "embedded";
      const isStrongMode = securityStatus.provider === "user_password";
      const isLocked = securityStatus.locked;
      return (
        <div className="config-modal-widget config-modal-widget-scrollable config-security-section">
          <h3>{t("config.section.security")}</h3>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.security.currentMode")}
              </span>
            </div>
            <div className="config-dir-path">
              {securityLoaded
                ? isWeakMode
                  ? t("config.security.providerWeak")
                  : t("config.security.providerStrong")
                : t("config.security.loading")}
            </div>
          </div>
          {isStrongMode && isLocked ? (
            <div className="config-toggle-card config-feature-group">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.security.unlockPassword")}
                </span>
                <span className="config-toggle-desc">
                  {t("config.security.passwordHintEncrypted")}
                </span>
              </div>
              <input
                type="password"
                autoComplete="off"
                className="config-text-input"
                value={securityPasswordDraft}
                placeholder={t("config.security.passwordPlaceholder")}
                onChange={(event) =>
                  setSecurityPasswordDraft(event.target.value)
                }
              />
              <div className="config-file-picker-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={securityBusy || !securityPasswordDraft.trim()}
                  onClick={() => {
                    void Promise.resolve(
                      onSecurityUnlock?.(securityPasswordDraft.trim()),
                    )
                      .then(() => {
                        setSecurityPasswordDraft("");
                        pushToast({
                          level: "success",
                          message: t("config.security.unlockSuccess"),
                        });
                      })
                      .catch((error) => {
                        pushToast({
                          level: "error",
                          message: getTranslatedErrorMessage(error, t),
                        });
                      });
                  }}
                >
                  {t("config.security.unlockAction")}
                </Button>
              </div>
            </div>
          ) : null}
          {isWeakMode ? (
            <div className="config-toggle-card config-feature-group">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.security.enableStrongProtection")}
                </span>
                <span className="config-toggle-desc">
                  {t("config.security.passwordHintWeak")}
                </span>
              </div>
              <input
                type="password"
                autoComplete="off"
                className="config-text-input"
                value={securityPasswordDraft}
                placeholder={t("config.security.passwordPlaceholder")}
                onChange={(event) =>
                  setSecurityPasswordDraft(event.target.value)
                }
              />
              <input
                type="password"
                autoComplete="off"
                className="config-text-input"
                value={securityConfirmPasswordDraft}
                placeholder={t("config.security.confirmPasswordPlaceholder")}
                onChange={(event) =>
                  setSecurityConfirmPasswordDraft(event.target.value)
                }
              />
              <div className="config-file-picker-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={securityBusy}
                  onClick={() => {
                    const password = securityPasswordDraft.trim();
                    const confirm = securityConfirmPasswordDraft.trim();
                    if (!password) {
                      pushToast({
                        level: "error",
                        message: t("config.security.passwordRequired"),
                      });
                      return;
                    }
                    if (password !== confirm) {
                      pushToast({
                        level: "error",
                        message: t("config.security.passwordMismatch"),
                      });
                      return;
                    }
                    void Promise.resolve(
                      onSecurityEnableStrongProtection?.(password),
                    )
                      .then(() => {
                        setSecurityPasswordDraft("");
                        setSecurityConfirmPasswordDraft("");
                        pushToast({
                          level: "success",
                          message: t("config.security.enableSuccess"),
                        });
                      })
                      .catch((error) => {
                        pushToast({
                          level: "error",
                          message: getTranslatedErrorMessage(error, t),
                        });
                      });
                  }}
                >
                  {t("config.security.enableAction")}
                </Button>
              </div>
            </div>
          ) : null}
          {isStrongMode && !isLocked ? (
            <div className="config-toggle-card config-feature-group">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.security.changePassword")}
                </span>
              </div>
              <input
                type="password"
                autoComplete="off"
                className="config-text-input"
                value={securityCurrentPasswordDraft}
                placeholder={t("config.security.currentPasswordPlaceholder")}
                onChange={(event) =>
                  setSecurityCurrentPasswordDraft(event.target.value)
                }
              />
              <input
                type="password"
                autoComplete="off"
                className="config-text-input"
                value={securityNextPasswordDraft}
                placeholder={t("config.security.nextPasswordPlaceholder")}
                onChange={(event) =>
                  setSecurityNextPasswordDraft(event.target.value)
                }
              />
              <input
                type="password"
                autoComplete="off"
                className="config-text-input"
                value={securityNextPasswordConfirmDraft}
                placeholder={t(
                  "config.security.confirmNextPasswordPlaceholder",
                )}
                onChange={(event) =>
                  setSecurityNextPasswordConfirmDraft(event.target.value)
                }
              />
              <div className="config-file-picker-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={securityBusy}
                  onClick={() => {
                    const currentPassword = securityCurrentPasswordDraft.trim();
                    const nextPassword = securityNextPasswordDraft.trim();
                    const confirm = securityNextPasswordConfirmDraft.trim();
                    if (!currentPassword) {
                      pushToast({
                        level: "error",
                        message: t("config.security.currentPasswordRequired"),
                      });
                      return;
                    }
                    if (!nextPassword) {
                      pushToast({
                        level: "error",
                        message: t("config.security.passwordRequired"),
                      });
                      return;
                    }
                    if (nextPassword !== confirm) {
                      pushToast({
                        level: "error",
                        message: t("config.security.passwordMismatch"),
                      });
                      return;
                    }
                    void Promise.resolve(
                      onSecurityChangePassword?.(currentPassword, nextPassword),
                    )
                      .then(() => {
                        setSecurityCurrentPasswordDraft("");
                        setSecurityNextPasswordDraft("");
                        setSecurityNextPasswordConfirmDraft("");
                        pushToast({
                          level: "success",
                          message: t("config.security.changeSuccess"),
                        });
                      })
                      .catch((error) => {
                        pushToast({
                          level: "error",
                          message: getTranslatedErrorMessage(error, t),
                        });
                      });
                  }}
                >
                  {t("config.security.changeAction")}
                </Button>
              </div>
            </div>
          ) : null}
          {isStrongMode && !isLocked ? (
            <div className="config-toggle-card config-feature-group">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.security.dangerTitle")}
                </span>
                <span className="config-toggle-desc">
                  {t("config.security.dangerHint")}
                </span>
              </div>
              <div className="config-file-picker-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={securityBusy}
                  onClick={() => {
                    void Promise.resolve(onSecurityLock?.())
                      .then(() => {
                        setSecurityPasswordDraft("");
                        setSecurityConfirmPasswordDraft("");
                        pushToast({
                          level: "success",
                          message: t("config.security.lockSuccess"),
                        });
                      })
                      .catch((error) => {
                        pushToast({
                          level: "error",
                          message: getTranslatedErrorMessage(error, t),
                        });
                      });
                  }}
                >
                  {t("config.security.lockAction")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={securityBusy}
                  onClick={() => {
                    openDialog({
                      title: t("config.security.enableWeakAction"),
                      message: t("config.security.enableWeakConfirm"),
                      confirmLabel: t("config.security.enableWeakAction"),
                      cancelLabel: t("actions.cancel"),
                      onConfirm: () => {
                        void Promise.resolve(onSecurityEnableWeakProtection?.())
                          .then(() => {
                            setSecurityPasswordDraft("");
                            setSecurityConfirmPasswordDraft("");
                            pushToast({
                              level: "success",
                              message: t("config.security.enableWeakSuccess"),
                            });
                          })
                          .catch((error) => {
                            pushToast({
                              level: "error",
                              message: getTranslatedErrorMessage(error, t),
                            });
                          });
                      },
                    });
                  }}
                >
                  {t("config.security.enableWeakAction")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    if (activeSection === "ai-settings") {
      const activeProvider =
        aiProviders.find((provider) => provider.id === aiActiveProviderId) ??
        null;
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.aiSettings")}</h3>
          {renderActiveSectionSaveStatus()}
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.activeProvider")}
              </span>
            </div>
            <div className="config-ai-provider-inline">
              <div className="config-select-control">
                <Select
                  value={aiActiveProviderId}
                  options={[
                    { value: "", label: t("config.ai.providerEmpty") },
                    ...aiProviders.map((provider) => ({
                      value: provider.id,
                      label: provider.name || t("config.ai.providerUnnamed"),
                    })),
                  ]}
                  onChange={(value) => onAiActiveProviderIdChange?.(value)}
                  aria-label={t("config.ai.activeProvider")}
                />
              </div>
              <div className="config-file-picker-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    !activeProvider || testingProviderId === activeProvider.id
                  }
                  onClick={() => {
                    void (async () => {
                      try {
                        if (!activeProvider) return;
                        setTestingProviderId(activeProvider.id);
                        await onAiProviderTest?.(activeProvider.id);
                        pushToast({
                          level: "success",
                          message: t("config.ai.providerTestSuccess"),
                        });
                      } catch (error) {
                        pushToast({
                          level: "error",
                          message: getTranslatedErrorMessage(error, t),
                        });
                      } finally {
                        setTestingProviderId("");
                      }
                    })();
                  }}
                >
                  {activeProvider && testingProviderId === activeProvider.id
                    ? t("config.ai.providerTesting")
                    : t("config.ai.providerTest")}
                </Button>
              </div>
            </div>
          </div>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.selectionMaxChars")}
              </span>
              <span className="config-toggle-desc">
                {t("config.ai.selectionMaxCharsHint")}
              </span>
            </div>
            <input
              type="text"
              inputMode="numeric"
              className="config-number-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={aiSelectionMaxCharsDraft}
              onChange={(event) =>
                setAiSelectionMaxCharsDraft(event.target.value)
              }
              onBlur={commitAiSelectionMaxCharsDraft}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitAiSelectionMaxCharsDraft();
              }}
            />
          </div>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.sessionRecentOutputMaxChars")}
              </span>
              <span className="config-toggle-desc">
                {t("config.ai.sessionRecentOutputMaxCharsHint")}
              </span>
            </div>
            <input
              type="text"
              inputMode="numeric"
              className="config-number-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={aiSessionRecentOutputMaxCharsDraft}
              onChange={(event) =>
                setAiSessionRecentOutputMaxCharsDraft(event.target.value)
              }
              onBlur={commitAiSessionRecentOutputMaxCharsDraft}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitAiSessionRecentOutputMaxCharsDraft();
              }}
            />
          </div>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.requestTimeoutMs")}
              </span>
              <span className="config-toggle-desc">
                {t("config.ai.requestTimeoutMsHint")}
              </span>
            </div>
            <input
              type="text"
              inputMode="numeric"
              className="config-number-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={aiRequestTimeoutMsDraft}
              onChange={(event) =>
                setAiRequestTimeoutMsDraft(event.target.value)
              }
              onBlur={commitAiRequestTimeoutMsDraft}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitAiRequestTimeoutMsDraft();
              }}
            />
          </div>
          {isDeveloperMode ? (
            <label className="config-toggle-card">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.ai.debugLoggingEnabled")}
                </span>
              </div>
              <input
                type="checkbox"
                checked={aiDebugLoggingEnabled}
                onChange={(event) =>
                  onAiDebugLoggingEnabledChange?.(event.target.checked)
                }
              />
            </label>
          ) : null}
        </div>
      );
    }
    if (activeSection === "ai-provider-manage") {
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.aiProviderManage")}</h3>
          {renderActiveSectionSaveStatus()}
          {!aiProviders.length ? (
            <div className="config-empty-state">
              {t("config.ai.manageEmpty")}
            </div>
          ) : (
            renderProviderList(aiProviders, { removable: true })
          )}
        </div>
      );
    }
    if (activeSection === "ai-provider-quick") {
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.aiProviderQuick")}</h3>
          {renderActiveSectionSaveStatus()}
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.providerName")}
              </span>
            </div>
            <input
              type="text"
              className="config-text-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={quickPresetNameDraft}
              placeholder={t("config.ai.providerNamePlaceholder")}
              onChange={(event) => setQuickPresetNameDraft(event.target.value)}
            />
          </div>
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.providerVendor")}
              </span>
            </div>
            <div className="config-select-control">
              <Select
                value={quickPresetVendorDraft}
                options={AI_PROVIDER_PRESETS.map((preset) => ({
                  value: preset.vendor,
                  label: preset.label,
                }))}
                onChange={(value) =>
                  setQuickPresetVendorDraft(value as AiProviderVendor)
                }
                aria-label={t("config.ai.providerVendor")}
              />
            </div>
          </label>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.providerModel")}
              </span>
            </div>
            <input
              type="text"
              className="config-text-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={quickPresetModelDraft}
              placeholder={t("config.ai.providerModelPlaceholder")}
              onChange={(event) => setQuickPresetModelDraft(event.target.value)}
            />
          </div>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.providerApiKey")}
              </span>
            </div>
            <input
              type="password"
              className="config-text-input"
              autoComplete="off"
              value={quickPresetApiKeyDraft}
              placeholder={t("config.ai.providerApiKeyPlaceholder")}
              onChange={(event) =>
                setQuickPresetApiKeyDraft(event.target.value)
              }
            />
          </div>
          <div className="config-file-picker-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={quickPresetCreating}
              onClick={() => {
                const nextName = quickPresetNameDraft.trim();
                if (!nextName) {
                  pushToast({
                    level: "error",
                    message: t("config.ai.providerNameRequired"),
                  });
                  return;
                }
                if (isProviderNameDuplicate(nextName)) {
                  pushToast({
                    level: "error",
                    message: t("config.ai.providerNameDuplicate"),
                  });
                  return;
                }
                const nextModel = quickPresetModelDraft.trim();
                if (!nextModel) {
                  pushToast({
                    level: "error",
                    message: t("config.ai.providerModelRequired"),
                  });
                  return;
                }
                setQuickPresetCreating(true);
                Promise.resolve(
                  onAiPresetProviderCreate?.({
                    vendor: quickPresetVendorDraft,
                    name: nextName,
                    model: nextModel,
                    apiKey: quickPresetApiKeyDraft.trim(),
                  }),
                )
                  .then(() => {
                    setQuickPresetNameDraft("");
                    setQuickPresetApiKeyDraft("");
                    setQuickPresetModelDraft(
                      getAiProviderPreset(quickPresetVendorDraft)?.models[0] ??
                        "",
                    );
                  })
                  .catch((error) => {
                    pushToast({
                      level: "error",
                      message: getErrorMessage(error),
                    });
                  })
                  .finally(() => {
                    setQuickPresetCreating(false);
                  });
              }}
            >
              {t("config.ai.confirmAdd")}
            </Button>
          </div>
        </div>
      );
    }
    if (activeSection === "ai-provider-compat") {
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.aiProviderCompat")}</h3>
          {renderActiveSectionSaveStatus()}
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.providerName")}
              </span>
            </div>
            <input
              type="text"
              className="config-text-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={compatibleNameDraft}
              placeholder={t("config.openai.namePlaceholder")}
              onChange={(event) => setCompatibleNameDraft(event.target.value)}
            />
          </div>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.providerBaseUrl")}
              </span>
            </div>
            <input
              type="text"
              className="config-text-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={compatibleBaseUrlDraft}
              placeholder={t("config.openai.baseUrlPlaceholder")}
              onChange={(event) =>
                setCompatibleBaseUrlDraft(event.target.value)
              }
            />
          </div>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.providerModel")}
              </span>
            </div>
            <input
              type="text"
              className="config-text-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={compatibleModelDraft}
              placeholder={t("config.openai.modelPlaceholder")}
              onChange={(event) => setCompatibleModelDraft(event.target.value)}
            />
          </div>
          <div className="config-toggle-card config-feature-group">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.ai.providerApiKey")}
              </span>
            </div>
            <input
              type="password"
              className="config-text-input"
              autoComplete="off"
              value={compatibleApiKeyDraft}
              placeholder={t("config.openai.apiKeyPlaceholder")}
              onChange={(event) => setCompatibleApiKeyDraft(event.target.value)}
            />
          </div>
          <div className="config-file-picker-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={compatibleCreating}
              onClick={() => {
                const nextName = compatibleNameDraft.trim();
                if (!nextName) {
                  pushToast({
                    level: "error",
                    message: t("config.ai.providerNameRequired"),
                  });
                  return;
                }
                if (isProviderNameDuplicate(nextName)) {
                  pushToast({
                    level: "error",
                    message: t("config.ai.providerNameDuplicate"),
                  });
                  return;
                }
                const nextBaseUrl = compatibleBaseUrlDraft.trim();
                if (!nextBaseUrl) {
                  pushToast({
                    level: "error",
                    message: t("config.ai.providerBaseUrlRequired"),
                  });
                  return;
                }
                const nextModel = compatibleModelDraft.trim();
                if (!nextModel) {
                  pushToast({
                    level: "error",
                    message: t("config.ai.providerModelRequired"),
                  });
                  return;
                }
                setCompatibleCreating(true);
                Promise.resolve(
                  onAiCompatibleProviderCreate?.({
                    name: nextName,
                    baseUrl: nextBaseUrl,
                    model: nextModel,
                    apiKey: compatibleApiKeyDraft.trim(),
                  }),
                )
                  .then(() => {
                    setCompatibleNameDraft("");
                    setCompatibleBaseUrlDraft("");
                    setCompatibleModelDraft("");
                    setCompatibleApiKeyDraft("");
                  })
                  .catch((error) => {
                    pushToast({
                      level: "error",
                      message: getErrorMessage(error),
                    });
                  })
                  .finally(() => {
                    setCompatibleCreating(false);
                  });
              }}
            >
              {t("config.ai.confirmAdd")}
            </Button>
          </div>
        </div>
      );
    }
    if (activeSection === "session-settings") {
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.sessionSettings")}</h3>
          {renderActiveSectionSaveStatus()}
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.webLinksEnabled")}
              </span>
              <span className="config-toggle-desc">
                {t("config.session.webLinksEnabledHint")}
              </span>
            </div>
            <input
              type="checkbox"
              checked={webLinksEnabled}
              onChange={(event) =>
                onWebLinksEnabledChange?.(event.target.checked)
              }
            />
          </label>
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.selectionAutoCopyEnabled")}
              </span>
              <span className="config-toggle-desc">
                {t("config.session.selectionAutoCopyEnabledHint")}
              </span>
            </div>
            <input
              type="checkbox"
              checked={selectionAutoCopyEnabled}
              onChange={(event) =>
                onSelectionAutoCopyEnabledChange?.(event.target.checked)
              }
            />
          </label>
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.commandAutocompleteEnabled")}
              </span>
              <span className="config-toggle-desc">
                {t("config.session.commandAutocompleteEnabledHint")}
              </span>
            </div>
            <input
              type="checkbox"
              checked={commandAutocompleteEnabled}
              onChange={(event) =>
                onCommandAutocompleteEnabledChange?.(event.target.checked)
              }
            />
          </label>
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.autoReconnectOnReboot")}
              </span>
              <span className="config-toggle-desc">
                {t("config.session.autoReconnectOnRebootHint")}
              </span>
            </div>
            <input
              type="checkbox"
              checked={autoReconnectOnReboot}
              onChange={(event) =>
                onAutoReconnectOnRebootChange?.(event.target.checked)
              }
            />
          </label>
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.autoReconnectOnPoweroff")}
              </span>
              <span className="config-toggle-desc">
                {t("config.session.autoReconnectOnPoweroffHint")}
              </span>
            </div>
            <input
              type="checkbox"
              checked={autoReconnectOnPoweroff}
              onChange={(event) =>
                onAutoReconnectOnPoweroffChange?.(event.target.checked)
              }
            />
          </label>
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.terminalPathSyncEnabled")}
              </span>
              <span className="config-toggle-desc">
                {t("config.session.terminalPathSyncEnabledHint")}
              </span>
            </div>
            <input
              type="checkbox"
              checked={terminalPathSyncEnabled}
              onChange={(event) =>
                onTerminalPathSyncEnabledChange?.(event.target.checked)
              }
            />
          </label>
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.scrollback")}
              </span>
              <span className="config-toggle-desc">
                {t("config.session.scrollbackHint", {
                  min: MIN_SCROLLBACK,
                  max: MAX_SCROLLBACK,
                })}
              </span>
            </div>
            <input
              type="text"
              inputMode="numeric"
              className="config-number-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={scrollbackDraft}
              onChange={(event) => {
                setScrollbackDraft(event.target.value);
              }}
              onBlur={commitScrollbackDraft}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitScrollbackDraft();
              }}
            />
          </label>
          <div className="config-toggle-card config-feature-group">
            <label className="config-toggle-head">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.session.resourceMonitorEnabled")}
                </span>
                <span className="config-toggle-desc">
                  {t("config.session.resourceMonitorEnabledHint")}
                </span>
              </div>
              <input
                type="checkbox"
                checked={resourceMonitorEnabled}
                onChange={(event) =>
                  onResourceMonitorEnabledChange?.(event.target.checked)
                }
              />
            </label>
            <div className="config-subsetting">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.session.resourceMonitorIntervalSec")}
                </span>
                <span className="config-toggle-desc">
                  {t("config.session.resourceMonitorIntervalSecHint", {
                    min: MIN_RESOURCE_MONITOR_INTERVAL_SEC,
                  })}
                </span>
              </div>
              <input
                type="text"
                inputMode="numeric"
                className="config-number-input"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={resourceMonitorIntervalDraft}
                onChange={(event) => {
                  setResourceMonitorIntervalDraft(event.target.value);
                }}
                onBlur={commitResourceMonitorIntervalDraft}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  commitResourceMonitorIntervalDraft();
                }}
              />
            </div>
          </div>
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.hostKeyPolicy")}
              </span>
              <span className="config-toggle-desc">
                {t("config.session.hostKeyPolicyHint")}
              </span>
            </div>
            <div className="config-select-control">
              <Select
                value={hostKeyPolicy}
                options={[
                  {
                    value: "ask",
                    label: t("config.session.hostKeyPolicy.ask"),
                  },
                  {
                    value: "strict",
                    label: t("config.session.hostKeyPolicy.strict"),
                  },
                  {
                    value: "off",
                    label: t("config.session.hostKeyPolicy.off"),
                  },
                ]}
                onChange={(value) =>
                  onHostKeyPolicyChange?.(value as HostKeyPolicy)
                }
                aria-label={t("config.session.hostKeyPolicy")}
              />
            </div>
          </label>
        </div>
      );
    }
    if (activeSection === "session-window") {
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.sessionWindow")}</h3>
          {renderActiveSectionSaveStatus()}
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">
                {t("config.session.cursorStyle")}
              </span>
            </div>
            <div className="config-select-control">
              <Select
                value={cursorStyle}
                options={[
                  {
                    value: "block",
                    label: t("config.session.cursorStyle.block"),
                  },
                  {
                    value: "bar",
                    label: t("config.session.cursorStyle.bar"),
                  },
                  {
                    value: "underline",
                    label: t("config.session.cursorStyle.underline"),
                  },
                ]}
                onChange={(value) =>
                  onCursorStyleChange?.(value as TerminalCursorStyle)
                }
                aria-label={t("config.session.cursorStyle")}
              />
            </div>
          </label>
        </div>
      );
    }
    if (activeSection === "session-shell") {
      return (
        <div className="config-modal-widget config-modal-widget-scrollable">
          <h3>{t("config.section.sessionShell")}</h3>
          {renderActiveSectionSaveStatus()}
          <label className="config-toggle-card">
            <div className="config-toggle-copy">
              <span className="config-toggle-title">{t("settings.shell")}</span>
              {!availableShells.length ? (
                <span className="config-toggle-desc">
                  {t("menu.app.shellEmpty")}
                </span>
              ) : null}
            </div>
            <div className="config-select-control">
              <Select
                value={shellId ?? ""}
                disabled={!availableShells.length}
                options={availableShells.map((shell) => ({
                  value: shell.id,
                  label: shell.label,
                }))}
                placeholder={t("menu.app.shellEmpty")}
                onChange={(value) => onShellChange?.(value || null)}
                aria-label={t("settings.shell")}
              />
            </div>
          </label>
        </div>
      );
    }
    return (
      // 右侧配置区统一使用固定高度 + 内部滚动，避免不同分区在内容增长后把模态框继续撑高。
      <div className="config-modal-widget config-modal-widget-scrollable">
        <h3>{t("config.section.appDirectory")}</h3>
        <div className="config-dir-card">
          <div className="config-toggle-copy">
            <span className="config-toggle-title">
              {t("config.directory.configTitle")}
            </span>
          </div>
          <div className="config-dir-path">
            {configDir || t("config.directory.configUnavailable")}
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!configDir}
            onClick={() => {
              void (async () => {
                if (!configDir) return;
                try {
                  await openPath(configDir);
                } catch (error) {
                  pushToast({
                    level: "error",
                    message: t("config.directory.configOpenFailed"),
                  });
                  void logError(
                    JSON.stringify({
                      event: "config.directory.open.failed",
                      path: configDir,
                      message: extractErrorMessage(error),
                    }),
                  );
                }
              })();
            }}
          >
            {t("config.directory.openConfig")}
          </Button>
        </div>
        <div className="config-dir-card">
          <div className="config-toggle-copy">
            <span className="config-toggle-title">
              {t("config.directory.dataTitle")}
            </span>
          </div>
          <div className="config-dir-path">
            {dataDir || t("config.directory.dataUnavailable")}
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!dataDir}
            onClick={() => {
              void (async () => {
                if (!dataDir) return;
                try {
                  await openPath(dataDir);
                } catch (error) {
                  pushToast({
                    level: "error",
                    message: t("config.directory.dataOpenFailed"),
                  });
                  void logError(
                    JSON.stringify({
                      event: "data.directory.open.failed",
                      path: dataDir,
                      message: extractErrorMessage(error),
                    }),
                  );
                }
              })();
            }}
          >
            {t("config.directory.openData")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      busy={securityBusy}
      busyOverlay={
        <div className="config-security-busy-card">
          <div className="config-security-busy-spinner" aria-hidden="true" />
          <span>{t("config.security.processing")}</span>
        </div>
      }
      title={t("menu.config")}
      closeLabel={t("actions.close")}
      onClose={handleClose}
      bodyClassName="config-modal-body"
    >
      <div
        className="config-modal-layout"
        style={
          {
            "--config-modal-surface-alpha": `${Math.round(
              clampBackgroundImageSurfaceAlpha(effectiveModalSurfaceAlpha) *
                100,
            )}%`,
          } as CSSProperties
        }
      >
        <aside className="config-modal-nav" aria-label={t("menu.config")}>
          {sections.map((section) => (
            <button
              key={section.key}
              type="button"
              className={`config-modal-nav-item ${
                section.key === activeSection ? "active" : ""
              }`}
              onClick={() => onSectionChange(section.key)}
            >
              {section.label}
            </button>
          ))}
        </aside>
        <section className="config-modal-content">
          {renderSectionContent()}
        </section>
      </div>
      {showDiscardConfirm && (
        <Modal
          open
          title={
            t("profile.unsavedChangesConfirmTitle") || t("actions.confirm")
          }
          closeLabel={t("actions.close")}
          onClose={() => setShowDiscardConfirm(false)}
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDiscardConfirm(false)}
              >
                {t("profile.actions.continueEditing") || t("actions.cancel")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowDiscardConfirm(false);
                  onClose();
                }}
              >
                {t("profile.actions.discardAndClose") || t("actions.ok")}
              </Button>
            </>
          }
        >
          <div className="profile-discard-confirm-dialog">
            <p>{t("config.unsavedChangesConfirm")}</p>
          </div>
        </Modal>
      )}
      {editingProvider && (
        <Modal
          open
          title={t("config.ai.providerEditTitle")}
          closeLabel={t("actions.close")}
          onClose={() => setEditingProviderId("")}
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingProviderId("")}
              >
                {t("actions.cancel")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={updatingProviderSecretId === editingProvider.id}
                onClick={() => {
                  void saveEditingProvider();
                }}
              >
                {t("config.ai.providerEditSave")}
              </Button>
            </>
          }
        >
          <div
            className="config-provider-edit-dialog"
            data-ui="ai-provider-edit-dialog"
          >
            <div className="config-toggle-card config-provider-edit-row">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.ai.providerName")}
                </span>
              </div>
              <input
                type="text"
                className="config-text-input"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={editingProviderNameDraft}
                placeholder={t("config.ai.providerNamePlaceholder")}
                data-ui="ai-provider-edit-name"
                onChange={(event) =>
                  setEditingProviderNameDraft(event.target.value)
                }
              />
            </div>
            {editingProvider.mode === "preset" ? (
              <label className="config-toggle-card config-provider-edit-row">
                <div className="config-toggle-copy">
                  <span className="config-toggle-title">
                    {t("config.ai.providerVendor")}
                  </span>
                  <span className="config-toggle-desc">
                    {editingProvider.baseUrl ||
                      t("config.ai.providerBaseUrlEmpty")}
                  </span>
                </div>
                <div className="config-select-control">
                  <Select
                    value={editingProviderVendorDraft}
                    options={AI_PROVIDER_PRESETS.map((preset) => ({
                      value: preset.vendor,
                      label: preset.label,
                    }))}
                    onChange={setEditingProviderVendorDraft}
                    aria-label={t("config.ai.providerVendor")}
                  />
                </div>
              </label>
            ) : (
              <div className="config-toggle-card config-provider-edit-row">
                <div className="config-toggle-copy">
                  <span className="config-toggle-title">
                    {t("config.ai.providerBaseUrl")}
                  </span>
                </div>
                <input
                  type="text"
                  className="config-text-input"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={editingProviderBaseUrlDraft}
                  placeholder={t("config.openai.baseUrlPlaceholder")}
                  data-ui="ai-provider-edit-base-url"
                  onChange={(event) =>
                    setEditingProviderBaseUrlDraft(event.target.value)
                  }
                />
              </div>
            )}
            <div className="config-toggle-card config-provider-edit-row">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.ai.providerModel")}
                </span>
              </div>
              <input
                type="text"
                className="config-text-input"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={editingProviderModelDraft}
                placeholder={t("config.ai.providerModelPlaceholder")}
                data-ui="ai-provider-edit-model"
                onChange={(event) =>
                  setEditingProviderModelDraft(event.target.value)
                }
              />
            </div>
            <div className="config-toggle-card config-provider-edit-row">
              <div className="config-toggle-copy">
                <span className="config-toggle-title">
                  {t("config.ai.providerApiKey")}
                </span>
              </div>
              <div className="config-provider-edit-secret-control">
                <input
                  type="password"
                  className="config-text-input"
                  autoComplete="off"
                  value={editingProviderApiKeyDraft}
                  placeholder={t("config.ai.providerApiKeyPlaceholder")}
                  data-ui="ai-provider-edit-api-key"
                  onChange={(event) =>
                    setEditingProviderApiKeyDraft(event.target.value)
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    updatingProviderSecretId === editingProvider.id ||
                    !editingProvider.apiKeyConfigured
                  }
                  onClick={() => {
                    void clearEditingProviderApiKey();
                  }}
                >
                  {t("config.ai.providerApiKeyClear")}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
