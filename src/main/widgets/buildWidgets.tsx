/**
 * 工作区面板装配模块。
 * 职责：将各领域状态与操作映射为可渲染的面板组件集合。
 */
import type React from "react";
import HostWidget from "@/widgets/profiles/components/HostWidget";
import TransfersWidget from "@/widgets/transfers/components/TransfersWidget";
import SftpWidget from "@/widgets/files/components/SftpWidget";
import EventsWidget from "@/widgets/events/components/EventsWidget";
import CommandHistoryWidget from "@/widgets/history/components/CommandHistoryWidget";
import AiWidget from "@/widgets/ai/components/AiWidget";
import TunnelWidget from "@/widgets/tunnels/components/TunnelWidget";
import RdpWidget from "@/widgets/rdp/components/RdpWidget";
import type { AiChatMessage } from "@/features/ai/types";
import type { Locale, Translate } from "@/i18n";
import type {
  CommandHistoryItem,
  CommandHistoryLiveCapture,
  ConnectingProfileMap,
  HostProfile,
  LocalShellProfile,
  AppEvent,
  RdpProfile,
  SshConnectStateMap,
  WidgetKey,
  SessionStateUi,
  SftpAvailability,
  SftpEntry,
  SftpProgress,
  SshTunnelRuntime,
  SshTunnelSpec,
} from "@/types";

type buildWidgetsProps = {
  profiles: HostProfile[];
  rdpProfiles: RdpProfile[];
  rdpGroups: string[];
  sshGroups: string[];
  activeProfileId: string | null;
  sshConnectingProfiles: SshConnectStateMap;
  activeRdpProfileId: string | null;
  rdpConnectingProfiles: ConnectingProfileMap;
  availableShells: LocalShellProfile[];
  activeSessionId: string | null;
  isRemoteSession: boolean;
  isRemoteConnected: boolean;
  transferProgress: SftpProgress | null;
  busyMessage: string | null;
  appEvents: AppEvent[];
  historyLoaded: boolean;
  hasActiveSession: boolean;
  historyLiveCapture: CommandHistoryLiveCapture | null;
  historyItems: CommandHistoryItem[];
  historySearchQuery: string;
  aiMessages: AiChatMessage[];
  aiDraft: string;
  aiAvailable: boolean;
  aiUnavailableMessage: string | null;
  aiPending: boolean;
  aiWaitingFirstChunk: boolean;
  aiErrorMessage: string | null;
  isFloatingAiWidget: boolean;
  currentPath: string;
  sftpAvailability: SftpAvailability;
  terminalPathSyncStatus:
    | "active"
    | "paused"
    | "checking"
    | "unsupported"
    | "disabled";
  entries: SftpEntry[];
  locale: Locale;
  t: Translate;
  pickProfile: (profileId: string) => void;
  pickRdpProfile: (profileId: string) => void;
  onConnectProfile: (profileInput: HostProfile) => Promise<void>;
  onCancelSshConnectProfile: (profileId: string) => Promise<void>;
  onConnectRdpProfile: (profile: RdpProfile) => Promise<void>;
  onOpenNewRdpProfile: () => void;
  onOpenEditRdpProfile: (profile: RdpProfile) => void;
  onRemoveRdpProfile: (profile: RdpProfile) => Promise<void>;
  onAddRdpGroup: (groupName: string) => boolean;
  onRenameRdpGroup: (from: string, to: string) => Promise<boolean>;
  onRemoveRdpGroup: (groupName: string) => Promise<boolean>;
  onMoveRdpProfileToGroup: (
    profileId: string,
    targetGroup: string | null,
  ) => Promise<boolean>;
  onOpenNewProfile: () => void;
  onImportOpenSshConfig: () => void;
  onOpenEditProfile: (profile: HostProfile) => void;
  onRemoveProfile: (profile: HostProfile) => void;
  onHistorySearchQueryChange: (value: string) => void;
  onExecuteHistoryItem: (command: string) => void;
  onAiDraftChange: (value: string) => void;
  onAiSend: () => Promise<void>;
  onAiCancel: () => void;
  onAiClear: () => void;
  onAddGroup: (groupName: string) => boolean;
  onRenameGroup: (from: string, to: string) => Promise<boolean>;
  onRemoveGroup: (groupName: string) => Promise<boolean>;
  onMoveProfileToGroup: (
    profileId: string,
    targetGroup: string | null,
  ) => Promise<boolean>;
  onConnectLocalShell: (shell: LocalShellProfile | null) => void;
  onOpenLocalShellProfile: (shell: LocalShellProfile) => void;
  onRefreshLocalShells: () => Promise<void>;
  onRefreshList: (path?: string) => Promise<void>;
  onOpenRemoteDir: (path: string) => Promise<void>;
  onOpenFile: (entry: SftpEntry) => Promise<void>;
  onUploadFile: () => Promise<void>;
  onUploadDroppedPaths: (paths: string[]) => Promise<void>;
  onDownloadFile: (entry: SftpEntry) => Promise<void>;
  onCancelTransfer: () => Promise<void>;
  onCreateFolder: (name: string) => Promise<void>;
  onRenameEntry: (entry: SftpEntry, name: string) => Promise<void>;
  onRemoveEntry: (entry: SftpEntry) => Promise<void>;
  tunnelSessionId: string | null;
  tunnelSupportsSsh: boolean;
  tunnelSessionState: SessionStateUi | null;
  tunnelSessionLabel: string | null;
  tunnelSessionHost: string | null;
  tunnelSessionUsername: string | null;
  tunnelRuntimes: SshTunnelRuntime[];
  onOpenTunnel: (spec: SshTunnelSpec) => Promise<void>;
  onCloseTunnel: (tunnelId: string) => Promise<void>;
  onCloseAllTunnels: () => Promise<void>;
};

