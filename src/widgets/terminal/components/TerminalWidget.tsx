/**
 * 终端主面板编排层。
 * 职责：
 * 1. 把会话数据映射为 pane 树所需的展示字段。
 * 2. 串联终端容器注册、区域交互和活动会话切换。
 * 3. 挂载搜索栏与右键菜单等局部交互模块。
 */
import { useRef } from "react";
import type { Translate } from "@/i18n";
import type {
  DisconnectReason,
  HostProfile,
  LocalSessionMeta,
  Session,
  SessionStateUi,
  SessionWorkspaceState,
} from "@/types";
import TerminalPaneTree from "@/widgets/terminal/components/TerminalPaneTree";
import useTerminalMenus from "@/widgets/terminal/components/useTerminalMenus";
import useTerminalSearchBar from "@/widgets/terminal/components/TerminalSearchBar";
import "@/widgets/terminal/components/TerminalWidget.css";

type SearchOptions = {
  regex?: boolean;
  wholeWord?: boolean;
  caseSensitive?: boolean;
  incremental?: boolean;
  decorations?: {
    matchBackground?: string;
    matchBorder?: string;
    matchOverviewRuler: string;
    activeMatchBackground?: string;
    activeMatchBorder?: string;
    activeMatchColorOverviewRuler: string;
  };
};

type TerminalWidgetProps = {
  sessions: Session[];
  workspace: SessionWorkspaceState;
  profiles: HostProfile[];
  editingProfile: HostProfile;
  localSessionMeta: Record<string, LocalSessionMeta>;
  activeSessionId: string | null;
  activeSession: Session | null;
  activeSessionState: SessionStateUi | null;
  activeSessionReason: DisconnectReason | null;
  activeReconnectInfo: { attempt: number; delayMs: number } | null;
  reconnectInfoBySession: Record<string, { attempt: number; delayMs: number }>;
  sessionStates: Record<string, SessionStateUi>;
  sessionReasons: Record<string, DisconnectReason>;
  autoReconnectOnPoweroff: boolean;
  autoReconnectOnReboot: boolean;
  bellPendingBySession: Record<string, boolean>;
  registerTerminalContainer: (
    sessionId: string,
    element: HTMLDivElement | null,
  ) => void;
  isTerminalReady: (sessionId: string) => boolean;
  getTerminalTitle: (sessionId: string) => string | null;
  activeLinkMenu: { x: number; y: number; uri: string } | null;
  hasFocusedLine: () => boolean;
  onFocusLineAtPoint: (sessionId: string, clientY: number) => boolean;
  onCopyFocusedLine: () => Promise<boolean>;
  hasActiveSelection: () => boolean;
  getActiveSelectionText: () => string;
  onCopySelection: () => Promise<boolean>;
  onSendSelectionToAi: (selectionText: string) => Promise<void>;
  onOpenLink: () => Promise<boolean>;
  onCopyLink: () => Promise<boolean>;
  onCloseLinkMenu: () => void;
  onPaste: () => Promise<boolean>;
  onClear: () => boolean;
  onSearchNext: (keyword: string, options?: SearchOptions) => boolean;
  onSearchPrev: (keyword: string, options?: SearchOptions) => boolean;
  onSearchClear: () => void;
  searchResultStats: { resultIndex: number; resultCount: number } | null;
  autocomplete: {
    sessionId: string;
    items: Array<{ command: string; useCount: number }>;
    selectedIndex: number;
  } | null;
  autocompleteAnchor: {
    offset: number;
    maxHeight: number;
    placement: "top" | "bottom";
    left: number;
  } | null;
  onApplyAutocompleteSuggestion: (command?: string) => void;
  onDismissAutocomplete: () => void;
  isLocalSession: (sessionId: string | null) => boolean;
  onSwitchSession: (sessionId: string) => void;
  onFocusPane: (paneId: string) => void;
  onReorderPaneSessions: (
    paneId: string,
    sourceSessionId: string,
    targetSessionId: string,
  ) => void;
  onReconnectSession: (sessionId: string) => Promise<void>;
  onSaveSession: (sessionId: string) => Promise<void>;
  onSplitActivePane: (axis: "horizontal" | "vertical") => Promise<void>;
  onClosePaneSession: (paneId: string, sessionId: string) => Promise<void>;
  onResizePaneSplit: (paneId: string, ratio: number) => void;
  onCloseOtherSessionsInPane: (
    paneId: string,
    sessionId: string,
  ) => Promise<void>;
  onCloseSessionsToRightInPane: (
    paneId: string,
    sessionId: string,
  ) => Promise<void>;
  onCloseAllSessionsInPane: (paneId: string) => Promise<void>;
  t: Translate;
};

