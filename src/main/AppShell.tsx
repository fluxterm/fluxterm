/**
 * 应用编排层。
 * 职责：聚合 settings/profiles/layout/session/terminal/sftp 等领域能力并组装主界面。
 */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "@xterm/xterm/css/xterm.css";
import "@/App.css";
import "@/components/ui/base-input.css";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  getTranslationMessage,
  type Translate,
  type TranslationKey,
} from "@/i18n";
import type { ConfigSectionKey } from "@/main/config/configNavigation";
import TitleBar from "@/components/layout/TitleBar";
import FloatingShell from "@/main/components/FloatingShell";
import Workspace from "@/main/components/Workspace";
import BottomArea from "@/main/components/BottomArea";
import TerminalWidget from "@/widgets/terminal/components/TerminalWidget";
import NoticeHost from "@/components/ui/notice-host";
import { useNotices } from "@/hooks/useNotices";
import { useDisableBrowserShortcuts } from "@/hooks/useDisableBrowserShortcuts";
import { usePreventBrowserDefaults } from "@/hooks/usePreventBrowserDefaults";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import useProfiles from "@/hooks/useProfiles";
import useAppSettings from "@/hooks/useAppSettings";
import {
  DEFAULT_BACKGROUND_IMAGE_SURFACE_ALPHA,
  MAX_BACKGROUND_IMAGE_SURFACE_ALPHA,
  MIN_BACKGROUND_IMAGE_SURFACE_ALPHA,
} from "@/hooks/useAppSettings";
import useAiSettings from "@/hooks/useAiSettings";
import useSecurity from "@/hooks/useSecurity";
import useSessionSettings from "@/hooks/useSessionSettings";
import useLayoutState from "@/main/hooks/useLayoutState";
import useFloatingWidgets from "@/main/hooks/useFloatingWidgets";
import {
  useFloatingWidgetMessagePoster,
  useFloatingWidgetSnapshotSync,
} from "@/main/hooks/useFloatingWidgetSync";
import useMacAppMenu from "@/main/hooks/useMacAppMenu";
import useAppUpdater from "@/main/hooks/useAppUpdater";
import useQuickBarState from "@/main/hooks/useQuickBarState";
import useSubApps from "@/main/hooks/useSubApps";
import useMainAppearance from "@/main/hooks/useMainAppearance";
import useRemoteEditSessions from "@/main/hooks/useRemoteEditSessions";
import useSessionResourceMonitor from "@/main/hooks/useSessionResourceMonitor";
import useTerminalPathSync from "@/main/hooks/useTerminalPathSync";
import { moveWidgetToSlot, widgetKeys } from "@/layout/model";
import type { WidgetSide, WidgetSlotId } from "@/layout/types";
import type {
  HostProfile,
  LocalShellConfig,
  LocalShellProfile,
  RdpProfile,
  Session,
  SshConnectStateMap,
  TerminalCwdSupport,
  TerminalWorkingDirectory,
  WidgetKey,
  ThemeId,
} from "@/types";
import {
  DEFAULT_LOCAL_SHELL_CONFIG,
  normalizeLocalShellConfig,
} from "@/constants/localShellConfig";
import { isMacOS } from "@/utils/platform";
import useSessionController from "@/hooks/useSessionController";
import useTerminalController from "@/hooks/useTerminalController";
import useSftpController from "@/hooks/useSftpController";
import useCommandHistoryState from "@/hooks/useCommandHistoryState";
import useAiState from "@/hooks/useAiState";
import useSshTunnelState from "@/hooks/useSshTunnelState";
import {
  deleteRdpProfile,
  listRdpProfileGroups,
  listRdpProfiles,
  saveRdpProfile,
  saveRdpProfileGroups,
} from "@/features/rdp/core/commands";
import {
  WIDGET_AI_CHANNEL,
  type FloatingAiMessage,
  type FloatingAiSnapshot,
} from "@/features/ai/core/widgetSync";
import { createHistoryAutocompleteProvider } from "@/features/command-history/core/autocomplete";
import { filterHistoryItems } from "@/features/command-history/core/query";
import {
  WIDGET_HISTORY_CHANNEL,
  type FloatingHistoryMessage,
  type FloatingHistorySnapshot,
} from "@/features/command-history/core/widgetSync";
import {
  WIDGET_EVENTS_CHANNEL,
  type FloatingEventsMessage,
  type FloatingEventsSnapshot,
} from "@/features/session/core/widgetEventsSync";
import { themePresets } from "@/main/theme/themePresets";
import { buildTerminalTheme } from "@/main/theme/buildTerminalTheme";
import { buildWidgets } from "@/main/widgets/buildWidgets";
import {
  buildConfigNavigation,
  getScopedConfigNavEntries,
} from "@/main/config/configNavigation";
import {
  WIDGET_FILES_CHANNEL,
  type FloatingFilesMessage,
  type FloatingFilesSnapshot,
} from "@/features/sftp/core/widgetSync";
import {
  WIDGET_TRANSFERS_CHANNEL,
  type FloatingTransfersMessage,
  type FloatingTransfersSnapshot,
} from "@/features/sftp/core/widgetTransfersSync";
import {
  WIDGET_TUNNELS_CHANNEL,
  type FloatingTunnelsMessage,
  type FloatingTunnelsSnapshot,
} from "@/features/tunnel/core/widgetSync";
import { callTauri } from "@/shared/tauri/commands";
import {
  extractErrorMessage,
  translateAppError,
} from "@/shared/errors/appError";
import {
  clampBackgroundVideoReplayIntervalSec,
  normalizeBackgroundMediaType,
  normalizeBackgroundRenderMode,
  normalizeBackgroundVideoReplayMode,
} from "@/constants/backgroundMedia";
import {
  DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
  DEFAULT_TERMINAL_BELL_MODE,
  normalizeTerminalBellCooldownMs,
  normalizeTerminalBellMode,
} from "@/constants/terminalBell";
import {
  DEFAULT_TERMINAL_WORD_SEPARATORS,
  normalizeTerminalWordSeparators,
} from "@/constants/terminalWordSeparators";

const widgetLabelKeys: Record<WidgetKey, TranslationKey> = {
  profiles: "widget.profiles",
  rdp: "widget.rdp",
  files: "widget.files",
  transfers: "widget.transfers",
  events: "widget.events",
  history: "widget.history",
  ai: "widget.ai",
  tunnels: "widget.tunnels",
};
const BACKGROUND_IMAGE_TERMINAL_CANVAS_ALPHA = 0;
const ConfigModal = lazy(() => import("@/components/layout/ConfigModal"));
const AboutModal = lazy(() => import("@/main/components/modals/AboutModal"));
const ProfileModal = lazy(
  () => import("@/main/components/modals/ProfileModal"),
);
const LocalShellProfileModal = lazy(
  () => import("@/main/components/modals/LocalShellProfileModal"),
);
const RdpProfileModal = lazy(
  () => import("@/main/components/modals/RdpProfileModal"),
);

function clampBackgroundImageSurfaceAlpha(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_BACKGROUND_IMAGE_SURFACE_ALPHA;
  return Math.min(
    MAX_BACKGROUND_IMAGE_SURFACE_ALPHA,
    Math.max(MIN_BACKGROUND_IMAGE_SURFACE_ALPHA, value),
  );
}

function formatMessage(
  message: string,
  vars?: Record<string, string | number>,
) {
  if (!vars) return message;
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    message,
  );
}

function getErrorMessage(error: unknown) {
  return extractErrorMessage(error);
}

type PendingSshConnectRuntime = {
  requestId: number;
  sessionId: string | null;
  cancelled: boolean;
};

function normalizeRdpGroupName(value: string) {
  return value.trim();
}

function dedupeRdpGroups(values: string[]) {
  const seen = new Set<string>();
  const list: string[] = [];
  values.forEach((item) => {
    const normalized = normalizeRdpGroupName(item);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(normalized);
  });
  return list.sort((a, b) => a.localeCompare(b));
}

function formatOpenSshImportToast(
  t: Translate,
  summary: {
    addedCount: number;
    skippedCount: number;
    conflictCount: number;
    unsupportedCount: number;
    errorCount: number;
  },
) {
  const parts = [
    summary.addedCount > 0
      ? t("host.import.item.added", { count: summary.addedCount })
      : null,
    summary.skippedCount > 0
      ? t("host.import.item.skipped", { count: summary.skippedCount })
      : null,
    summary.conflictCount > 0
      ? t("host.import.item.conflict", { count: summary.conflictCount })
      : null,
    summary.unsupportedCount > 0
      ? t("host.import.item.unsupported", {
          count: summary.unsupportedCount,
        })
      : null,
    summary.errorCount > 0
      ? t("host.import.item.error", { count: summary.errorCount })
      : null,
  ].filter(Boolean);

  return `${t("host.import.done")}：${parts.join("，")}`;
}

/** 将快捷命令中的常见转义序列还原为真实控制字符。 */
function decodeQuickCommandEscapes(input: string) {
  let output = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = input[i + 1];
    if (next === "n") {
      output += "\n";
      i += 1;
      continue;
    }
    if (next === "r") {
      output += "\r";
      i += 1;
      continue;
    }
    if (next === "t") {
      output += "\t";
      i += 1;
      continue;
    }
    if (next === "\\") {
      output += "\\";
      i += 1;
      continue;
    }
    output += char;
  }
  return output;
}

