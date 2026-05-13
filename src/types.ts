import type { TranslationKey } from "./i18n";

/** 认证方式。 */
export type AuthType = "password" | "privateKey" | "agent";

/** 终端 Bell 响应模式。 */
export type TerminalBellMode = "silent" | "sound";

/** 主机配置数据。 */
export type HostProfile = {
  id: string;
  name: string;
  iconKey?: string | null;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  identityFiles?: string[] | null;
  privateKeyPassphraseRef?: string | null;
  passwordRef?: string | null;
  knownHost?: string | null;
  proxyCommand?: string | null;
  proxyJump?: string | null;
  addKeysToAgent?: string | null;
  userKnownHostsFile?: string | null;
  strictHostKeyChecking?: boolean | null;
  tags?: string[] | null;
  terminalType?: string | null;
  targetSystem?: string | null;
  charset?: string | null;
  wordSeparators?: string | null;
  bellMode?: TerminalBellMode | null;
  bellCooldownMs?: number | null;
  description?: string | null;
};

/** SSH 会话元数据。 */
export type Session = {
  sessionId: string;
  profileId: string;
  state: "connecting" | "connected" | "disconnected" | "error";
  createdAt: number;
  lastError?: {
    code: string;
    message: string;
    detail?: string | null;
    details?: string | null;
  } | null;
};

/** SSH 配置列表中的连接中状态。 */
export type SshConnectState = {
  cancellable: boolean;
};

/** SSH 配置列表中的连接中状态映射。 */
export type SshConnectStateMap = Record<string, SshConnectState>;

/** 连接配置列表中的连接中标记映射。 */
export type ConnectingProfileMap = Record<string, true>;

/** 统一的会话输入负载。 */
export type SessionInput =
  | {
      kind: "text";
      data: string;
    }
  | {
      kind: "binary";
      data: number[];
    };

/** 会话窗格标识。 */
export type SessionPaneId = string;

/** 会话窗格树节点。 */
export type SessionPaneNode =
  | {
      kind: "leaf";
      paneId: SessionPaneId;
      sessionIds: string[];
      activeSessionId: string | null;
    }
  | {
      kind: "split";
      axis: "horizontal" | "vertical";
      ratio: number;
      first: SessionPaneNode;
      second: SessionPaneNode;
    };

/** 会话工作区状态。 */
export type SessionWorkspaceState = {
  root: SessionPaneNode | null;
  activePaneId: SessionPaneId | null;
};

/** SFTP 文件条目。 */
export type SftpEntry = {
  path: string;
  name: string;
  kind: "file" | "dir" | "link";
  hidden?: boolean | null;
  size?: number | null;
  mtime?: number | null;
  permissions?: string | null;
  owner?: string | null;
  group?: string | null;
};

/** 远端编辑实例状态。 */
export type RemoteEditStatus =
  | "synced"
  | "pending_confirm"
  | "uploading"
  | "sync_failed";

/** 远端编辑实例快照。 */
export type RemoteEditSnapshot = {
  instanceId: string;
  sessionId: string;
  remotePath: string;
  localPath: string;
  fileName: string;
  downloadedAt: number;
  remoteMtime?: number | null;
  remoteSize?: number | null;
  trackChanges: boolean;
  status: RemoteEditStatus;
  lastSyncedAt: number;
  lastErrorCode?: string | null;
  lastError?: string | null;
};

/** SFTP 传输进度。 */
export type SftpTransferKind = "file" | "directory" | "batch";
export type SftpTransferStatus =
  | "running"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled";

/** SFTP 传输进度。 */
export type SftpProgress = {
  sessionId: string;
  transferId: string;
  op: "upload" | "download";
  kind: SftpTransferKind;
  path: string;
  displayName: string;
  itemLabel: string;
  targetName?: string | null;
  currentItemName?: string | null;
  transferred: number;
  total?: number | null;
  completedItems: number;
  totalItems?: number | null;
  status: SftpTransferStatus;
  failedItems: number;
};

/** SSH 隧道类型。 */
export type SshTunnelKind = "local" | "remote" | "dynamic";

/** SSH 隧道状态。 */
export type SshTunnelStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

/** SSH 隧道创建参数。 */
export type SshTunnelSpec = {
  kind: SshTunnelKind;
  name?: string | null;
  bindHost: string;
  bindPort: number;
  targetHost?: string | null;
  targetPort?: number | null;
};

/** SSH 隧道运行时快照。 */
export type SshTunnelRuntime = {
  tunnelId: string;
  sessionId: string;
  kind: SshTunnelKind;
  name?: string | null;
  bindHost: string;
  bindPort: number;
  targetHost?: string | null;
  targetPort?: number | null;
  status: SshTunnelStatus;
  bytesIn: number;
  bytesOut: number;
  activeConnections: number;
  lastError?: {
    code: string;
    message: string;
    detail?: string | null;
    details?: string | null;
  } | null;
};