/** 构建工作区面板集合。 */
export function buildWidgets(
  props: buildWidgetsProps,
): Record<WidgetKey, React.ReactNode> {
  const {
    profiles,
    rdpProfiles,
    rdpGroups,
    sshGroups,
    activeProfileId,
    sshConnectingProfiles,
    activeRdpProfileId,
    rdpConnectingProfiles,
    availableShells,
    activeSessionId,
    isRemoteSession,
    isRemoteConnected,
    transferProgress,
    busyMessage,
    appEvents,
    historyLoaded,
    hasActiveSession,
    historyLiveCapture,
    historyItems,
    historySearchQuery,
    aiMessages,
    aiDraft,
    aiAvailable,
    aiUnavailableMessage,
    aiPending,
    aiWaitingFirstChunk,
    aiErrorMessage,
    isFloatingAiWidget,
    currentPath,
    sftpAvailability,
    terminalPathSyncStatus,
    entries,
    locale,
    t,
    pickProfile,
    pickRdpProfile,
    onConnectProfile,
    onCancelSshConnectProfile,
    onConnectRdpProfile,
    onOpenNewRdpProfile,
    onOpenEditRdpProfile,
    onRemoveRdpProfile,
    onAddRdpGroup,
    onRenameRdpGroup,
    onRemoveRdpGroup,
    onMoveRdpProfileToGroup,
    onOpenNewProfile,
    onImportOpenSshConfig,
    onOpenEditProfile,
    onRemoveProfile,
    onHistorySearchQueryChange,
    onExecuteHistoryItem,
    onAiDraftChange,
    onAiSend,
    onAiCancel,
    onAiClear,
    onAddGroup,
    onRenameGroup,
    onRemoveGroup,
    onMoveProfileToGroup,
    onConnectLocalShell,
    onOpenLocalShellProfile,
    onRefreshLocalShells,
    onRefreshList,
    onOpenRemoteDir,
    onOpenFile,
    onUploadFile,
    onUploadDroppedPaths,
    onDownloadFile,
    onCancelTransfer,
    onCreateFolder,
    onRenameEntry,
    onRemoveEntry,
    tunnelSessionId,
    tunnelSupportsSsh,
    tunnelSessionState,
    tunnelSessionLabel,
    tunnelSessionHost,
    tunnelSessionUsername,
    tunnelRuntimes,
    onOpenTunnel,
    onCloseTunnel,
    onCloseAllTunnels,
  } = props;

  return {
    profiles: (
      <HostWidget
        profiles={profiles}
        sshGroups={sshGroups}
        activeProfileId={activeProfileId}
        sshConnectingProfiles={sshConnectingProfiles}
        onPick={pickProfile}
        onConnectProfile={(profile) => {
          void onConnectProfile(profile);
        }}
        onCancelSshConnectProfile={(profileId) => {
          void onCancelSshConnectProfile(profileId);
        }}
        onOpenNewProfile={onOpenNewProfile}
        onImportOpenSshConfig={onImportOpenSshConfig}
        onOpenEditProfile={onOpenEditProfile}
        onRemoveProfile={onRemoveProfile}
        onAddGroup={onAddGroup}
        onRenameGroup={onRenameGroup}
        onRemoveGroup={onRemoveGroup}
        onMoveProfileToGroup={onMoveProfileToGroup}
        localShells={availableShells}
        onConnectLocalShell={onConnectLocalShell}
        onOpenLocalShellProfile={onOpenLocalShellProfile}
        onRefreshLocalShells={onRefreshLocalShells}
        t={t}
      />
    ),
    rdp: (
      <RdpWidget
        profiles={rdpProfiles}
        groups={rdpGroups}
        activeProfileId={activeRdpProfileId}
        connectingProfiles={rdpConnectingProfiles}
        onPick={pickRdpProfile}
        onConnectProfile={onConnectRdpProfile}
        onOpenNewProfile={onOpenNewRdpProfile}
        onOpenEditProfile={onOpenEditRdpProfile}
        onRemoveProfile={onRemoveRdpProfile}
        onAddGroup={onAddRdpGroup}
        onRenameGroup={onRenameRdpGroup}
        onRemoveGroup={onRemoveRdpGroup}
        onMoveProfileToGroup={onMoveRdpProfileToGroup}
        t={t}
      />
    ),
    transfers: (
      <TransfersWidget
        progress={transferProgress}
        busyMessage={busyMessage}
        events={appEvents}
        onCancel={onCancelTransfer}
        locale={locale}
        t={t}
      />
    ),
    files: (
      <SftpWidget
        isRemote={isRemoteConnected}
        isRemoteSession={isRemoteSession}
        currentPath={currentPath}
        sftpAvailability={sftpAvailability}
        terminalPathSyncStatus={terminalPathSyncStatus}
        entries={entries}
        onRefresh={(path) => {
          void onRefreshList(path);
        }}
        onOpen={(path) => {
          void onOpenRemoteDir(path);
        }}
        onOpenFile={onOpenFile}
        onUpload={() => {
          void onUploadFile();
        }}
        onDropUpload={(paths) => {
          return onUploadDroppedPaths(paths);
        }}
        onDownload={(entry) => {
          void onDownloadFile(entry);
        }}
        onMkdir={(name) => {
          void onCreateFolder(name);
        }}
        onRename={(entry, name) => {
          void onRenameEntry(entry, name);
        }}
        onRemove={(entry) => {
          return onRemoveEntry(entry);
        }}
        locale={locale}
        t={t}
      />
    ),
    events: <EventsWidget events={appEvents} locale={locale} t={t} />,
    history: (
      <CommandHistoryWidget
        loaded={historyLoaded}
        hasActiveSession={hasActiveSession}
        liveCapture={historyLiveCapture}
        items={historyItems}
        searchQuery={historySearchQuery}
        onSearchQueryChange={onHistorySearchQueryChange}
        onExecute={onExecuteHistoryItem}
        locale={locale}
        t={t}
      />
    ),
    ai: (
      <AiWidget
        activeSessionId={activeSessionId}
        aiAvailable={aiAvailable}
        aiUnavailableMessage={aiUnavailableMessage}
        messages={aiMessages}
        draft={aiDraft}
        pending={aiPending}
        waitingFirstChunk={aiWaitingFirstChunk}
        errorMessage={aiErrorMessage}
        keepLocalDraftBuffer={isFloatingAiWidget}
        onDraftChange={onAiDraftChange}
        onSend={onAiSend}
        onCancel={onAiCancel}
        onClear={onAiClear}
        t={t}
      />
    ),
    tunnels: (
      <TunnelWidget
        activeSessionId={tunnelSessionId}
        supportsSshTunnel={tunnelSupportsSsh}
        activeSessionState={tunnelSessionState}
        activeSessionLabel={tunnelSessionLabel}
        activeSessionHost={tunnelSessionHost}
        activeSessionUsername={tunnelSessionUsername}
        tunnels={tunnelRuntimes}
        onOpenTunnel={onOpenTunnel}
        onCloseTunnel={onCloseTunnel}
        onCloseAll={onCloseAllTunnels}
        t={t}
      />
    ),
  };
}
