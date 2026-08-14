/**
 * 工作区面板装配模块。
 * 职责：将各领域状态与操作映射为可渲染的面板组件集合。
 */
import { Suspense } from "react";
import type React from "react";
import {
  AiWidget,
  BroadcastWidget,
  CommandHistoryWidget,
  EventsWidget,
  HostWidget,
  RdpWidget,
  SerialWidget,
  SftpWidget,
  TransfersWidget,
  TunnelWidget,
} from "@/main/widgets/lazyWidgets";
import type { AiChatMessage } from "@/features/ai/types";
import type {
  SftpTransferHistoryItem,
  SftpTransferTaskView,
} from "@/features/sftp/core/widgetTransfersSync";
import type { Locale, Translate } from "@/i18n";
import type {
  CommandHistoryItem,
  CommandHistoryLiveCapture,
  ConnectingProfileMap,
  HostProfile,
  LocalShellProfile,
  AppEvent,
  RdpProfile,
  SerialProfile,
  SshConnectStateMap,
  WidgetKey,
  Session,
  SessionGroup,
  SessionStateUi,
  SftpAvailability,
  SftpEntry,
  SshTunnelRuntime,
  SshTunnelSpec,
} from "@/types";

type buildWidgetsProps = {
  profiles: HostProfile[];
  rdpProfiles: RdpProfile[];
  rdpGroups: string[];
  serialProfiles: SerialProfile[];
  serialGroups: string[];
  connectingSerialProfileIds: string[];
  sshGroups: string[];
  activeProfileId: string | null;
  sshConnectingProfiles: SshConnectStateMap;
  activeRdpProfileId: string | null;
  rdpConnectingProfiles: ConnectingProfileMap;
  availableShells: LocalShellProfile[];
  activeSessionId: string | null;
  broadcastActiveSessionId: string | null;
  sessions: Session[];
  sessionGroups: SessionGroup[];
  sessionStates: Record<string, SessionStateUi>;
  isRemoteSession: boolean;
  isRemoteConnected: boolean;
  transferTasks: SftpTransferTaskView[];
  transferHistory: SftpTransferHistoryItem[];
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
  onConnectSerialProfile: (profile: SerialProfile) => void;
  onCancelSerialConnect: (profileId: string) => void;
  onPickSerialProfile: (profileId: string) => void;
  activeSerialProfileId: string | null;
  onOpenNewSerialProfile: (defaultGroup?: string | null) => void;
  onOpenEditSerialProfile: (profile: SerialProfile) => void;
  onRemoveSerialProfile: (profile: SerialProfile) => void;
  onSaveSerialGroups: (groups: string[]) => Promise<string[]>;
  onMoveSerialProfileToGroup: (
    profileId: string,
    targetGroup: string | null,
  ) => Promise<boolean>;
  onOpenNewRdpProfile: (defaultGroup?: string | null) => void;
  onOpenEditRdpProfile: (profile: RdpProfile) => void;
  onRemoveRdpProfile: (profile: RdpProfile) => Promise<void>;
  onAddRdpGroup: (groupName: string) => boolean;
  onRenameRdpGroup: (from: string, to: string) => Promise<boolean>;
  onRemoveRdpGroup: (groupName: string) => Promise<boolean>;
  onMoveRdpProfileToGroup: (
    profileId: string,
    targetGroup: string | null,
  ) => Promise<boolean>;
  onOpenNewProfile: (defaultGroup?: string | null) => void;
  onImportOpenSshConfig: () => void;
  onOpenEditProfile: (profile: HostProfile) => void;
  onDuplicateProfile: (profile: HostProfile) => void;
  onRemoveProfile: (profile: HostProfile) => void;
  onHistorySearchQueryChange: (value: string) => void;
  onExecuteHistoryItem: (command: string) => void;
  onAiDraftChange: (value: string) => void;
  onAiSend: () => Promise<void>;
  onAiCancel: () => void;
  onAiClear: () => void;
  onAiSendCodeToTerminal: (code: string) => void;
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
  onCancelTransfer: (sessionId: string, transferId: string) => Promise<void>;
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
  onBroadcastCommand: (
    sessionIds: string[],
    command: string,
  ) => Promise<{ successCount: number; failedCount: number }>;
};

/** 构建工作区面板集合。 */
export function buildWidgets(
  props: buildWidgetsProps,
): Record<WidgetKey, React.ReactNode> {
  const {
    profiles,
    rdpProfiles,
    rdpGroups,
    serialProfiles,
    serialGroups,
    connectingSerialProfileIds,
    sshGroups,
    activeProfileId,
    sshConnectingProfiles,
    activeRdpProfileId,
    rdpConnectingProfiles,
    availableShells,
    activeSessionId,
    broadcastActiveSessionId,
    sessions,
    sessionGroups,
    sessionStates,
    isRemoteSession,
    isRemoteConnected,
    transferTasks,
    transferHistory,
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
    onConnectSerialProfile,
    onCancelSerialConnect,
    onPickSerialProfile,
    activeSerialProfileId,
    onOpenNewSerialProfile,
    onOpenEditSerialProfile,
    onRemoveSerialProfile,
    onSaveSerialGroups,
    onMoveSerialProfileToGroup,
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
    onDuplicateProfile,
    onRemoveProfile,
    onHistorySearchQueryChange,
    onExecuteHistoryItem,
    onAiDraftChange,
    onAiSend,
    onAiCancel,
    onAiClear,
    onAiSendCodeToTerminal,
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
    onBroadcastCommand,
  } = props;

  return {
    profiles: (
      <Suspense fallback={null}>
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
          onDuplicateProfile={onDuplicateProfile}
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
      </Suspense>
    ),
    rdp: (
      <Suspense fallback={null}>
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
      </Suspense>
    ),
    serial: (
      <Suspense fallback={null}>
        <SerialWidget
          profiles={serialProfiles}
          groups={serialGroups}
          activeProfileId={activeSerialProfileId}
          connectingProfileIds={connectingSerialProfileIds}
          onConnect={onConnectSerialProfile}
          onCancelConnect={onCancelSerialConnect}
          onPick={onPickSerialProfile}
          onOpenNewProfile={onOpenNewSerialProfile}
          onOpenEditProfile={onOpenEditSerialProfile}
          onRemoveProfile={onRemoveSerialProfile}
          onSaveGroups={onSaveSerialGroups}
          onMoveProfileToGroup={onMoveSerialProfileToGroup}
          t={t}
        />
      </Suspense>
    ),
    transfers: (
      <Suspense fallback={null}>
        <TransfersWidget
          tasks={transferTasks}
          history={transferHistory}
          onCancel={onCancelTransfer}
          locale={locale}
          t={t}
        />
      </Suspense>
    ),
    files: (
      <Suspense fallback={null}>
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
      </Suspense>
    ),
    events: (
      <Suspense fallback={null}>
        <EventsWidget events={appEvents} locale={locale} t={t} />
      </Suspense>
    ),
    history: (
      <Suspense fallback={null}>
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
      </Suspense>
    ),
    ai: (
      <Suspense fallback={null}>
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
          onSendCodeToTerminal={onAiSendCodeToTerminal}
          t={t}
        />
      </Suspense>
    ),
    tunnels: (
      <Suspense fallback={null}>
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
      </Suspense>
    ),
    broadcast: (
      <Suspense fallback={null}>
        <BroadcastWidget
          sessions={sessions}
          activeSessionId={broadcastActiveSessionId}
          sessionGroups={sessionGroups}
          sessionStates={sessionStates}
          onSend={onBroadcastCommand}
          t={t}
        />
      </Suspense>
    ),
  };
}