/** 代理协议类型。 */
export type ProxyProtocol = "http" | "socks5";

/** 代理运行状态。 */
export type ProxyStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

/** 代理认证参数。 */
export type ProxyAuth = {
  username: string;
  password: string;
};

/** 代理创建参数。 */
export type ProxySpec = {
  protocol: ProxyProtocol;
  name?: string | null;
  bindHost: string;
  bindPort: number;
  auth?: ProxyAuth | null;
};

/** 代理实例运行时快照。 */
export type ProxyRuntime = {
  proxyId: string;
  protocol: ProxyProtocol;
  name?: string | null;
  bindHost: string;
  bindPort: number;
  status: ProxyStatus;
  bytesIn: number;
  bytesOut: number;
  activeConnections: number;
  lastError?: {
    code: string;
    message: string;
    detail?: string | null;
    details?: string | null;
  } | null;
};

/** RDP 分辨率模式。 */
export type RdpDisplayMode = "fixed" | "window_sync";

/** RDP 本地显示策略。 */
export type RdpDisplayStrategy = "fit" | "cover" | "stretch";

/** RDP 剪贴板模式。 */
export type RdpClipboardMode = "disabled" | "text";

/** RDP 重连策略。 */
export type RdpReconnectPolicy = {
  enabled: boolean;
  maxAttempts: number;
};

/** RDP 远端体验标志。 */
export type RdpPerformanceFlags = {
  wallpaper: boolean;
  fullWindowDrag: boolean;
  menuAnimations: boolean;
  theming: boolean;
  cursorShadow: boolean;
  cursorSettings: boolean;
  fontSmoothing: boolean;
  desktopComposition: boolean;
};

/** RDP Profile。 */
export type RdpProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  tags?: string[] | null;
  passwordRef?: string | null;
  domain?: string | null;
  ignoreCertificate: boolean;
  resolutionMode: RdpDisplayMode;
  displayStrategy: RdpDisplayStrategy;
  width?: number | null;
  height?: number | null;
  clipboardMode: RdpClipboardMode;
  reconnectPolicy: RdpReconnectPolicy;
  performanceFlags: RdpPerformanceFlags;
};

/** RDP 证书确认信息。 */
export type RdpCertificatePrompt = {
  fingerprint: string;
  subject: string;
  issuer: string;
};

/** RDP 会话状态。 */
export type RdpSessionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error"
  | "certificate_prompt";

/** RDP 会话快照。 */
export type RdpSessionSnapshot = {
  sessionId: string;
  profileId: string;
  state: RdpSessionState;
  createdAt: number;
  width: number;
  height: number;
  wsUrl?: string | null;
  lastError?: {
    code: string;
    message: string;
    detail?: string | null;
    details?: string | null;
  } | null;
  certificatePrompt?: RdpCertificatePrompt | null;
};