/** 终端主区域。 */
export default function TerminalWidget({
  sessions,
  workspace,
  profiles,
  editingProfile,
  localSessionMeta,
  activeSessionId,
  activeSessionState,
  activeSessionReason,
  activeReconnectInfo,
  reconnectInfoBySession,
  sessionStates,
  sessionReasons,
  autoReconnectOnPoweroff,
  autoReconnectOnReboot,
  bellPendingBySession,
  registerTerminalContainer,
  isTerminalReady,
  getTerminalTitle,
  activeLinkMenu,
  hasFocusedLine,
  onFocusLineAtPoint,
  onCopyFocusedLine,
  hasActiveSelection,
  getActiveSelectionText,
  onCopySelection,
  onSendSelectionToAi,
  onOpenLink,
  onCopyLink,
  onCloseLinkMenu,
  onPaste,
  onClear,
  onSearchNext,
  onSearchPrev,
  onSearchClear,
  searchResultStats,
  autocomplete,
  autocompleteAnchor,
  onApplyAutocompleteSuggestion,
  onDismissAutocomplete,
  isLocalSession,
  onSwitchSession,
  onFocusPane,
  onReorderPaneSessions,
  onReconnectSession,
  onSaveSession,
  onSplitActivePane,
  onClosePaneSession,
  onResizePaneSplit,
  onCloseOtherSessionsInPane,
  onCloseSessionsToRightInPane,
  onCloseAllSessionsInPane,
  t,
}: TerminalWidgetProps) {
  const containerRefs = useRef<
    Record<string, (element: HTMLDivElement | null) => void>
  >({});
  const hasWorkspaceSessions = !!workspace.root;

  function findSession(sessionId: string) {
    return sessions.find((item) => item.sessionId === sessionId) ?? null;
  }

  function resolveSessionLabel(sessionId: string) {
    const session = findSession(sessionId);
    if (!session) return t("session.defaultName");
    if (isLocalSession(sessionId)) {
      return localSessionMeta[sessionId]?.label ?? t("session.local");
    }
    const profile =
      profiles.find((entry) => entry.id === session.profileId) ??
      editingProfile;
    return profile.name || profile.host || t("session.defaultName");
  }

  function resolveSessionState(sessionId: string) {
    return sessionStates[sessionId] ?? "connecting";
  }

  function resolveSessionReason(sessionId: string) {
    return sessionReasons[sessionId] ?? null;
  }

  function getSessionBanner(sessionId: string) {
    const isActiveSession = activeSessionId === sessionId;
    const state = sessionStates[sessionId] ?? "connecting";
    const reason = sessionReasons[sessionId] ?? null;
    const reconnectInfo =
      reconnectInfoBySession[sessionId] ??
      (isActiveSession ? activeReconnectInfo : null);
    if (!reason) return null;
    if (
      reconnectInfo ||
      (isActiveSession &&
        activeSessionState === state &&
        activeSessionReason === reason &&
        state === "reconnecting")
    ) {
      if (reconnectInfo) {
        return t("terminal.reconnectHint.pending", {
          reason: t(`session.reason.${reason}`),
          attempt: String(reconnectInfo.attempt),
          delay: String(Math.ceil(reconnectInfo.delayMs / 1000)),
        });
      }
      return t("terminal.reconnectHint.connecting", {
        reason: t(`session.reason.${reason}`),
      });
    }
    if (state !== "disconnected") return null;
    if (reason === "exit") {
      return t("terminal.exitHint");
    }
    if (reason === "network") {
      return t("terminal.reconnectHint.manual", {
        reason: t("session.reason.network"),
      });
    }
    const autoReconnectEnabled =
      (reason === "poweroff" && autoReconnectOnPoweroff) ||
      (reason === "reboot" && autoReconnectOnReboot);
    if (!autoReconnectEnabled) {
      return t("terminal.reconnectHint.disabled", {
        reason: t(`session.reason.${reason}`),
      });
    }
    return t("terminal.reconnectHint.stopped", {
      reason: t(`session.reason.${reason}`),
    });
  }

  function getTerminalContainerRef(sessionId: string) {
    const existing = containerRefs.current[sessionId];
    if (existing) return existing;
    const refCallback = (element: HTMLDivElement | null) => {
      registerTerminalContainer(sessionId, element);
    };
    containerRefs.current[sessionId] = refCallback;
    return refCallback;
  }

  const { openSearch, renderedSearchBar } = useTerminalSearchBar({
    activeSessionId,
    onSearchNext,
    onSearchPrev,
    onSearchClear,
    searchResultStats,
    t,
  });

  const { openTerminalMenu, openSessionMenu, renderedMenus } = useTerminalMenus(
    {
      activeSessionId,
      activeLinkMenu,
      hasFocusedLine,
      hasActiveSelection,
      getActiveSelectionText,
      onCopyFocusedLine,
      onCopySelection,
      onSendSelectionToAi,
      onPaste,
      onClear,
      onOpenSearch: openSearch,
      onOpenLink,
      onCopyLink,
      onCloseLinkMenu,
      onFocusPane,
      onSwitchSession,
      onReconnectSession,
      onSaveSession,
      onSplitActivePane,
      onClosePaneSession,
      onCloseOtherSessionsInPane,
      onCloseSessionsToRightInPane,
      onCloseAllSessionsInPane,
      t,
    },
  );

  return (
    <main className="terminal-widget">
      <div className="terminal-body">
        {workspace.root && (
          <TerminalPaneTree
            root={workspace.root}
            activePaneId={workspace.activePaneId}
            getTerminalContainerRef={getTerminalContainerRef}
            isTerminalReady={isTerminalReady}
            getTerminalTitle={getTerminalTitle}
            getSessionLabel={resolveSessionLabel}
            getSessionState={resolveSessionState}
            getSessionReason={resolveSessionReason}
            bellPendingBySession={bellPendingBySession}
            getSessionBanner={getSessionBanner}
            onFocusPane={onFocusPane}
            onSwitchSession={onSwitchSession}
            onReorderPaneSessions={onReorderPaneSessions}
            onOpenSessionMenu={openSessionMenu}
            onClosePaneSession={(paneId, sessionId) => {
              if (activeSessionId !== sessionId) {
                onSwitchSession(sessionId);
              }
              onClosePaneSession(paneId, sessionId).catch(() => {});
            }}
            onResizePaneSplit={onResizePaneSplit}
            onPaneMouseDown={(sessionId, event) => {
              onDismissAutocomplete();
              onSwitchSession(sessionId);
              onFocusLineAtPoint(sessionId, event.clientY);
            }}
            onPaneContextMenu={(sessionId, event) => {
              event.preventDefault();
              onDismissAutocomplete();
              onSwitchSession(sessionId);
              onFocusLineAtPoint(sessionId, event.clientY);
              openTerminalMenu(event.clientX, event.clientY);
            }}
            autocomplete={autocomplete}
            autocompleteAnchor={autocompleteAnchor}
            onApplyAutocompleteSuggestion={onApplyAutocompleteSuggestion}
          />
        )}
        {!hasWorkspaceSessions && (
          <div className="terminal-empty">{t("terminal.empty")}</div>
        )}
        {renderedMenus}
        {renderedSearchBar}
      </div>
    </main>
  );
}