/** 统一终端提交符，避免 LF 在部分 shell 中触发续行而不执行。 */
function normalizeQuickCommandForSubmit(input: string) {
  // 在终端交互里，提交命令应使用 CR。将用户写的 LF/CRLF 统一折叠为 CR。
  return input.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

/** 应用主界面编排层。 */
export default function AppShell() {
  const themeIds = useMemo(() => Object.keys(themePresets) as ThemeId[], []);
  const {
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
    saveState: appSaveState,
    saveError: appSaveError,
    retrySave: retryAppSave,
  } = useAppSettings({
    themeIds,
    defaultThemeId: "dark",
  });
  const {
    aiAvailable,
    aiUnavailableReason,
    selectionMaxChars: aiSelectionMaxChars,
    sessionRecentOutputMaxChars: aiSessionRecentOutputMaxChars,
    requestTimeoutMs: aiRequestTimeoutMs,
    debugLoggingEnabled: aiDebugLoggingEnabled,
    activeProviderId: aiActiveProviderId,
    providers: aiProviders,
    activeProvider: aiActiveProvider,
    setSelectionMaxChars: setAiSelectionMaxChars,
    setSessionRecentOutputMaxChars: setAiSessionRecentOutputMaxChars,
    setRequestTimeoutMs: setAiRequestTimeoutMs,
    setDebugLoggingEnabled: setAiDebugLoggingEnabled,
    setActiveProviderId: setAiActiveProviderId,
    updateProviderName,
    updateProviderBaseUrl,
    updateProviderModel,
    updateProviderVendor,
    addPresetProviderWithConfig,
    addCompatibleProviderWithConfig,
    removeProvider,
    testProviderConnection,
    replaceProviderApiKey,
    clearProviderApiKey,
    saveState: aiSaveState,
    saveError: aiSaveError,
    retrySave: retryAiSave,
  } = useAiSettings();
  // 会话设置属于终端域全局配置，统一写入 session.json 并作用于所有终端会话。
  const {
    webLinksEnabled,
    commandAutocompleteEnabled,
    selectionAutoCopyEnabled,
    autoReconnectOnPoweroff,
    autoReconnectOnReboot,
    cursorStyle,
    terminalFontFamilyMode,
    wordSeparators: sessionWordSeparators,
    scrollback,
    terminalPathSyncEnabled,
    resourceMonitorEnabled,
    resourceMonitorIntervalSec,
    hostKeyPolicy,
    setWebLinksEnabled,
    setCommandAutocompleteEnabled,
    setSelectionAutoCopyEnabled,
    setAutoReconnectOnPoweroff,
    setAutoReconnectOnReboot,
    setCursorStyle,
    setTerminalFontFamilyMode,
    setScrollback,
    setTerminalPathSyncEnabled,
    setResourceMonitorEnabled,
    setResourceMonitorIntervalSec,
    setHostKeyPolicy,
    saveState: sessionSaveState,
    saveError: sessionSaveError,
    retrySave: retrySessionSave,
  } = useSessionSettings();
  const activeThemePreset = themePresets[themeId];
  const isBackgroundMediaRequested =
    backgroundImageEnabled && !!backgroundImageAsset;
  const normalizedBackgroundMediaType = useMemo(
    () => normalizeBackgroundMediaType(backgroundMediaType),
    [backgroundMediaType],
  );
  const normalizedBackgroundRenderMode = useMemo(
    () => normalizeBackgroundRenderMode(backgroundRenderMode),
    [backgroundRenderMode],
  );
  const normalizedBackgroundVideoReplayMode = useMemo(
    () => normalizeBackgroundVideoReplayMode(backgroundVideoReplayMode),
    [backgroundVideoReplayMode],
  );
  const normalizedBackgroundVideoReplayIntervalSec = useMemo(
    () =>
      clampBackgroundVideoReplayIntervalSec(backgroundVideoReplayIntervalSec),
    [backgroundVideoReplayIntervalSec],
  );
  const effectiveBackgroundRenderMode = useMemo(() => {
    if (
      normalizedBackgroundMediaType === "video" &&
      normalizedBackgroundRenderMode === "tile"
    ) {
      return "cover";
    }
    return normalizedBackgroundRenderMode;
  }, [normalizedBackgroundMediaType, normalizedBackgroundRenderMode]);
  const normalizedBackgroundImageSurfaceAlpha = useMemo(
    () => clampBackgroundImageSurfaceAlpha(backgroundImageSurfaceAlpha),
    [backgroundImageSurfaceAlpha],
  );
  const activeTerminalTheme = useMemo(
    () =>
      buildTerminalTheme(activeThemePreset, {
        translucentBackground: isBackgroundMediaRequested,
        // 终端外层 pane 已承担主要半透明层，xterm 画布只保留极轻底色避免双层叠深。
        translucentBackgroundAlpha: BACKGROUND_IMAGE_TERMINAL_CANVAS_ALPHA,
        // 终端会话区在背景图模式下改用语义 surface 基色，避免与其它面板出现色相割裂。
        translucentBackgroundBase: activeThemePreset.semantic.surface.strong,
      }),
    [activeThemePreset, isBackgroundMediaRequested],
  );
  const {
    profiles,
    sshGroups,
    activeProfileId,
    editingProfile,
    defaultProfile,
    pickProfile,
    saveProfile,
    duplicateProfile,
    removeProfile,
    reloadProfiles,
    importOpenSshConfig,
    addGroup,
    renameGroup,
    removeGroup,
    moveProfileToGroup,
  } = useProfiles();
  const {
    status: securityStatus,
    loaded: securityLoaded,
    busy: securityBusy,
    unlock: unlockSecurity,
    lock: lockSecurity,
    enableStrongProtection: enableSecurityWithPassword,
    changePassword: changeSecurityPassword,
    enableWeakProtection: enableSecurityWeakProtection,
  } = useSecurity();
  const { pushToast, openDialog } = useNotices();
  const [aboutOpen, setAboutOpen] = useState(false);
  useDisableBrowserShortcuts();
  usePreventBrowserDefaults();
  const [quickbarManagerOpen, setQuickbarManagerOpen] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [activeConfigSection, setActiveConfigSection] =
    useState<ConfigSectionKey>("general");
  const [footerVisibility, setFooterVisibility] = useState({
    quickbar: true,
    statusbar: true,
  });
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileModalMode, setProfileModalMode] = useState<"new" | "edit">(
    "new",
  );
  const [rdpProfileModalOpen, setRdpProfileModalOpen] = useState(false);
  const [rdpProfileModalMode, setRdpProfileModalMode] = useState<
    "new" | "edit"
  >("new");
  const [rdpProfileModalProfileId, setRdpProfileModalProfileId] = useState<
    string | null
  >(null);
  const [rdpProfileModalDefaultGroup, setRdpProfileModalDefaultGroup] =
    useState<string | null>(null);
  const [rdpProfiles, setRdpProfiles] = useState<RdpProfile[]>([]);
  const [rdpGroups, setRdpGroups] = useState<string[]>([]);
  const [activeRdpProfileId, setActiveRdpProfileId] = useState<string | null>(
    null,
  );
  const [profileDraft, setProfileDraft] = useState<HostProfile>(defaultProfile);
  const [localShellProfileModalOpen, setLocalShellProfileModalOpen] =
    useState(false);
  const [activeLocalShellProfile, setActiveLocalShellProfile] =
    useState<LocalShellProfile | null>(null);
  const [localShellProfileDraft, setLocalShellProfileDraft] =
    useState<LocalShellConfig>(DEFAULT_LOCAL_SHELL_CONFIG);
  const [connectingSshProfiles, setConnectingSshProfiles] =
    useState<SshConnectStateMap>({});
  const sshConnectRuntimeRef = useRef<Record<string, PendingSshConnectRuntime>>(
    {},
  );
  const nextSshConnectRequestIdRef = useRef(0);
  const isMac = useMemo(() => isMacOS(), []);

  const t: Translate = useMemo(
    () => (key, vars) =>
      formatMessage(getTranslationMessage(locale, key), vars),
    [locale],
  );
  const appUpdater = useAppUpdater({
    onToast: ({ level, message }) => {
      pushToast({ level, message });
    },
    upToDateMessage: t("about.updateCheckUpToDateToast"),
    updateCheckFailedMessage: t("about.updateCheckFailedToast"),
  });
  const handleCloseAbout = useCallback(() => {
    setAboutOpen(false);
    appUpdater.resetCheckState();
  }, [appUpdater]);
  const setSshConnectingState = useCallback(
    (profileId: string, active: boolean) => {
      setConnectingSshProfiles((prev) => {
        if (active) {
          if (prev[profileId]) return prev;
          return {
            ...prev,
            [profileId]: { cancellable: true },
          };
        }
        if (!prev[profileId]) return prev;
        const next = { ...prev };
        delete next[profileId];
        return next;
      });
    },
    [],
  );
  const aiUnavailableMessage = useMemo(() => {
    if (!aiUnavailableReason) return null;
    if (aiUnavailableReason === "provider_incomplete") {
      return t("ai.unavailable.providerIncomplete");
    }
    return t("ai.unavailable.generic");
  }, [aiUnavailableReason, t]);
  const floatingWidgetKey = useMemo<WidgetKey | null>(() => {
    const match = window.location.hash.match(/widget=([a-z]+)/i);
    if (!match) return null;
    const value = match[1];
    if (value === "profiles") return "profiles";
    if (value === "rdp") return "rdp";
    if (value === "files") return "files";
    if (value === "transfers") return "transfers";
    if (value === "events") return "events";
    if (value === "history") return "history";
    if (value === "ai") return "ai";
    if (value === "tunnels") return "tunnels";
    if (value === "logs") return "events";
    return null;
  }, []);
  const layoutMenuDisabled = Boolean(floatingWidgetKey);
  const shouldDeferFloatingWindowReveal = Boolean(floatingWidgetKey);
  const {
    activeBackgroundMediaType,
    backgroundMediaBlobUrl,
    backgroundVideoRef,
    handleBackgroundVideoEnded,
  } = useMainAppearance({
    locale,
    themeId,
    activeThemePreset,
    settingsLoaded,
    isBackgroundMediaRequested,
    backgroundImageAsset,
    backgroundImageSurfaceAlpha: normalizedBackgroundImageSurfaceAlpha,
    backgroundMediaType: normalizedBackgroundMediaType,
    backgroundRenderMode: effectiveBackgroundRenderMode,
    backgroundVideoReplayMode: normalizedBackgroundVideoReplayMode,
    backgroundVideoReplayIntervalSec:
      normalizedBackgroundVideoReplayIntervalSec,
    shouldDeferFloatingWindowReveal,
  });
  const terminalSizeRef = useRef({ cols: 80, rows: 24 });
  const [floatingFilesSnapshot, setFloatingFilesSnapshot] =
    useState<FloatingFilesSnapshot | null>(null);
  const [floatingTransfersSnapshot, setFloatingTransfersSnapshot] =
    useState<FloatingTransfersSnapshot | null>(null);
  const [floatingEventsSnapshot, setFloatingEventsSnapshot] =
    useState<FloatingEventsSnapshot | null>(null);
  const [floatingHistorySnapshot, setFloatingHistorySnapshot] =
    useState<FloatingHistorySnapshot | null>(null);
  const [floatingHistorySearchQuery, setFloatingHistorySearchQuery] =
    useState("");
  const [floatingAiSnapshot, setFloatingAiSnapshot] =
    useState<FloatingAiSnapshot | null>(null);
  const [floatingTunnelsSnapshot, setFloatingTunnelsSnapshot] =
    useState<FloatingTunnelsSnapshot | null>(null);
  const [bellPendingBySession, setBellPendingBySession] = useState<
    Record<string, boolean>
  >({});
  const focusActiveTerminalRef = useRef<() => boolean>(() => false);

  const openNewProfile = useCallback(
    (defaultGroup?: string | null) => {
      const normalizedDefaultGroup = defaultGroup?.trim() ?? "";
      setProfileModalMode("new");
      setProfileDraft({
        ...defaultProfile,
        id: "",
        tags: normalizedDefaultGroup ? [normalizedDefaultGroup] : null,
      });
      setProfileModalOpen(true);
    },
    [defaultProfile],
  );

  function closeProfileModal() {
    setProfileModalOpen(false);
  }

  const refreshRdpProfiles = useCallback(async () => {
    const [next, persistedGroups] = await Promise.all([
      listRdpProfiles(),
      listRdpProfileGroups(),
    ]);
    setRdpProfiles(next);
    const discoveredGroups = next
      .map((item) => normalizeRdpGroupName(item.tags?.[0] ?? ""))
      .filter(Boolean);
    setRdpGroups(dedupeRdpGroups([...persistedGroups, ...discoveredGroups]));
    setActiveRdpProfileId((current) => {
      if (current && next.some((item) => item.id === current)) {
        return current;
      }
      return next[0]?.id ?? null;
    });
    return next;
  }, []);

  const openNewRdpProfileModal = useCallback((defaultGroup?: string | null) => {
    setRdpProfileModalMode("new");
    setRdpProfileModalProfileId(null);
    setRdpProfileModalDefaultGroup(defaultGroup?.trim() || null);
    setRdpProfileModalOpen(true);
  }, []);

  const openEditRdpProfileModal = useCallback((profile: RdpProfile) => {
    setActiveRdpProfileId(profile.id);
    setRdpProfileModalMode("edit");
    setRdpProfileModalProfileId(profile.id);
    setRdpProfileModalDefaultGroup(null);
    setRdpProfileModalOpen(true);
  }, []);

  function closeRdpProfileModal() {
    setRdpProfileModalOpen(false);
    setRdpProfileModalProfileId(null);
    setRdpProfileModalDefaultGroup(null);
  }

  useEffect(() => {
    const cancel = scheduleDeferredTask(() => {
      void refreshRdpProfiles().catch(() => {});
    });
    return cancel;
  }, [refreshRdpProfiles]);

  useEffect(() => {
    const handleFocus = () => {
      void refreshRdpProfiles().catch(() => {});
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshRdpProfiles]);

  const openLocalShellProfile = useCallback(
    (shell: LocalShellProfile) => {
      setActiveLocalShellProfile(shell);
      setLocalShellProfileDraft(
        normalizeLocalShellConfig(localShellProfiles[shell.id]),
      );
      setLocalShellProfileModalOpen(true);
    },
    [localShellProfiles],
  );

  function closeLocalShellProfileModal() {
    setLocalShellProfileModalOpen(false);
    setActiveLocalShellProfile(null);
  }

  function openEditProfile(profile: HostProfile) {
    if (!profile.id) return;
    setProfileModalMode("edit");
    setProfileDraft(profile);
    setProfileModalOpen(true);
  }

  async function submitProfile() {
    await saveProfile({
      ...profileDraft,
      bellMode:
        normalizeTerminalBellMode(profileDraft.bellMode) ??
        DEFAULT_TERMINAL_BELL_MODE,
      bellCooldownMs:
        normalizeTerminalBellCooldownMs(profileDraft.bellCooldownMs) ??
        DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
    });
    setProfileModalOpen(false);
  }

  function submitLocalShellProfile() {
    if (!activeLocalShellProfile) return;
    const nextConfig = normalizeLocalShellConfig(localShellProfileDraft);
    setLocalShellProfiles((prev) => ({
      ...prev,
      [activeLocalShellProfile.id]: nextConfig,
    }));
    setLocalShellProfileModalOpen(false);
    setActiveLocalShellProfile(null);
  }

  const configNavigation = useMemo(() => buildConfigNavigation(t), [t]);
  const configModalNavSections = useMemo(
    () =>
      getScopedConfigNavEntries(
        configNavigation.navEntries,
        activeConfigSection,
      ),
    [activeConfigSection, configNavigation.navEntries],
  );

  /** 打开统一配置模态框，并切换到指定配置分区。 */
  function openConfigSection(section: ConfigSectionKey) {
    setActiveConfigSection(section);
    setConfigModalOpen(true);
  }

  const widgetLabels = useMemo(
    () => ({
      profiles: t(widgetLabelKeys.profiles),
      rdp: t(widgetLabelKeys.rdp),
      files: t(widgetLabelKeys.files),
      transfers: t(widgetLabelKeys.transfers),
      events: t(widgetLabelKeys.events),
      history: t(widgetLabelKeys.history),
      ai: t(widgetLabelKeys.ai),
      tunnels: t(widgetLabelKeys.tunnels),
    }),
    [t],
  );

  const { sessionState, sessionActions, sessionRefs } = useSessionController({
    profiles,
    t,
    shellId,
    localShellProfiles,
    availableShells,
    settingsLoaded,
    autoReconnectOnPoweroff,
    autoReconnectOnReboot,
    getTerminalSize: () => terminalSizeRef.current,
  });
  const { openManagedRemoteFile, openManagedLocalFile } = useRemoteEditSessions(
    {
      sessions: sessionState.sessions,
      profiles,
      sessionStates: sessionState.sessionStates,
      fileDefaultEditorPath,
      t,
      pushToast,
      openDialog,
    },
  );
  const tunnelState = useSshTunnelState(sessionState.activeSessionId);
  const activeTunnelSessionMeta = useMemo(() => {
    if (!sessionState.activeSessionId) {
      return {
        label: null as string | null,
        host: null as string | null,
        username: null as string | null,
      };
    }
    if (sessionState.isRemoteSession && sessionState.activeSessionProfile) {
      const profile = sessionState.activeSessionProfile;
      return {
        label: profile.name || profile.host || t("session.defaultName"),
        host: profile.host,
        username: profile.username,
      };
    }
    return {
      label:
        sessionState.localSessionMeta[sessionState.activeSessionId]?.label ??
        t("session.local"),
      host: "local",
      username: null,
    };
  }, [
    sessionState.activeSessionId,
    sessionState.activeSessionProfile,
    sessionState.isRemoteSession,
    sessionState.localSessionMeta,
    t,
  ]);

  const historyState = useCommandHistoryState({
    activeSessionId: sessionState.activeSessionId,
    writeToSession: sessionActions.writeToSession,
    focusActiveTerminal: () => focusActiveTerminalRef.current(),
  });

  const aiState = useAiState({
    activeSessionId: sessionState.activeSessionId,
    locale,
    debugLoggingEnabled: aiDebugLoggingEnabled,
    aiAvailable,
    aiUnavailableMessage,
    selectionMaxChars: aiSelectionMaxChars,
    enabled: floatingWidgetKey !== "ai",
  });

  const autocompleteProvider = useMemo(
    () =>
      commandAutocompleteEnabled
        ? createHistoryAutocompleteProvider(historyState.globalItems)
        : null,
    [commandAutocompleteEnabled, historyState.globalItems],
  );
  const terminalPathSyncHandlersRef = useRef<{
    handleWorkingDirectoryChange: (
      sessionId: string,
      payload: TerminalWorkingDirectory,
    ) => void;
    handlePathSyncSupportChange: (
      sessionId: string,
      status: TerminalCwdSupport,
    ) => void;
  }>({
    handleWorkingDirectoryChange: () => {},
    handlePathSyncSupportChange: () => {},
  });

  const { terminalQuery, terminalActions } = useTerminalController({
    theme: activeTerminalTheme,
    webLinksEnabled,
    selectionAutoCopyEnabled,
    cursorStyle,
    terminalFontFamilyMode,
    scrollback,
    activeSessionId: sessionState.activeSessionId,
    activeSession: sessionState.activeSession,
    sessions: sessionState.sessions,
    sessionStatesRef: sessionRefs.sessionStatesRef,
    sessionReasonsRef: sessionRefs.sessionReasonsRef,
    sessionBuffersRef: sessionRefs.sessionBuffersRef,
    setLastCommand: sessionActions.setLastCommand,
    sendSessionInput: sessionActions.sendSessionInput,
    resizeSession: sessionActions.resizeSession,
    onWorkingDirectoryChange: (sessionId, payload) => {
      terminalPathSyncHandlersRef.current.handleWorkingDirectoryChange(
        sessionId,
        payload,
      );
    },
    onPathSyncSupportChange: (sessionId, status) => {
      terminalPathSyncHandlersRef.current.handlePathSyncSupportChange(
        sessionId,
        status,
      );
    },
    isLocalSession: sessionActions.isLocalSession,
    reconnectSession: sessionActions.reconnectSession,
    reconnectLocalShell: sessionActions.reconnectLocalShell,
    triggerScheduledReconnectNow: sessionActions.triggerScheduledReconnectNow,
    onCommandCaptureChange: (sessionId, capture) => {
      historyState.updateLiveCapture({
        sessionId,
        command: capture.command,
        state: capture.state,
      });
    },
    onCommandCommit: (sessionId, command) => {
      historyState.recordCommand({
        sessionId,
        command,
        source: "typed",
      });
    },
    autocompleteProvider,
    onSizeChange: (size) => {
      terminalSizeRef.current = size;
    },
    onBell: (sessionId) => {
      if (sessionState.activeSessionId === sessionId) {
        return;
      }
      setBellPendingBySession((prev) =>
        prev[sessionId] ? prev : { ...prev, [sessionId]: true },
      );
    },
    resolveBellConfig: (sessionId) => {
      const localMeta = sessionState.localSessionMeta[sessionId];
      if (localMeta) {
        const localShellConfig = normalizeLocalShellConfig(
          localMeta.launchConfig,
        );
        return {
          mode: localShellConfig.bellMode ?? DEFAULT_TERMINAL_BELL_MODE,
          cooldownMs:
            localShellConfig.bellCooldownMs ??
            DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
        };
      }
      const session = sessionState.sessions.find(
        (item) => item.sessionId === sessionId,
      );
      const profile = session
        ? (profiles.find((item) => item.id === session.profileId) ?? null)
        : null;
      return {
        mode:
          normalizeTerminalBellMode(profile?.bellMode) ??
          DEFAULT_TERMINAL_BELL_MODE,
        cooldownMs:
          normalizeTerminalBellCooldownMs(profile?.bellCooldownMs) ??
          DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
      };
    },
    resolveWordSeparators: (sessionId) => {
      const fallbackWordSeparators =
        normalizeTerminalWordSeparators(sessionWordSeparators) ??
        DEFAULT_TERMINAL_WORD_SEPARATORS;
      const localMeta = sessionState.localSessionMeta[sessionId];
      if (localMeta) {
        const localShellConfig = normalizeLocalShellConfig(
          localMeta.launchConfig,
        );
        return (
          normalizeTerminalWordSeparators(localShellConfig.wordSeparators) ??
          fallbackWordSeparators
        );
      }
      const session = sessionState.sessions.find(
        (item) => item.sessionId === sessionId,
      );
      if (!session) return fallbackWordSeparators;
      const profile =
        profiles.find((item) => item.id === session.profileId) ?? null;
      return (
        normalizeTerminalWordSeparators(profile?.wordSeparators) ??
        fallbackWordSeparators
      );
    },
  });
  useEffect(() => {
    focusActiveTerminalRef.current = terminalActions.focusActiveTerminal;
  }, [terminalActions.focusActiveTerminal]);

  useEffect(() => {
    const activeSessionId = sessionState.activeSessionId;
    if (!activeSessionId) return;
    const cancel = scheduleDeferredTask(() => {
      setBellPendingBySession((prev) => {
        if (!prev[activeSessionId]) return prev;
        const next = { ...prev };
        delete next[activeSessionId];
        return next;
      });
    });
    return cancel;
  }, [sessionState.activeSessionId]);

  const isFloatingFilesWidget = floatingWidgetKey === "files";
  const isFloatingTransfersWidget = floatingWidgetKey === "transfers";
  const isFloatingEventsWidget = floatingWidgetKey === "events";
  const isFloatingHistoryWidget = floatingWidgetKey === "history";
  const isFloatingAiWidget = floatingWidgetKey === "ai";
  const isFloatingTunnelsWidget = floatingWidgetKey === "tunnels";

  const {
    showGroupTitle,
    setShowGroupTitle,
    groups: quickbarGroups,
    commands: quickbarCommands,
    addGroup: addQuickbarGroup,
    renameGroup: renameQuickbarGroup,
    removeGroup: removeQuickbarGroup,
    toggleGroupVisible: toggleQuickbarGroupVisible,
    addCommand: addQuickbarCommand,
    updateCommand: updateQuickbarCommand,
    reorderCommands: reorderQuickbarCommands,
    removeCommand: removeQuickbarCommand,
  } = useQuickBarState(t);

  const {
    layoutCollapsed,
    sideSlotCounts,
    slotGroups,
    floatingOrigins,
    leftVisible,
    rightVisible,
    bottomVisible,
    layoutVars,
    setSlotGroups,
    setFloatingOrigins,
    setWidgetCollapsed,
    handleToggleSplit,
    handleCloseSlot,
    handleToggleCollapsed,
    startResize,
  } = useLayoutState({
    floatingWidgetKey,
  });
  const openCurrentDevtools = useMemo(
    () => () => {
      callTauri("open_devtools").catch(() => {});
    },
    [],
  );
  const {
    subApps,
    launchSubApp,
    focusSubApp,
    closeSubApp,
    connectRdpProfile,
    openAllDevtools: openAllSubAppDevtools,
    notifyMainShutdown,
  } = useSubApps({
    t,
    appearance: {
      locale,
      themeId,
      backgroundImageEnabled,
      backgroundImageAsset,
      backgroundImageSurfaceAlpha: normalizedBackgroundImageSurfaceAlpha,
      backgroundMediaType: normalizedBackgroundMediaType,
      backgroundRenderMode: normalizedBackgroundRenderMode,
      backgroundVideoReplayMode: normalizedBackgroundVideoReplayMode,
      backgroundVideoReplayIntervalSec:
        normalizedBackgroundVideoReplayIntervalSec,
    },
  });

  const { floatingWidgets, handleFloat, openAllDevtools } = useFloatingWidgets({
    floatingWidgetKey,
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
    backgroundImageSurfaceAlpha: normalizedBackgroundImageSurfaceAlpha,
    backgroundMediaType: normalizedBackgroundMediaType,
    backgroundRenderMode: normalizedBackgroundRenderMode,
    backgroundVideoReplayMode: normalizedBackgroundVideoReplayMode,
    backgroundVideoReplayIntervalSec:
      normalizedBackgroundVideoReplayIntervalSec,
    setLocale,
    setThemeId,
    setBackgroundImageEnabled,
    setBackgroundImageAsset,
    setBackgroundImageSurfaceAlpha,
    setBackgroundMediaType,
    setBackgroundRenderMode,
    setBackgroundVideoReplayMode,
    setBackgroundVideoReplayIntervalSec,
    onOpenCurrentDevtools: openCurrentDevtools,
    onMainShutdown: notifyMainShutdown,
  });
  function handleOpenDevtools() {
    openCurrentDevtools();
    openAllDevtools();
    openAllSubAppDevtools();
  }

  const isMainSlotVisible = useCallback(
    (slot: WidgetSlotId) => {
      if (slot === "bottom") return !layoutCollapsed.bottom;
      return slot.startsWith("left:")
        ? !layoutCollapsed.left
        : !layoutCollapsed.right;
    },
    [layoutCollapsed.bottom, layoutCollapsed.left, layoutCollapsed.right],
  );

  const availableWidgets = useMemo(() => {
    // 允许把已在主窗口某个槽位中的组件“移到”当前槽位，
    // 因此这里不再按主窗口占用情况过滤候选项。
    // floating 中的组件仍然是独立可见实例，因此继续占用。
    const occupied = new Set<WidgetKey>();
    Object.keys(floatingOrigins).forEach((widget) => {
      occupied.add(widget as WidgetKey);
    });
    return widgetKeys.filter((widget) => !occupied.has(widget));
  }, [floatingOrigins]);
  const filesWidgetVisible = useMemo(() => {
    if (floatingWidgetKey === "files") return true;
    if (floatingWidgets.files) return true;
    return Object.entries(slotGroups).some(
      ([slot, group]) =>
        isMainSlotVisible(slot as WidgetSlotId) && group.active === "files",
    );
  }, [floatingWidgetKey, floatingWidgets.files, isMainSlotVisible, slotGroups]);

  const { sftpState, sftpActions } = useSftpController({
    enabled: sftpEnabled,
    active: filesWidgetVisible,
    activeSessionId: sessionState.activeSessionId,
    activeSession: sessionState.activeSession,
    activeSessionProfile: sessionState.activeSessionProfile,
    activeSessionState: sessionState.activeSessionState,
    sessionStatesRef: sessionRefs.sessionStatesRef,
    isLocalSession: sessionActions.isLocalSession,
    appendAppEvent: sessionActions.appendAppEvent,
    setBusyMessage: sessionActions.setBusyMessage,
    t,
  });
  const {
    refreshList,
    openRemoteDir,
    uploadFile,
    uploadDroppedPaths,
    downloadFile,
    cancelTransfer,
    createFolder,
    rename: renameEntry,
    remove: removeEntry,
  } = sftpActions;
  const activeSftpAvailability = useMemo(() => {
    const activeSessionId = sessionState.activeSessionId;
    if (!activeSessionId) return "ready";
    if (sessionActions.isLocalSession(activeSessionId)) return "ready";
    if (!sftpEnabled || !filesWidgetVisible) return "disabled";
    return sftpState.availabilityBySession[activeSessionId] ?? "checking";
  }, [
    sessionActions,
    sessionState.activeSessionId,
    filesWidgetVisible,
    sftpEnabled,
    sftpState.availabilityBySession,
  ]);
  const {
    activeTerminalPathSyncStatus,
    handleWorkingDirectoryChange,
    handlePathSyncSupportChange,
  } = useTerminalPathSync({
    enabled: terminalPathSyncEnabled,
    filesWidgetVisible,
    sftpEnabled,
    activeSessionId: sessionState.activeSessionId,
    activeSessionProfile: sessionState.activeSessionProfile,
    isRemoteConnected: sessionState.isRemoteConnected,
    localSessionMeta: sessionState.localSessionMeta,
    currentPath: sftpState.currentPath,
    activeSftpAvailability,
    isLocalSession: sessionActions.isLocalSession,
    openRemoteDir,
  });

  useEffect(() => {
    terminalPathSyncHandlersRef.current = {
      handleWorkingDirectoryChange,
      handlePathSyncSupportChange,
    };
  }, [handlePathSyncSupportChange, handleWorkingDirectoryChange]);

  const { activeResourceSnapshot, activeResourceMonitorStatus } =
    useSessionResourceMonitor({
      enabled: resourceMonitorEnabled,
      intervalSec: resourceMonitorIntervalSec,
      activeSessionId: sessionState.activeSessionId,
      activeSessionState: sessionState.activeSessionState,
      activeSessionProfile: sessionState.activeSessionProfile,
      isLocalSession: sessionActions.isLocalSession,
    });

  useFloatingWidgetSnapshotSync<FloatingFilesMessage>({
    channelName: WIDGET_FILES_CHANNEL,
    floatingWidgetKey,
    isFloatingWidget: isFloatingFilesWidget,
    broadcastSnapshot: (channel) => {
      const payload: FloatingFilesSnapshot = {
        activeSessionId: sessionState.activeSessionId,
        isRemoteSession: sessionState.isRemoteSession,
        isRemoteConnected: sessionState.isRemoteConnected,
        sftpAvailability: activeSftpAvailability,
        terminalPathSyncStatus: activeTerminalPathSyncStatus,
        currentPath: sftpState.currentPath,
        entries: sftpState.entries,
      };
      channel.postMessage({
        type: "files:snapshot",
        payload,
      } satisfies FloatingFilesMessage);
    },
    onMainWindowMessage: (message, channel) => {
      switch (message.type) {
        case "files:request-snapshot": {
          const payload: FloatingFilesSnapshot = {
            activeSessionId: sessionState.activeSessionId,
            isRemoteSession: sessionState.isRemoteSession,
            isRemoteConnected: sessionState.isRemoteConnected,
            sftpAvailability: activeSftpAvailability,
            terminalPathSyncStatus: activeTerminalPathSyncStatus,
            currentPath: sftpState.currentPath,
            entries: sftpState.entries,
          };
          channel.postMessage({
            type: "files:snapshot",
            payload,
          } satisfies FloatingFilesMessage);
          break;
        }
        case "files:refresh":
          refreshList(message.path).catch(() => {});
          break;
        case "files:open":
          openRemoteDir(message.path).catch(() => {});
          break;
        case "files:open-file":
          if (!sessionState.activeSessionId) break;
          if (sessionState.isRemoteConnected) {
            openManagedRemoteFile(
              sessionState.activeSessionId,
              message.entry,
            ).catch((error) => {
              pushToast({
                level: "error",
                message: translateAppError(error, t),
              });
            });
          } else {
            openManagedLocalFile(message.entry).catch((error) => {
              pushToast({
                level: "error",
                message: translateAppError(error, t),
              });
            });
          }
          break;
        case "files:upload":
          uploadFile().catch(() => {});
          break;
        case "files:upload-paths":
          uploadDroppedPaths(message.paths).catch(() => {});
          break;
        case "files:download":
          downloadFile(message.entry).catch(() => {});
          break;
        case "files:mkdir":
          createFolder(message.name).catch(() => {});
          break;
        case "files:rename":
          renameEntry(message.entry, message.name).catch(() => {});
          break;
        case "files:remove":
          removeEntry(message.entry).catch(() => {});
          break;
        case "files:snapshot":
          break;
      }
    },
    onFloatingWindowMessage: (message) => {
      if (message.type === "files:snapshot") {
        setFloatingFilesSnapshot(message.payload);
      }
    },
    requestSnapshot: (channel) => {
      channel.postMessage({
        type: "files:request-snapshot",
      } satisfies FloatingFilesMessage);
    },
    deps: [
      sessionState.activeSessionId,
      sessionState.isRemoteConnected,
      sessionState.isRemoteSession,
      createFolder,
      downloadFile,
      activeSftpAvailability,
      activeTerminalPathSyncStatus,
      sftpState.currentPath,
      sftpState.entries,
      openRemoteDir,
      refreshList,
      removeEntry,
      renameEntry,
      uploadFile,
      uploadDroppedPaths,
      openManagedRemoteFile,
      openManagedLocalFile,
      pushToast,
      t,
    ],
  });

  useFloatingWidgetSnapshotSync<FloatingTransfersMessage>({
    channelName: WIDGET_TRANSFERS_CHANNEL,
    floatingWidgetKey,
    isFloatingWidget: isFloatingTransfersWidget,
    broadcastSnapshot: (channel) => {
      const activeSessionId = sessionState.activeSessionId;
      const payload: FloatingTransfersSnapshot = {
        activeSessionId,
        progress: activeSessionId
          ? (sftpState.progressBySession[activeSessionId] ?? null)
          : null,
        busyMessage: sessionState.busyMessage,
        events: sessionState.appEvents,
      };
      channel.postMessage({
        type: "transfers:snapshot",
        payload,
      } satisfies FloatingTransfersMessage);
    },
    onMainWindowMessage: (message, channel) => {
      switch (message.type) {
        case "transfers:request-snapshot": {
          const activeSessionId = sessionState.activeSessionId;
          const payload: FloatingTransfersSnapshot = {
            activeSessionId,
            progress: activeSessionId
              ? (sftpState.progressBySession[activeSessionId] ?? null)
              : null,
            busyMessage: sessionState.busyMessage,
            events: sessionState.appEvents,
          };
          channel.postMessage({
            type: "transfers:snapshot",
            payload,
          } satisfies FloatingTransfersMessage);
          break;
        }
        case "transfers:cancel":
          cancelTransfer().catch(() => {});
          break;
        case "transfers:snapshot":
          break;
      }
    },
    onFloatingWindowMessage: (message) => {
      if (message.type === "transfers:snapshot") {
        setFloatingTransfersSnapshot(message.payload);
      }
    },
    requestSnapshot: (channel) => {
      channel.postMessage({
        type: "transfers:request-snapshot",
      } satisfies FloatingTransfersMessage);
    },
    deps: [
      cancelTransfer,
      sessionState.activeSessionId,
      sessionState.appEvents,
      sessionState.busyMessage,
      sftpState.progressBySession,
    ],
  });

  useFloatingWidgetSnapshotSync<FloatingEventsMessage>({
    channelName: WIDGET_EVENTS_CHANNEL,
    floatingWidgetKey,
    isFloatingWidget: isFloatingEventsWidget,
    broadcastSnapshot: (channel) => {
      const payload: FloatingEventsSnapshot = {
        sessionState: sessionState.activeSessionState ?? "disconnected",
        sessionReason: sessionState.activeSessionReason,
        reconnectInfo: sessionState.activeReconnectInfo,
        events: sessionState.appEvents,
      };
      channel.postMessage({
        type: "events:snapshot",
        payload,
      } satisfies FloatingEventsMessage);
    },
    onMainWindowMessage: (message, channel) => {
      switch (message.type) {
        case "events:request-snapshot": {
          const payload: FloatingEventsSnapshot = {
            sessionState: sessionState.activeSessionState ?? "disconnected",
            sessionReason: sessionState.activeSessionReason,
            reconnectInfo: sessionState.activeReconnectInfo,
            events: sessionState.appEvents,
          };
          channel.postMessage({
            type: "events:snapshot",
            payload,
          } satisfies FloatingEventsMessage);
          break;
        }
        case "events:snapshot":
          break;
      }
    },
    onFloatingWindowMessage: (message) => {
      if (message.type === "events:snapshot") {
        setFloatingEventsSnapshot(message.payload);
      }
    },
    requestSnapshot: (channel) => {
      channel.postMessage({
        type: "events:request-snapshot",
      } satisfies FloatingEventsMessage);
    },
    deps: [
      sessionState.activeSessionState,
      sessionState.activeSessionReason,
      sessionState.activeReconnectInfo,
      sessionState.appEvents,
    ],
  });

  const handleExecuteHistoryItem = useCallback(
    (command: string) => {
      historyState
        .executeHistoryItem({
          sessionId: sessionState.activeSessionId,
          command,
        })
        .then((executed) => {
          if (!executed || !sessionState.activeSessionId) return;
          historyState.recordCommand({
            sessionId: sessionState.activeSessionId,
            command,
            source: "history",
          });
        })
        .catch(() => {});
    },
    [historyState, sessionState.activeSessionId],
  );

  useFloatingWidgetSnapshotSync<FloatingHistoryMessage>({
    channelName: WIDGET_HISTORY_CHANNEL,
    floatingWidgetKey,
    isFloatingWidget: isFloatingHistoryWidget,
    broadcastSnapshot: (channel) => {
      const payload: FloatingHistorySnapshot = {
        activeSessionId: sessionState.activeSessionId,
        hasActiveSession: !!sessionState.activeSessionId,
        liveCapture: historyState.activeLiveCapture,
        items: historyState.activeSessionItems,
      };
      channel.postMessage({
        type: "history:snapshot",
        payload,
      } satisfies FloatingHistoryMessage);
    },
    onMainWindowMessage: (message, channel) => {
      switch (message.type) {
        case "history:request-snapshot": {
          const payload: FloatingHistorySnapshot = {
            activeSessionId: sessionState.activeSessionId,
            hasActiveSession: !!sessionState.activeSessionId,
            liveCapture: historyState.activeLiveCapture,
            items: historyState.activeSessionItems,
          };
          channel.postMessage({
            type: "history:snapshot",
            payload,
          } satisfies FloatingHistoryMessage);
          break;
        }
        case "history:execute":
          handleExecuteHistoryItem(message.command);
          break;
        case "history:snapshot":
          break;
      }
    },
    onFloatingWindowMessage: (message) => {
      if (message.type === "history:snapshot") {
        setFloatingHistorySnapshot(message.payload);
      }
    },
    requestSnapshot: (channel) => {
      channel.postMessage({
        type: "history:request-snapshot",
      } satisfies FloatingHistoryMessage);
    },
    deps: [
      historyState.activeLiveCapture,
      historyState.activeSessionItems,
      sessionState.activeSessionId,
      handleExecuteHistoryItem,
    ],
  });

  const fillCodeToActiveTerminal = useCallback(
    async (code: string) => {
      const sessionId = sessionState.activeSessionId;
      if (!sessionId) {
        sessionActions.setBusyMessage(t("quickbar.noSession"));
        window.setTimeout(() => {
          sessionActions.setBusyMessage((prev) =>
            prev === t("quickbar.noSession") ? null : prev,
          );
        }, 1500);
        return;
      }

      terminalActions.focusActiveTerminal();
      const localMeta = sessionState.localSessionMeta[sessionId] ?? null;
      const clearInputSequence =
        sessionActions.isLocalSession(sessionId) &&
        localMeta?.shellKind !== "wsl"
          ? "\u001b"
          : "\u0015";
      await sessionActions.writeToSession(sessionId, clearInputSequence);
      await sessionActions.writeToSession(sessionId, code);
    },
    [
      sessionActions,
      sessionState.activeSessionId,
      sessionState.localSessionMeta,
      t,
      terminalActions,
    ],
  );

  useFloatingWidgetSnapshotSync<FloatingAiMessage>({
    channelName: WIDGET_AI_CHANNEL,
    floatingWidgetKey,
    isFloatingWidget: isFloatingAiWidget,
    broadcastSnapshot: (channel) => {
      const payload: FloatingAiSnapshot = {
        activeSessionId: sessionState.activeSessionId,
        messages: aiState.messages,
        draft: aiState.draft,
        pending: aiState.pending,
        waitingFirstChunk: aiState.waitingFirstChunk,
        errorMessage: aiState.errorMessage,
        aiAvailable,
        aiUnavailableMessage,
      };
      channel.postMessage({
        type: "ai:snapshot",
        payload,
      } satisfies FloatingAiMessage);
    },
    onMainWindowMessage: (message, channel) => {
      switch (message.type) {
        case "ai:request-snapshot": {
          const payload: FloatingAiSnapshot = {
            activeSessionId: sessionState.activeSessionId,
            messages: aiState.messages,
            draft: aiState.draft,
            pending: aiState.pending,
            waitingFirstChunk: aiState.waitingFirstChunk,
            errorMessage: aiState.errorMessage,
            aiAvailable,
            aiUnavailableMessage,
          };
          channel.postMessage({
            type: "ai:snapshot",
            payload,
          } satisfies FloatingAiMessage);
          break;
        }
        case "ai:set-draft":
          aiState.setDraft(message.draft);
          break;
        case "ai:send":
          aiState.sendMessage().catch(() => {});
          break;
        case "ai:cancel":
          aiState.cancelMessage();
          break;
        case "ai:clear":
          aiState.clearMessages();
          break;
        case "ai:send-code-to-terminal":
          fillCodeToActiveTerminal(message.code).catch(() => {});
          break;
        case "ai:snapshot":
          break;
      }
    },
    onFloatingWindowMessage: (message) => {
      if (message.type === "ai:snapshot") {
        setFloatingAiSnapshot(message.payload);
      }
    },
    requestSnapshot: (channel) => {
      channel.postMessage({
        type: "ai:request-snapshot",
      } satisfies FloatingAiMessage);
    },
    deps: [
      aiAvailable,
      aiState.draft,
      aiState.errorMessage,
      aiState.messages,
      aiState.pending,
      aiState.waitingFirstChunk,
      aiUnavailableMessage,
      fillCodeToActiveTerminal,
      sessionState.activeSessionId,
    ],
  });

  useFloatingWidgetSnapshotSync<FloatingTunnelsMessage>({
    channelName: WIDGET_TUNNELS_CHANNEL,
    floatingWidgetKey,
    isFloatingWidget: isFloatingTunnelsWidget,
    broadcastSnapshot: (channel) => {
      const payload: FloatingTunnelsSnapshot = {
        activeSessionId: sessionState.activeSessionId,
        supportsSshTunnel: sessionState.isRemoteSession,
        sessionState: sessionState.activeSessionState ?? "disconnected",
        sessionLabel: activeTunnelSessionMeta.label,
        sessionHost: activeTunnelSessionMeta.host,
        sessionUsername: activeTunnelSessionMeta.username,
        tunnels: tunnelState.activeTunnels,
      };
      channel.postMessage({
        type: "tunnels:snapshot",
        payload,
      } satisfies FloatingTunnelsMessage);
    },
    onMainWindowMessage: (message, channel) => {
      switch (message.type) {
        case "tunnels:request-snapshot": {
          const payload: FloatingTunnelsSnapshot = {
            activeSessionId: sessionState.activeSessionId,
            supportsSshTunnel: sessionState.isRemoteSession,
            sessionState: sessionState.activeSessionState ?? "disconnected",
            sessionLabel: activeTunnelSessionMeta.label,
            sessionHost: activeTunnelSessionMeta.host,
            sessionUsername: activeTunnelSessionMeta.username,
            tunnels: tunnelState.activeTunnels,
          };
          channel.postMessage({
            type: "tunnels:snapshot",
            payload,
          } satisfies FloatingTunnelsMessage);
          break;
        }
        case "tunnels:open":
          tunnelState.open(message.spec).catch(() => {});
          break;
        case "tunnels:close":
          tunnelState.close(message.tunnelId).catch(() => {});
          break;
        case "tunnels:close-all":
          tunnelState.closeAll().catch(() => {});
          break;
        case "tunnels:snapshot":
          break;
      }
    },
    onFloatingWindowMessage: (message) => {
      if (message.type === "tunnels:snapshot") {
        setFloatingTunnelsSnapshot(message.payload);
      }
    },
    requestSnapshot: (channel) => {
      channel.postMessage({
        type: "tunnels:request-snapshot",
      } satisfies FloatingTunnelsMessage);
    },
    deps: [
      activeTunnelSessionMeta.host,
      activeTunnelSessionMeta.label,
      activeTunnelSessionMeta.username,
      sessionState.activeSessionId,
      sessionState.isRemoteSession,
      sessionState.activeSessionState,
      tunnelState.activeTunnels,
      tunnelState.close,
      tunnelState.closeAll,
      tunnelState.open,
    ],
  });

  useMacAppMenu({
    layoutCollapsed,
    onToggleCollapsed: handleToggleCollapsed,
    footerVisibility,
    onToggleFooterPart: (part) =>
      setFooterVisibility((prev) => ({ ...prev, [part]: !prev[part] })),
    onOpenConfigSection: openConfigSection,
    subApps,
    onLaunchSubApp: (id) => {
      launchSubApp(id).catch(() => {});
    },
    onFocusSubApp: (id) => {
      focusSubApp(id).catch(() => {});
    },
    onCloseSubApp: (id) => {
      closeSubApp(id).catch(() => {});
    },
    onOpenAbout: () => setAboutOpen(true),
    t,
  });

  function handleRunQuickCommand(command: string) {
    // 无活动会话时不发送，给出短暂提示避免误操作。
    const sessionId = sessionState.activeSessionId;
    if (!sessionId) {
      sessionActions.setBusyMessage(t("quickbar.noSession"));
      window.setTimeout(() => {
        sessionActions.setBusyMessage((prev) =>
          prev === t("quickbar.noSession") ? null : prev,
        );
      }, 1500);
      return;
    }
    // 先聚焦终端，确保后续键盘输入（如回车）进入终端而非停留在按钮焦点上。
    terminalActions.focusActiveTerminal();
    const parsed = decodeQuickCommandEscapes(command);
    const normalized = normalizeQuickCommandForSubmit(parsed);
    sessionActions.writeToSession(sessionId, normalized).catch(() => {});
  }

  const handleConnectProfile = useCallback(
    async (profileInput: HostProfile) => {
      if (!profileInput.host || !profileInput.username) {
        sessionActions.setBusyMessage(t("messages.missingHostUser"));
        return;
      }
      const profileId = profileInput.id;
      let resolvedProfileId = profileId;
      const requestId = nextSshConnectRequestIdRef.current + 1;
      nextSshConnectRequestIdRef.current = requestId;
      if (profileId) {
        pickProfile(profileId);
        sshConnectRuntimeRef.current[profileId] = {
          requestId,
          sessionId: null,
          cancelled: false,
        };
        setSshConnectingState(profileId, true);
      }
      sessionActions.setBusyMessage(t("messages.connecting"));
      try {
        const profile = profileInput.id
          ? profileInput
          : await saveProfile(profileInput);
        resolvedProfileId = profile.id;
        sshConnectRuntimeRef.current[profile.id] = {
          requestId,
          sessionId: null,
          cancelled: false,
        };
        setSshConnectingState(profile.id, true);
        await sessionActions.connectProfile(profile, {
          onSessionCreated: (session: Session) => {
            const runtime = sshConnectRuntimeRef.current[profile.id];
            if (!runtime || runtime.requestId !== requestId) return;
            runtime.sessionId = session.sessionId;
            if (runtime.cancelled) {
              void sessionActions
                .disconnectSession(session.sessionId)
                .catch(() => {});
            }
          },
          shouldSuppressError: () => {
            const runtime = sshConnectRuntimeRef.current[profile.id];
            return Boolean(
              runtime && runtime.requestId === requestId && runtime.cancelled,
            );
          },
        });
        sessionActions.setBusyMessage(null);
      } catch (error: unknown) {
        const runtime = profileId
          ? sshConnectRuntimeRef.current[profileId]
          : undefined;
        if (!runtime || runtime.requestId !== requestId || !runtime.cancelled) {
          sessionActions.setBusyMessage(
            translateAppError(error, t) || t("messages.connectFailed"),
          );
        }
      } finally {
        const effectiveProfileId = resolvedProfileId || "";
        const runtime = sshConnectRuntimeRef.current[effectiveProfileId];
        if (runtime && runtime.requestId === requestId) {
          delete sshConnectRuntimeRef.current[effectiveProfileId];
        }
        if (effectiveProfileId) {
          setSshConnectingState(effectiveProfileId, false);
        }
      }
    },
    [pickProfile, saveProfile, sessionActions, setSshConnectingState, t],
  );

  const handleConnectRdpProfile = useCallback(
    async (profile: RdpProfile) => {
      setActiveRdpProfileId(profile.id);
      await connectRdpProfile(profile.id);
    },
    [connectRdpProfile],
  );

  const handleCancelConnectProfile = useCallback(
    async (profileId: string) => {
      const runtime = sshConnectRuntimeRef.current[profileId];
      if (!runtime) return;
      runtime.cancelled = true;
      setSshConnectingState(profileId, false);
      sessionActions.setBusyMessage((prev) =>
        prev === t("messages.connecting") ? null : prev,
      );
      if (!runtime.sessionId) return;
      await sessionActions.disconnectSession(runtime.sessionId).catch(() => {});
    },
    [sessionActions, setSshConnectingState, t],
  );

  const handleRemoveRdpProfile = useCallback(
    async (profile: RdpProfile) => {
      await deleteRdpProfile(profile.id);
      const next = await refreshRdpProfiles();
      if (!next.length) {
        setActiveRdpProfileId(null);
        return;
      }
      if (activeRdpProfileId !== profile.id) {
        return;
      }
      const removedIndex = rdpProfiles.findIndex(
        (item) => item.id === profile.id,
      );
      const fallbackProfile =
        next[Math.min(removedIndex, next.length - 1)] ?? next[0] ?? null;
      setActiveRdpProfileId(fallbackProfile?.id ?? null);
    },
    [activeRdpProfileId, rdpProfiles, refreshRdpProfiles],
  );

  const persistRdpGroups = useCallback((nextGroups: string[]) => {
    setRdpGroups(nextGroups);
    return saveRdpProfileGroups(nextGroups);
  }, []);

  const addRdpGroup = useCallback(
    (groupName: string) => {
      const normalized = normalizeRdpGroupName(groupName);
      if (!normalized) return false;
      if (
        rdpGroups.some(
          (item) => item.toLowerCase() === normalized.toLowerCase(),
        )
      ) {
        return false;
      }
      const nextGroups = dedupeRdpGroups([...rdpGroups, normalized]);
      persistRdpGroups(nextGroups).catch(() => {});
      return true;
    },
    [persistRdpGroups, rdpGroups],
  );

  const renameRdpGroup = useCallback(
    async (from: string, to: string) => {
      const source = normalizeRdpGroupName(from);
      const target = normalizeRdpGroupName(to);
      if (!source || !target) return false;
      if (source.toLowerCase() === target.toLowerCase()) return false;
      if (
        rdpGroups.some((item) => item.toLowerCase() === target.toLowerCase())
      ) {
        return false;
      }
      const affected = rdpProfiles.filter(
        (item) =>
          normalizeRdpGroupName(item.tags?.[0] ?? "").toLowerCase() ===
          source.toLowerCase(),
      );
      if (!affected.length) {
        const nextGroups = dedupeRdpGroups(
          rdpGroups.map((item) =>
            item.toLowerCase() === source.toLowerCase() ? target : item,
          ),
        );
        await persistRdpGroups(nextGroups);
        return true;
      }
      try {
        const savedProfiles = await Promise.all(
          affected.map((item) =>
            saveRdpProfile({
              ...item,
              tags: [target],
            }),
          ),
        );
        const savedMap = new Map(
          savedProfiles.map((item) => [item.id, item] as const),
        );
        const nextGroups = dedupeRdpGroups(
          rdpGroups.map((item) =>
            item.toLowerCase() === source.toLowerCase() ? target : item,
          ),
        );
        await persistRdpGroups(nextGroups);
        setRdpProfiles((prev) =>
          prev.map((item) => savedMap.get(item.id) ?? item),
        );
        return true;
      } catch {
        return false;
      }
    },
    [persistRdpGroups, rdpGroups, rdpProfiles],
  );

  const removeRdpGroup = useCallback(
    async (groupName: string) => {
      const target = normalizeRdpGroupName(groupName);
      if (!target) return false;
      const targetKey = target.toLowerCase();
      const exists = rdpGroups.some((item) => item.toLowerCase() === targetKey);
      if (!exists) return false;
      const affected = rdpProfiles.filter(
        (item) =>
          normalizeRdpGroupName(item.tags?.[0] ?? "").toLowerCase() ===
          targetKey,
      );
      if (!affected.length) {
        await persistRdpGroups(
          rdpGroups.filter((item) => item.toLowerCase() !== targetKey),
        );
        return true;
      }
      try {
        const savedProfiles = await Promise.all(
          affected.map((item) =>
            saveRdpProfile({
              ...item,
              tags: null,
            }),
          ),
        );
        const savedMap = new Map(
          savedProfiles.map((item) => [item.id, item] as const),
        );
        await persistRdpGroups(
          rdpGroups.filter((item) => item.toLowerCase() !== targetKey),
        );
        setRdpProfiles((prev) =>
          prev.map((item) => savedMap.get(item.id) ?? item),
        );
        return true;
      } catch {
        return false;
      }
    },
    [persistRdpGroups, rdpGroups, rdpProfiles],
  );

  const moveRdpProfileToGroup = useCallback(
    async (profileId: string, targetGroup: string | null) => {
      const profile = rdpProfiles.find((item) => item.id === profileId);
      if (!profile) return false;
      const nextGroup = normalizeRdpGroupName(targetGroup ?? "");
      try {
        const saved = await saveRdpProfile({
          ...profile,
          tags: nextGroup ? [nextGroup] : null,
        });
        if (nextGroup) {
          const nextGroups = dedupeRdpGroups([...rdpGroups, nextGroup]);
          await persistRdpGroups(nextGroups);
        }
        setRdpProfiles((prev) =>
          prev.map((item) => (item.id === saved.id ? saved : item)),
        );
        return true;
      } catch {
        return false;
      }
    },
    [persistRdpGroups, rdpGroups, rdpProfiles],
  );

  async function handleSaveSessionBuffer(sessionId: string) {
    const session = sessionState.sessions.find(
      (item) => item.sessionId === sessionId,
    );
    if (!session) return;
    const text = terminalQuery.getSessionBufferText(sessionId) ?? "";
    const isLocal = sessionActions.isLocalSession(sessionId);
    const profile =
      profiles.find((item) => item.id === session.profileId) ?? editingProfile;
    const baseName = isLocal
      ? (sessionState.localSessionMeta[sessionId]?.label ?? t("session.local"))
      : profile.name || profile.host || t("session.defaultName");
    const target = await save({
      defaultPath: `${baseName}.log`,
      filters: [{ name: "Log", extensions: ["log", "txt"] }],
    });
    if (!target) return;
    await writeTextFile(target, text);
  }

  const postFloatingFilesMessage =
    useFloatingWidgetMessagePoster<FloatingFilesMessage>(
      WIDGET_FILES_CHANNEL,
      isFloatingFilesWidget,
    );
  const postFloatingTransfersMessage =
    useFloatingWidgetMessagePoster<FloatingTransfersMessage>(
      WIDGET_TRANSFERS_CHANNEL,
      isFloatingTransfersWidget,
    );
  const postFloatingHistoryMessage =
    useFloatingWidgetMessagePoster<FloatingHistoryMessage>(
      WIDGET_HISTORY_CHANNEL,
      isFloatingHistoryWidget,
    );
  const postFloatingAiMessage =
    useFloatingWidgetMessagePoster<FloatingAiMessage>(
      WIDGET_AI_CHANNEL,
      isFloatingAiWidget,
    );
  const postFloatingTunnelsMessage =
    useFloatingWidgetMessagePoster<FloatingTunnelsMessage>(
      WIDGET_TUNNELS_CHANNEL,
      isFloatingTunnelsWidget,
    );

  // 主窗口直接读取本地 SFTP 状态；浮动文件面板则消费主窗口同步过来的只读快照。
  const filesWidgetState = useMemo(
    () =>
      isFloatingFilesWidget
        ? {
            isRemoteSession: floatingFilesSnapshot?.isRemoteSession ?? false,
            isRemoteConnected:
              floatingFilesSnapshot?.isRemoteConnected ?? false,
            sftpAvailability:
              floatingFilesSnapshot?.sftpAvailability ?? "checking",
            terminalPathSyncStatus:
              floatingFilesSnapshot?.terminalPathSyncStatus ?? "checking",
            currentPath: floatingFilesSnapshot?.currentPath ?? "",
            entries: floatingFilesSnapshot?.entries ?? [],
          }
        : {
            isRemoteSession: sessionState.isRemoteSession,
            isRemoteConnected: sessionState.isRemoteConnected,
            sftpAvailability: activeSftpAvailability,
            terminalPathSyncStatus: activeTerminalPathSyncStatus,
            currentPath: sftpState.currentPath,
            entries: sftpState.entries,
          },
    [
      activeSftpAvailability,
      activeTerminalPathSyncStatus,
      floatingFilesSnapshot,
      isFloatingFilesWidget,
      sessionState.isRemoteConnected,
      sessionState.isRemoteSession,
      sftpState.currentPath,
      sftpState.entries,
    ],
  );

  // 传输面板在浮动窗口中仅消费主窗口快照，避免浮窗重建本地状态后丢失当前任务上下文。
  const TransfersWidgetState = useMemo(
    () =>
      isFloatingTransfersWidget
        ? {
            progress: floatingTransfersSnapshot?.progress ?? null,
            busyMessage: floatingTransfersSnapshot?.busyMessage ?? null,
            events: floatingTransfersSnapshot?.events ?? [],
          }
        : {
            progress: sessionState.activeSessionId
              ? (sftpState.progressBySession[sessionState.activeSessionId] ??
                null)
              : null,
            busyMessage: sessionState.busyMessage,
            events: sessionState.appEvents,
          },
    [
      floatingTransfersSnapshot,
      isFloatingTransfersWidget,
      sessionState.activeSessionId,
      sessionState.appEvents,
      sessionState.busyMessage,
      sftpState.progressBySession,
    ],
  );

  // 主窗口直接调用 SFTP action；浮动文件面板通过消息把操作代理回主窗口执行。
  const filesWidgetActions = useMemo(
    () =>
      isFloatingFilesWidget
        ? {
            refreshList: (path?: string) => {
              postFloatingFilesMessage({ type: "files:refresh", path });
              return Promise.resolve();
            },
            openRemoteDir: (path: string) => {
              postFloatingFilesMessage({ type: "files:open", path });
              return Promise.resolve();
            },
            openFile: (entry: (typeof filesWidgetState.entries)[number]) => {
              postFloatingFilesMessage({ type: "files:open-file", entry });
              return Promise.resolve();
            },
            uploadFile: () => {
              postFloatingFilesMessage({ type: "files:upload" });
              return Promise.resolve();
            },
            uploadDroppedPaths: (paths: string[]) => {
              postFloatingFilesMessage({ type: "files:upload-paths", paths });
              return Promise.resolve();
            },
            downloadFile: (
              entry: (typeof filesWidgetState.entries)[number],
            ) => {
              postFloatingFilesMessage({ type: "files:download", entry });
              return Promise.resolve();
            },
            cancelTransfer: () => Promise.resolve(),
            createFolder: (name: string) => {
              postFloatingFilesMessage({ type: "files:mkdir", name });
              return Promise.resolve();
            },
            rename: (
              entry: (typeof filesWidgetState.entries)[number],
              name: string,
            ) => {
              postFloatingFilesMessage({ type: "files:rename", entry, name });
              return Promise.resolve();
            },
            remove: (entry: (typeof filesWidgetState.entries)[number]) => {
              postFloatingFilesMessage({ type: "files:remove", entry });
              return Promise.resolve();
            },
          }
        : {
            refreshList,
            openRemoteDir,
            openFile: async (
              entry: (typeof filesWidgetState.entries)[number],
            ) => {
              if (
                sessionState.isRemoteConnected &&
                sessionState.activeSessionId
              ) {
                await openManagedRemoteFile(
                  sessionState.activeSessionId,
                  entry,
                );
                return;
              }
              await openManagedLocalFile(entry);
            },
            uploadFile,
            uploadDroppedPaths,
            downloadFile,
            cancelTransfer,
            createFolder,
            rename: renameEntry,
            remove: removeEntry,
          },
    [
      createFolder,
      downloadFile,
      filesWidgetState,
      isFloatingFilesWidget,
      openRemoteDir,
      postFloatingFilesMessage,
      refreshList,
      removeEntry,
      renameEntry,
      openManagedLocalFile,
      openManagedRemoteFile,
      sessionState.activeSessionId,
      sessionState.isRemoteConnected,
      uploadFile,
      uploadDroppedPaths,
      cancelTransfer,
    ],
  );

  const TransfersWidgetActions = useMemo(
    () =>
      isFloatingTransfersWidget
        ? {
            cancel: () => {
              postFloatingTransfersMessage({ type: "transfers:cancel" });
              return Promise.resolve();
            },
          }
        : {
            cancel: cancelTransfer,
          },
    [cancelTransfer, isFloatingTransfersWidget, postFloatingTransfersMessage],
  );

  const EventsWidgetState = useMemo(
    () =>
      isFloatingEventsWidget
        ? {
            sessionState:
              floatingEventsSnapshot?.sessionState ?? "disconnected",
            sessionReason: floatingEventsSnapshot?.sessionReason ?? null,
            reconnectInfo: floatingEventsSnapshot?.reconnectInfo ?? null,
            events: floatingEventsSnapshot?.events ?? [],
          }
        : {
            sessionState: sessionState.activeSessionState ?? "disconnected",
            sessionReason: sessionState.activeSessionReason,
            reconnectInfo: sessionState.activeReconnectInfo,
            events: sessionState.appEvents,
          },
    [
      floatingEventsSnapshot,
      isFloatingEventsWidget,
      sessionState.activeReconnectInfo,
      sessionState.activeSessionReason,
      sessionState.activeSessionState,
      sessionState.appEvents,
    ],
  );

  const historyWidgetState = useMemo(
    () =>
      isFloatingHistoryWidget
        ? {
            loaded: true,
            hasActiveSession:
              floatingHistorySnapshot?.hasActiveSession ?? false,
            liveCapture: floatingHistorySnapshot?.liveCapture ?? null,
            items: filterHistoryItems(
              floatingHistorySnapshot?.items ?? [],
              floatingHistorySearchQuery,
            ),
            searchQuery: floatingHistorySearchQuery,
          }
        : {
            loaded: historyState.loaded,
            hasActiveSession: !!sessionState.activeSessionId,
            liveCapture: historyState.activeLiveCapture,
            items: historyState.activeItems,
            searchQuery: historyState.searchQuery,
          },
    [
      floatingHistorySearchQuery,
      floatingHistorySnapshot,
      historyState.activeItems,
      historyState.activeLiveCapture,
      historyState.loaded,
      historyState.searchQuery,
      isFloatingHistoryWidget,
      sessionState.activeSessionId,
    ],
  );

  const historyWidgetActions = useMemo(
    () =>
      isFloatingHistoryWidget
        ? {
            setSearchQuery: setFloatingHistorySearchQuery,
            execute: (command: string) => {
              postFloatingHistoryMessage({ type: "history:execute", command });
            },
          }
        : {
            setSearchQuery: historyState.setSearchQuery,
            execute: handleExecuteHistoryItem,
          },
    [
      handleExecuteHistoryItem,
      historyState.setSearchQuery,
      isFloatingHistoryWidget,
      postFloatingHistoryMessage,
    ],
  );

  const AiWidgetState = useMemo(
    () =>
      isFloatingAiWidget
        ? {
            activeSessionId: floatingAiSnapshot?.activeSessionId ?? null,
            messages: floatingAiSnapshot?.messages ?? [],
            draft: floatingAiSnapshot?.draft ?? "",
            pending: floatingAiSnapshot?.pending ?? false,
            waitingFirstChunk: floatingAiSnapshot?.waitingFirstChunk ?? false,
            errorMessage: floatingAiSnapshot?.errorMessage ?? null,
            aiAvailable: floatingAiSnapshot?.aiAvailable ?? false,
            aiUnavailableMessage:
              floatingAiSnapshot?.aiUnavailableMessage ?? null,
          }
        : {
            activeSessionId: sessionState.activeSessionId,
            messages: aiState.messages,
            draft: aiState.draft,
            pending: aiState.pending,
            waitingFirstChunk: aiState.waitingFirstChunk,
            errorMessage: aiState.errorMessage,
            aiAvailable,
            aiUnavailableMessage,
          },
    [
      aiAvailable,
      aiState.draft,
      aiState.errorMessage,
      aiState.messages,
      aiState.pending,
      aiState.waitingFirstChunk,
      aiUnavailableMessage,
      floatingAiSnapshot,
      isFloatingAiWidget,
      sessionState.activeSessionId,
    ],
  );

  const AiWidgetActions = useMemo(
    () =>
      isFloatingAiWidget
        ? {
            setDraft: (value: string) => {
              postFloatingAiMessage({ type: "ai:set-draft", draft: value });
            },
            send: () => {
              postFloatingAiMessage({ type: "ai:send" });
              return Promise.resolve();
            },
            cancel: () => {
              postFloatingAiMessage({ type: "ai:cancel" });
            },
            clear: () => {
              postFloatingAiMessage({ type: "ai:clear" });
            },
            sendCodeToTerminal: (code: string) => {
              postFloatingAiMessage({
                type: "ai:send-code-to-terminal",
                code,
              });
            },
          }
        : {
            setDraft: aiState.setDraft,
            send: aiState.sendMessage,
            cancel: aiState.cancelMessage,
            clear: aiState.clearMessages,
            sendCodeToTerminal: (code: string) => {
              fillCodeToActiveTerminal(code).catch(() => {});
            },
          },
    [
      aiState.cancelMessage,
      aiState.clearMessages,
      aiState.sendMessage,
      aiState.setDraft,
      fillCodeToActiveTerminal,
      isFloatingAiWidget,
      postFloatingAiMessage,
    ],
  );

  const TunnelsWidgetState = useMemo(
    () =>
      isFloatingTunnelsWidget
        ? {
            activeSessionId: floatingTunnelsSnapshot?.activeSessionId ?? null,
            supportsSshTunnel:
              floatingTunnelsSnapshot?.supportsSshTunnel ?? false,
            sessionState:
              floatingTunnelsSnapshot?.sessionState ?? "disconnected",
            sessionLabel: floatingTunnelsSnapshot?.sessionLabel ?? null,
            sessionHost: floatingTunnelsSnapshot?.sessionHost ?? null,
            sessionUsername: floatingTunnelsSnapshot?.sessionUsername ?? null,
            tunnels: floatingTunnelsSnapshot?.tunnels ?? [],
          }
        : {
            activeSessionId: sessionState.activeSessionId,
            supportsSshTunnel: sessionState.isRemoteSession,
            sessionState: sessionState.activeSessionState ?? "disconnected",
            sessionLabel: activeTunnelSessionMeta.label,
            sessionHost: activeTunnelSessionMeta.host,
            sessionUsername: activeTunnelSessionMeta.username,
            tunnels: tunnelState.activeTunnels,
          },
    [
      activeTunnelSessionMeta.host,
      activeTunnelSessionMeta.label,
      activeTunnelSessionMeta.username,
      floatingTunnelsSnapshot,
      isFloatingTunnelsWidget,
      sessionState.activeSessionId,
      sessionState.isRemoteSession,
      sessionState.activeSessionState,
      tunnelState,
    ],
  );

  const TunnelsWidgetActions = useMemo(
    () =>
      isFloatingTunnelsWidget
        ? {
            open: (spec: Parameters<typeof tunnelState.open>[0]) => {
              postFloatingTunnelsMessage({ type: "tunnels:open", spec });
              return Promise.resolve();
            },
            close: (tunnelId: string) => {
              postFloatingTunnelsMessage({ type: "tunnels:close", tunnelId });
              return Promise.resolve();
            },
            closeAll: () => {
              postFloatingTunnelsMessage({ type: "tunnels:close-all" });
              return Promise.resolve();
            },
          }
        : {
            open: async (spec: Parameters<typeof tunnelState.open>[0]) => {
              await tunnelState.open(spec);
            },
            close: tunnelState.close,
            closeAll: tunnelState.closeAll,
          },
    [isFloatingTunnelsWidget, postFloatingTunnelsMessage, tunnelState],
  );

  const widgets = useMemo(
    () =>
      buildWidgets({
        profiles,
        rdpProfiles,
        rdpGroups,
        sshGroups,
        activeProfileId,
        sshConnectingProfiles: connectingSshProfiles,
        activeRdpProfileId,
        rdpConnectingProfiles: {},
        availableShells,
        activeSessionId: AiWidgetState.activeSessionId,
        isRemoteSession: filesWidgetState.isRemoteSession,
        isRemoteConnected: filesWidgetState.isRemoteConnected,
        transferProgress: TransfersWidgetState.progress,
        busyMessage: TransfersWidgetState.busyMessage,
        appEvents: isFloatingTransfersWidget
          ? TransfersWidgetState.events
          : EventsWidgetState.events,
        historyLoaded: historyWidgetState.loaded,
        hasActiveSession: historyWidgetState.hasActiveSession,
        historyLiveCapture: historyWidgetState.liveCapture,
        historyItems: historyWidgetState.items,
        historySearchQuery: historyWidgetState.searchQuery,
        aiMessages: AiWidgetState.messages,
        aiDraft: AiWidgetState.draft,
        aiAvailable: AiWidgetState.aiAvailable,
        aiUnavailableMessage: AiWidgetState.aiUnavailableMessage,
        aiPending: AiWidgetState.pending,
        aiWaitingFirstChunk: AiWidgetState.waitingFirstChunk,
        aiErrorMessage: AiWidgetState.errorMessage,
        isFloatingAiWidget,
        currentPath: filesWidgetState.currentPath,
        sftpAvailability: filesWidgetState.sftpAvailability,
        terminalPathSyncStatus: filesWidgetState.terminalPathSyncStatus,
        entries: filesWidgetState.entries,
        locale,
        t,
        pickProfile,
        pickRdpProfile: setActiveRdpProfileId,
        onConnectProfile: handleConnectProfile,
        onCancelSshConnectProfile: handleCancelConnectProfile,
        onConnectRdpProfile: handleConnectRdpProfile,
        onOpenNewRdpProfile: openNewRdpProfileModal,
        onOpenEditRdpProfile: openEditRdpProfileModal,
        onRemoveRdpProfile: handleRemoveRdpProfile,
        onAddRdpGroup: addRdpGroup,
        onRenameRdpGroup: renameRdpGroup,
        onRemoveRdpGroup: removeRdpGroup,
        onMoveRdpProfileToGroup: moveRdpProfileToGroup,
        onOpenNewProfile: openNewProfile,
        onImportOpenSshConfig: () => {
          importOpenSshConfig()
            .then((summary) => {
              pushToast({
                level: "success",
                message: formatOpenSshImportToast(t, summary),
              });
            })
            .catch((error) => {
              pushToast({
                level: "error",
                message: getErrorMessage(error),
              });
            });
        },
        onOpenEditProfile: openEditProfile,
        onDuplicateProfile: (profile) => {
          duplicateProfile(profile, t("profile.copySuffix")).catch((error) => {
            pushToast({
              level: "error",
              message: getErrorMessage(error),
            });
          });
        },
        onRemoveProfile: (profile) => {
          void removeProfile(profile.id);
        },
        onHistorySearchQueryChange: historyWidgetActions.setSearchQuery,
        onExecuteHistoryItem: historyWidgetActions.execute,
        onAiDraftChange: AiWidgetActions.setDraft,
        onAiSend: AiWidgetActions.send,
        onAiCancel: AiWidgetActions.cancel,
        onAiClear: AiWidgetActions.clear,
        onAiSendCodeToTerminal: AiWidgetActions.sendCodeToTerminal,
        onAddGroup: addGroup,
        onRenameGroup: renameGroup,
        onRemoveGroup: removeGroup,
        onMoveProfileToGroup: moveProfileToGroup,
        onConnectLocalShell: (shell) => {
          sessionActions.connectLocalShell(shell, true).catch(() => {});
        },
        onOpenLocalShellProfile: openLocalShellProfile,
        onRefreshLocalShells: refreshAvailableShells,
        onRefreshList: filesWidgetActions.refreshList,
        onOpenRemoteDir: filesWidgetActions.openRemoteDir,
        onOpenFile: filesWidgetActions.openFile,
        onUploadFile: filesWidgetActions.uploadFile,
        onUploadDroppedPaths: filesWidgetActions.uploadDroppedPaths,
        onDownloadFile: filesWidgetActions.downloadFile,
        onCancelTransfer: TransfersWidgetActions.cancel,
        onCreateFolder: filesWidgetActions.createFolder,
        onRenameEntry: filesWidgetActions.rename,
        onRemoveEntry: filesWidgetActions.remove,
        tunnelSessionId: TunnelsWidgetState.activeSessionId,
        tunnelSupportsSsh: TunnelsWidgetState.supportsSshTunnel,
        tunnelSessionState: TunnelsWidgetState.sessionState,
        tunnelSessionLabel: TunnelsWidgetState.sessionLabel,
        tunnelSessionHost: TunnelsWidgetState.sessionHost,
        tunnelSessionUsername: TunnelsWidgetState.sessionUsername,
        tunnelRuntimes: TunnelsWidgetState.tunnels,
        onOpenTunnel: TunnelsWidgetActions.open,
        onCloseTunnel: TunnelsWidgetActions.close,
        onCloseAllTunnels: TunnelsWidgetActions.closeAll,
      }),
    [
      profiles,
      rdpProfiles,
      rdpGroups,
      sshGroups,
      activeProfileId,
      connectingSshProfiles,
      activeRdpProfileId,
      availableShells,
      AiWidgetActions,
      AiWidgetState,
      isFloatingAiWidget,
      isFloatingTransfersWidget,
      EventsWidgetState,
      filesWidgetState.isRemoteSession,
      filesWidgetState.isRemoteConnected,
      TransfersWidgetActions,
      TransfersWidgetState,
      historyWidgetActions,
      historyWidgetState,
      importOpenSshConfig,
      filesWidgetState.currentPath,
      filesWidgetState.terminalPathSyncStatus,
      filesWidgetState.sftpAvailability,
      filesWidgetState.entries,
      locale,
      pushToast,
      t,
      pickProfile,
      addGroup,
      renameGroup,
      removeGroup,
      moveProfileToGroup,
      duplicateProfile,
      handleConnectProfile,
      handleCancelConnectProfile,
      handleConnectRdpProfile,
      handleRemoveRdpProfile,
      addRdpGroup,
      renameRdpGroup,
      removeRdpGroup,
      moveRdpProfileToGroup,
      openNewProfile,
      openNewRdpProfileModal,
      openEditRdpProfileModal,
      openLocalShellProfile,
      refreshAvailableShells,
      removeProfile,
      sessionActions,
      filesWidgetActions,
      TunnelsWidgetActions,
      TunnelsWidgetState,
    ],
  );

  function handleSlotReplace(slot: WidgetSlotId, key: WidgetKey) {
    // UI 候选列表已经做过过滤，这里再做一次防守式保护，
    // 避免未来新增入口时把“已存在或已浮动”的组件重新塞回主窗口。
    if (!availableWidgets.includes(key)) return;
    setSlotGroups((prev) => moveWidgetToSlot(prev, key, slot));
  }

  function handleOpenTransfersWidget() {
    // 仅在用户主动点击状态栏传输指示器时展开并切换，不在传输开始时自动打断当前布局。
    setWidgetCollapsed("bottom", false);
    setSlotGroups((prev) => {
      const bottomGroup = prev.bottom;
      if (!bottomGroup) return prev;
      if (bottomGroup.active === "transfers") return prev;
      return {
        ...prev,
        bottom: {
          ...bottomGroup,
          active: "transfers",
        },
      };
    });
  }

  async function handleSendSelectionToAi(text: string) {
    await aiState.sendSelectionText(text);

    if (isFloatingAiWidget) return;

    let aiSlot: WidgetSlotId | null = null;
    for (const [slotId, group] of Object.entries(slotGroups)) {
      if (group.active === "ai") {
        aiSlot = slotId as WidgetSlotId;
        break;
      }
    }

    if (aiSlot) {
      const side =
        aiSlot === "bottom" ? "bottom" : (aiSlot.split(":")[0] as WidgetSide);
      setWidgetCollapsed(side, false);
    } else {
      const targetSlot: WidgetSlotId = "right:0";
      setSlotGroups((prev) => moveWidgetToSlot(prev, "ai", targetSlot));
      setWidgetCollapsed("right", false);
    }
  }

  return (
    <>
      {activeBackgroundMediaType === "video" && backgroundMediaBlobUrl ? (
        <div className="app-background-media-layer" aria-hidden="true">
          <video
            ref={backgroundVideoRef}
            key={backgroundMediaBlobUrl}
            className={`app-background-video mode-${effectiveBackgroundRenderMode}`}
            src={backgroundMediaBlobUrl}
            muted
            playsInline
            autoPlay
            preload="auto"
            onEnded={handleBackgroundVideoEnded}
          />
          <div className="app-background-media-overlay" />
        </div>
      ) : null}
      {floatingWidgetKey ? (
        <FloatingShell
          floatingWidgetKey={floatingWidgetKey}
          widgetLabels={widgetLabels}
          widgetBody={widgets[floatingWidgetKey]}
          layoutCollapsed={layoutCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
          layoutMenuDisabled={layoutMenuDisabled}
          onOpenConfigSection={openConfigSection}
          t={t}
        />
      ) : (
        <div className="app-shell" style={layoutVars}>
          {!isMac && (
            <TitleBar
              onOpenConfigSection={openConfigSection}
              layoutCollapsed={layoutCollapsed}
              onToggleCollapsed={handleToggleCollapsed}
              onOpenAbout={() => setAboutOpen(true)}
              footerVisibility={footerVisibility}
              onToggleFooterPart={(part) =>
                setFooterVisibility((prev) => ({
                  ...prev,
                  [part]: !prev[part],
                }))
              }
              layoutDisabled={layoutMenuDisabled}
              subApps={subApps}
              onLaunchSubApp={(id) => {
                launchSubApp(id).catch(() => {});
              }}
              onFocusSubApp={(id) => {
                focusSubApp(id).catch(() => {});
              }}
              onCloseSubApp={(id) => {
                closeSubApp(id).catch(() => {});
              }}
              t={t}
            />
          )}

          <Workspace
            layoutCollapsed={layoutCollapsed}
            sideSlotCounts={sideSlotCounts}
            slotGroups={slotGroups}
            widgetLabels={widgetLabels}
            widgets={widgets}
            terminalWidget={
              <TerminalWidget
                sessions={sessionState.sessions}
                workspace={sessionState.workspace}
                profiles={profiles}
                editingProfile={editingProfile}
                localSessionMeta={sessionState.localSessionMeta}
                activeSessionId={sessionState.activeSessionId}
                activeSession={sessionState.activeSession}
                activeSessionState={sessionState.activeSessionState}
                activeSessionReason={sessionState.activeSessionReason}
                activeReconnectInfo={sessionState.activeReconnectInfo}
                reconnectInfoBySession={sessionState.reconnectInfoBySession}
                sessionStates={sessionState.sessionStates}
                sessionReasons={sessionState.sessionReasons}
                autoReconnectOnPoweroff={autoReconnectOnPoweroff}
                autoReconnectOnReboot={autoReconnectOnReboot}
                bellPendingBySession={bellPendingBySession}
                registerTerminalContainer={
                  terminalActions.registerTerminalContainer
                }
                isTerminalReady={terminalQuery.isTerminalReady}
                getTerminalTitle={terminalQuery.getTerminalTitle}
                activeLinkMenu={terminalQuery.getActiveLinkMenu()}
                hasFocusedLine={terminalQuery.hasFocusedLine}
                onFocusLineAtPoint={terminalActions.focusTerminalLineAtPoint}
                onCopyFocusedLine={terminalActions.copyActiveFocusedLine}
                hasActiveSelection={terminalQuery.hasActiveSelection}
                getActiveSelectionText={terminalQuery.getActiveSelectionText}
                onCopySelection={terminalActions.copyActiveSelection}
                onSendSelectionToAi={handleSendSelectionToAi}
                onOpenLink={terminalActions.openActiveLink}
                onCopyLink={terminalActions.copyActiveLink}
                onCloseLinkMenu={terminalActions.closeActiveLinkMenu}
                onPaste={terminalActions.pasteToActiveTerminal}
                onClear={terminalActions.clearActiveTerminal}
                onSearchNext={terminalActions.searchActiveTerminalNext}
                onSearchPrev={terminalActions.searchActiveTerminalPrev}
                onSearchClear={terminalActions.clearActiveSearchDecorations}
                searchResultStats={terminalQuery.getActiveSearchStats()}
                autocomplete={
                  terminalQuery.getActiveAutocomplete()
                    ? {
                        sessionId:
                          terminalQuery.getActiveAutocomplete()!.sessionId,
                        items: terminalQuery
                          .getActiveAutocomplete()!
                          .items.map((item) => ({
                            command: item.command,
                            useCount: item.useCount,
                          })),
                        selectedIndex:
                          terminalQuery.getActiveAutocomplete()!.selectedIndex,
                      }
                    : null
                }
                autocompleteAnchor={terminalQuery.getActiveAutocompleteAnchor()}
                onApplyAutocompleteSuggestion={(command) => {
                  terminalActions
                    .applyActiveAutocompleteSuggestion(command)
                    .catch(() => {});
                }}
                onDismissAutocomplete={terminalActions.closeActiveAutocomplete}
                isLocalSession={sessionActions.isLocalSession}
                onSwitchSession={sessionActions.switchSession}
                onFocusPane={sessionActions.focusPane}
                onReorderPaneSessions={sessionActions.reorderPaneSessions}
                onReconnectSession={sessionActions.reconnectSession}
                onSaveSession={handleSaveSessionBuffer}
                onSplitActivePane={sessionActions.splitActivePane}
                onClosePaneSession={sessionActions.closePaneSession}
                onResizePaneSplit={sessionActions.resizePaneSplit}
                onCloseOtherSessionsInPane={
                  sessionActions.closeOtherSessionsInPane
                }
                onCloseSessionsToRightInPane={
                  sessionActions.closeSessionsToRightInPane
                }
                onCloseAllSessionsInPane={sessionActions.closeAllSessionsInPane}
                t={t}
              />
            }
            availableWidgets={availableWidgets}
            leftVisible={leftVisible}
            rightVisible={rightVisible}
            bottomVisible={bottomVisible}
            onReplace={handleSlotReplace}
            onFloat={(slot) => {
              void handleFloat(slot);
            }}
            onCloseWidget={handleCloseSlot}
            onToggleSplit={handleToggleSplit}
            onStartResize={startResize}
            t={t}
          />

          <BottomArea
            visibility={footerVisibility}
            managerOpen={quickbarManagerOpen}
            onOpenManager={() => setQuickbarManagerOpen(true)}
            showGroupTitle={showGroupTitle}
            groups={quickbarGroups}
            commands={quickbarCommands}
            onCloseManager={() => setQuickbarManagerOpen(false)}
            onAddGroup={addQuickbarGroup}
            onRenameGroup={renameQuickbarGroup}
            onRemoveGroup={removeQuickbarGroup}
            onToggleGroupVisible={toggleQuickbarGroupVisible}
            onAddCommand={addQuickbarCommand}
            onUpdateCommand={updateQuickbarCommand}
            onReorderCommands={reorderQuickbarCommands}
            onRemoveCommand={removeQuickbarCommand}
            onShowGroupTitleChange={setShowGroupTitle}
            onRunCommand={handleRunQuickCommand}
            getActiveTerminalStats={terminalQuery.getActiveTerminalStats}
            resourceMonitorEnabled={resourceMonitorEnabled}
            resourceMonitorStatus={activeResourceMonitorStatus}
            resourceSnapshot={activeResourceSnapshot}
            sftpProgressBySession={sftpState.progressBySession}
            onOpenTransfersWidget={handleOpenTransfersWidget}
            activeAiConfigName={aiActiveProvider?.name?.trim() || null}
            securityLocked={securityStatus.locked}
            securityProvider={securityStatus.provider}
            onSecurityAction={() => {
              if (
                securityStatus.provider === "user_password" &&
                !securityStatus.locked
              ) {
                lockSecurity().catch(() => {});
                return;
              }
              openConfigSection("security");
            }}
            locale={locale}
            t={t}
          />

          {aboutOpen ? (
            <Suspense fallback={null}>
              <AboutModal
                open={aboutOpen}
                onClose={handleCloseAbout}
                onOpenDevtools={handleOpenDevtools}
                onUpdateAction={appUpdater.triggerUpdateAction}
                updateStatus={appUpdater.status}
                hasAvailableUpdate={appUpdater.hasAvailableUpdate}
                updateIndicator={appUpdater.indicator}
                downloadProgressPercent={appUpdater.downloadProgressPercent}
                updateBusy={appUpdater.isChecking || appUpdater.isDownloading}
                t={t}
              />
            </Suspense>
          ) : null}
        </div>
      )}
      <Suspense fallback={null}>
        {profileModalOpen ? (
          <ProfileModal
            open={profileModalOpen}
            mode={profileModalMode}
            draft={profileDraft}
            sshGroups={sshGroups}
            onDraftChange={setProfileDraft}
            onClose={closeProfileModal}
            onSubmit={() => {
              void submitProfile();
            }}
            t={t}
          />
        ) : null}
        {localShellProfileModalOpen ? (
          <LocalShellProfileModal
            key={`${activeLocalShellProfile?.id ?? "none"}:${localShellProfileModalOpen ? "open" : "closed"}`}
            open={localShellProfileModalOpen}
            shell={activeLocalShellProfile}
            draft={localShellProfileDraft}
            onDraftChange={setLocalShellProfileDraft}
            onClose={closeLocalShellProfileModal}
            onSubmit={submitLocalShellProfile}
            t={t}
          />
        ) : null}
        {rdpProfileModalOpen ? (
          <RdpProfileModal
            open={rdpProfileModalOpen}
            mode={rdpProfileModalMode}
            initialProfile={
              rdpProfileModalMode === "edit"
                ? (rdpProfiles.find(
                    (item) => item.id === rdpProfileModalProfileId,
                  ) ?? null)
                : null
            }
            defaultGroup={rdpProfileModalDefaultGroup}
            groups={rdpGroups}
            onClose={closeRdpProfileModal}
            onProfilesChange={() => refreshRdpProfiles().then(() => {})}
            t={t}
          />
        ) : null}
        {configModalOpen ? (
          <ConfigModal
            open={configModalOpen}
            activeSection={activeConfigSection}
            sections={configModalNavSections}
            locale={locale}
            themeId={themeId}
            shellId={shellId}
            availableShells={availableShells}
            themes={themePresets}
            sftpEnabled={sftpEnabled}
            fileDefaultEditorPath={fileDefaultEditorPath}
            backgroundImageEnabled={backgroundImageEnabled}
            backgroundImageAsset={backgroundImageAsset}
            backgroundImageSurfaceAlpha={normalizedBackgroundImageSurfaceAlpha}
            backgroundMediaType={normalizedBackgroundMediaType}
            backgroundRenderMode={normalizedBackgroundRenderMode}
            backgroundVideoReplayMode={normalizedBackgroundVideoReplayMode}
            backgroundVideoReplayIntervalSec={
              normalizedBackgroundVideoReplayIntervalSec
            }
            aiSelectionMaxChars={aiSelectionMaxChars}
            aiSessionRecentOutputMaxChars={aiSessionRecentOutputMaxChars}
            aiRequestTimeoutMs={aiRequestTimeoutMs}
            aiDebugLoggingEnabled={aiDebugLoggingEnabled}
            aiActiveProviderId={aiActiveProviderId}
            aiProviders={aiProviders}
            securityStatus={securityStatus}
            securityLoaded={securityLoaded}
            securityBusy={securityBusy}
            webLinksEnabled={webLinksEnabled}
            commandAutocompleteEnabled={commandAutocompleteEnabled}
            selectionAutoCopyEnabled={selectionAutoCopyEnabled}
            autoReconnectOnPoweroff={autoReconnectOnPoweroff}
            autoReconnectOnReboot={autoReconnectOnReboot}
            cursorStyle={cursorStyle}
            terminalFontFamilyMode={terminalFontFamilyMode}
            scrollback={scrollback}
            terminalPathSyncEnabled={terminalPathSyncEnabled}
            resourceMonitorEnabled={resourceMonitorEnabled}
            resourceMonitorIntervalSec={resourceMonitorIntervalSec}
            hostKeyPolicy={hostKeyPolicy}
            onSftpEnabledChange={setSftpEnabled}
            onLocaleChange={setLocale}
            onThemeChange={setThemeId}
            onShellChange={setShellId}
            onFileDefaultEditorPathChange={setFileDefaultEditorPath}
            onBackgroundImageEnabledChange={setBackgroundImageEnabled}
            onBackgroundImageAssetChange={setBackgroundImageAsset}
            onBackgroundImageSurfaceAlphaChange={setBackgroundImageSurfaceAlpha}
            onBackgroundMediaTypeChange={setBackgroundMediaType}
            onBackgroundRenderModeChange={setBackgroundRenderMode}
            onBackgroundVideoReplayModeChange={setBackgroundVideoReplayMode}
            onBackgroundVideoReplayIntervalSecChange={
              setBackgroundVideoReplayIntervalSec
            }
            onAiSelectionMaxCharsChange={setAiSelectionMaxChars}
            onAiSessionRecentOutputMaxCharsChange={
              setAiSessionRecentOutputMaxChars
            }
            onAiRequestTimeoutMsChange={setAiRequestTimeoutMs}
            onAiDebugLoggingEnabledChange={setAiDebugLoggingEnabled}
            onAiActiveProviderIdChange={setAiActiveProviderId}
            onAiPresetProviderCreate={addPresetProviderWithConfig}
            onAiCompatibleProviderCreate={addCompatibleProviderWithConfig}
            onAiProviderNameChange={updateProviderName}
            onAiProviderBaseUrlChange={updateProviderBaseUrl}
            onAiProviderModelChange={updateProviderModel}
            onAiProviderVendorChange={updateProviderVendor}
            onAiProviderApiKeyReplace={replaceProviderApiKey}
            onAiProviderApiKeyClear={clearProviderApiKey}
            onAiProviderRemove={removeProvider}
            onAiProviderTest={testProviderConnection}
            onSecurityUnlock={(password) =>
              unlockSecurity(password).then(async (nextStatus) => {
                if (!nextStatus.locked) {
                  await reloadProfiles();
                }
              })
            }
            onSecurityLock={() =>
              lockSecurity().then(async () => {
                await reloadProfiles();
              })
            }
            onSecurityEnableStrongProtection={(password) =>
              enableSecurityWithPassword(password).then(async () => {
                await reloadProfiles();
              })
            }
            onSecurityChangePassword={(currentPassword, nextPassword) =>
              changeSecurityPassword(currentPassword, nextPassword).then(
                async () => {
                  await reloadProfiles();
                },
              )
            }
            onSecurityEnableWeakProtection={() =>
              enableSecurityWeakProtection().then(async () => {
                await reloadProfiles();
              })
            }
            onWebLinksEnabledChange={setWebLinksEnabled}
            onCommandAutocompleteEnabledChange={setCommandAutocompleteEnabled}
            onSelectionAutoCopyEnabledChange={setSelectionAutoCopyEnabled}
            onAutoReconnectOnPoweroffChange={setAutoReconnectOnPoweroff}
            onAutoReconnectOnRebootChange={setAutoReconnectOnReboot}
            onCursorStyleChange={setCursorStyle}
            onTerminalFontFamilyModeChange={setTerminalFontFamilyMode}
            onScrollbackChange={setScrollback}
            onTerminalPathSyncEnabledChange={setTerminalPathSyncEnabled}
            onResourceMonitorEnabledChange={setResourceMonitorEnabled}
            onResourceMonitorIntervalSecChange={setResourceMonitorIntervalSec}
            onHostKeyPolicyChange={setHostKeyPolicy}
            appSaveState={appSaveState}
            appSaveError={appSaveError}
            onAppSaveRetry={retryAppSave}
            aiSaveState={aiSaveState}
            aiSaveError={aiSaveError}
            onAiSaveRetry={retryAiSave}
            sessionSaveState={sessionSaveState}
            sessionSaveError={sessionSaveError}
            onSessionSaveRetry={retrySessionSave}
            onClose={() => setConfigModalOpen(false)}
            onSectionChange={setActiveConfigSection}
            t={t}
          />
        ) : null}
      </Suspense>
      <NoticeHost />
    </>
  );
}