/** RDP 输入事件。 */
export type RdpInputEvent = {
  kind: string;
  x?: number;
  y?: number;
  button?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

/** SFTP 可用性状态。 */
export type SftpAvailability =
  | "ready"
  | "checking"
  | "disabled"
  | "unsupported";

/** 终端 cwd 来源类型。 */
export type TerminalCwdSource = "osc7" | "prompt" | "cmd" | "none";

/** 终端 cwd 能力状态。 */
export type TerminalCwdSupport = "supported" | "unsupported";

/** 终端 cwd 驱动目标。 */
export type TerminalCwdTarget = "local-fs" | "remote-sftp" | "none";

/** 终端路径联动状态。 */
export type TerminalPathSyncState = "active" | "paused-mismatch" | "disabled";

/** 终端当前目录快照。 */
export type TerminalWorkingDirectory = {
  path: string;
  username: string | null;
  source: Exclude<TerminalCwdSource, "none">;
};

/** 终端路径联动运行时模型。 */
export type TerminalPathSyncModel = {
  cwdSource: TerminalCwdSource;
  cwdSupport: TerminalCwdSupport;
  target: TerminalCwdTarget;
  syncState: TerminalPathSyncState;
};

/** 资源监控状态。 */
export type ResourceMonitorStatus =
  | "disabled"
  | "checking"
  | "ready"
  | "unsupported";

/** 资源监控不可用原因。 */
export type ResourceMonitorUnsupportedReason =
  | "host_key_untrusted"
  | "probe_failed"
  | "connect_failed"
  | "unsupported_platform"
  | "sample_failed";

/** CPU 资源快照。 */
export type ResourceCpuSnapshot = {
  totalPercent: number;
  userPercent: number;
  systemPercent: number;
  idlePercent: number;
  iowaitPercent: number;
  logicalCpuCount?: number;
};

/** 内存资源快照。 */
export type ResourceMemorySnapshot = {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
  cacheBytes: number;
};

/** 会话资源快照。 */
export type SessionResourceSnapshot = {
  sessionId: string;
  sampledAt: number;
  source: "local" | "ssh-linux";
  status: ResourceMonitorStatus;
  unsupportedReason?: ResourceMonitorUnsupportedReason | null;
  uptimeSeconds?: number | null;
  cpu?: ResourceCpuSnapshot | null;
  memory?: ResourceMemorySnapshot | null;
};

/** 应用事件来源模块。 */
export type AppEventScope =
  | "session"
  | "sftp"
  | "tunnel"
  | "proxy"
  | "remote-edit"
  | "rdp"
  | "ai"
  | "security"
  | "system";

/** 应用事件展示级别。 */
export type AppEventLevel = "info" | "success" | "warning" | "error";

/** 应用事件生命周期状态。 */
export type AppEventStatus =
  | "started"
  | "running"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled"
  | "state_changed";

/** 全局事件中心使用的结构化事件。 */
export type AppEvent = {
  id: string;
  timestamp: number;
  scope: AppEventScope;
  type: string;
  level: AppEventLevel;
  status?: AppEventStatus;
  sessionId?: string | null;
  profileId?: string | null;
  resourceId?: string | null;
  titleKey: TranslationKey;
  messageKey?: TranslationKey;
  vars?: Record<string, string | number | boolean | null>;
  details?: Record<string, unknown>;
};

/** 历史命令来源。 */
export type CommandHistorySource = "typed" | "quickbar" | "history";

/** 历史命令实时监听状态。 */
export type CommandHistoryLiveState = "listening" | "tracking";

/** 当前输入行的实时监听项。 */
export type CommandHistoryLiveCapture = {
  state: CommandHistoryLiveState;
  command: string;
  updatedAt: number;
};

/** 历史命令项。 */
export type CommandHistoryItem = {
  id: string;
  command: string;
  firstUsedAt: number;
  lastUsedAt: number;
  useCount: number;
  source: CommandHistorySource;
};

/**
 * 历史命令作用域类型。
 * 当前持久化与联想实际使用的是 `global`；
 * `ssh` / `local` 预留给未来按作用域持久化历史命令的扩展。
 */
export type CommandHistoryScopeType = "ssh" | "local" | "global";

/** 历史命令分桶。 */
export type CommandHistoryBucket = {
  scopeKey: string;
  scopeType: CommandHistoryScopeType;
  label: string;
  updatedAt: number;
  items: CommandHistoryItem[];
};

/** 历史命令存储结构。 */
export type CommandHistoryStore = {
  version: 1;
  buckets: Record<string, CommandHistoryBucket>;
};

/** 功能面板类型。 */
export type WidgetKey =
  | "profiles"
  | "rdp"
  | "files"
  | "transfers"
  | "events"
  | "history"
  | "ai"
  | "tunnels";
/** 功能面板区域。 */
export type WidgetArea = "left" | "right" | "bottom";

/** 主题标识。 */
export type ThemeId =
  | "dark"
  | "light"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha";
/** 会话 UI 状态。 */
export type SessionStateUi =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "reconnecting";
/** 断开连接原因。 */
export type DisconnectReason =
  | "exit"
  | "poweroff"
  | "reboot"
  | "network"
  | "unknown";

/** 本地 Shell 配置。 */
export type LocalShellKind = "native" | "wsl";

/** 本地 Shell 配置。 */
export type LocalShellProfile = {
  id: string;
  label: string;
  path: string;
  args: string[];
  kind: LocalShellKind;
  wslDistribution?: string | null;
};

/** 本地 Shell 终端配置。 */
export type LocalShellConfig = {
  terminalType?:
    | "xterm-256color"
    | "xterm"
    | "screen-256color"
    | "tmux-256color"
    | "vt100";
  charset?: "utf-8" | "gbk" | "gb18030";
  wordSeparators?: string;
  bellMode?: TerminalBellMode;
  bellCooldownMs?: number;
};

/** 本地会话元数据。 */
export type LocalSessionMeta = {
  shellId: string | null;
  label: string;
  shellKind: LocalShellKind;
  wslDistribution?: string | null;
  launchConfig?: LocalShellConfig;
};

/** 快捷命令分组。 */
export type QuickCommandGroup = {
  id: string;
  name: string;
  order: number;
  visible: boolean;
};

/** 快捷命令项。 */
export type QuickCommandItem = {
  id: string;
  label: string;
  command: string;
  groupId: string;
  type?: "sendText";
};

/** 快捷栏配置。 */
export type QuickBarConfig = {
  version: 1;
  showGroupTitle?: boolean;
  groups: QuickCommandGroup[];
  commands: QuickCommandItem[];
};
