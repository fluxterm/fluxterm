//! 引擎对外数据类型定义。
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::EngineError;

/// 认证方式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthType {
    Password,
    #[serde(alias = "key", alias = "public_key", alias = "publicKey")]
    PrivateKey,
    Agent,
}

/// 连接目标的主机配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub id: String,
    pub name: String,
    pub icon_key: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    #[serde(alias = "keyPath", alias = "publicKeyPath")]
    pub private_key_path: Option<String>,
    pub identity_files: Option<Vec<String>>,
    #[serde(alias = "keyPassphraseRef", alias = "publicKeyPassphraseRef")]
    pub private_key_passphrase_ref: Option<String>,
    pub password_ref: Option<String>,
    pub known_host: Option<String>,
    pub proxy_mode: Option<SshProxyMode>,
    pub proxy_config: Option<SshProxyConfig>,
    pub proxy_command: Option<String>,
    pub proxy_jump: Option<String>,
    pub jump_profile_ids: Option<Vec<String>>,
    pub add_keys_to_agent: Option<String>,
    pub user_known_hosts_file: Option<String>,
    pub strict_host_key_checking: Option<bool>,
    pub tags: Option<Vec<String>>,
    pub terminal_type: Option<String>,
    pub target_system: Option<String>,
    pub charset: Option<String>,
    pub word_separators: Option<String>,
    pub bell_mode: Option<String>,
    pub bell_cooldown_ms: Option<u32>,
    pub description: Option<String>,
}

/// SSH 出站代理模式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SshProxyMode {
    #[default]
    Direct,
    System,
    Manual,
}

/// SSH 出站代理协议。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshProxyProtocol {
    Http,
    Socks5,
}

/// SSH 出站代理配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProxyConfig {
    pub protocol: SshProxyProtocol,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password_ref: Option<String>,
    #[serde(default)]
    pub use_proxy_dns: Option<bool>,
}

/// 会话状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

/// 会话元数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: String,
    pub profile_id: String,
    pub state: SessionState,
    pub created_at: u64,
    pub last_error: Option<EngineError>,
}

/// SFTP 文件类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpEntryKind {
    File,
    Dir,
    Link,
}

/// SFTP 列表条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub path: String,
    pub name: String,
    pub kind: SftpEntryKind,
    pub hidden: Option<bool>,
    pub size: Option<u64>,
    pub mtime: Option<u64>,
    pub permissions: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

/// 终端大小。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

/// SFTP 传输方向。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpProgressOp {
    Upload,
    Download,
}

/// SFTP 传输任务类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpTransferKind {
    File,
    Directory,
    Batch,
}

/// SFTP 传输任务状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpTransferStatus {
    Running,
    Success,
    PartialSuccess,
    Failed,
    Cancelled,
}

/// SFTP 传输进度。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpProgress {
    pub session_id: String,
    pub transfer_id: String,
    pub op: SftpProgressOp,
    pub kind: SftpTransferKind,
    pub path: String,
    pub display_name: String,
    pub item_label: String,
    pub target_name: Option<String>,
    pub current_item_name: Option<String>,
    pub transferred: u64,
    pub total: Option<u64>,
    pub completed_items: u64,
    pub total_items: Option<u64>,
    pub status: SftpTransferStatus,
    pub failed_items: u64,
}

/// SSH 隧道类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshTunnelKind {
    Local,
    Remote,
    Dynamic,
}

/// SSH 隧道运行状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshTunnelStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

/// SSH 隧道创建参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelSpec {
    pub kind: SshTunnelKind,
    pub name: Option<String>,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
}

/// SSH 隧道运行时快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelRuntime {
    pub tunnel_id: String,
    pub session_id: String,
    pub kind: SshTunnelKind,
    pub name: Option<String>,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub status: SshTunnelStatus,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub active_connections: u32,
    pub last_error: Option<EngineError>,
}

/// 代理协议类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxyProtocol {
    Http,
    Socks5,
}

/// 代理运行状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxyStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

/// 代理认证参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAuth {
    pub username: String,
    pub password: String,
}

/// 代理实例创建参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySpec {
    pub protocol: ProxyProtocol,
    pub name: Option<String>,
    pub bind_host: String,
    pub bind_port: u16,
    pub auth: Option<ProxyAuth>,
}

/// 代理实例运行时快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRuntime {
    pub proxy_id: String,
    pub protocol: ProxyProtocol,
    pub name: Option<String>,
    pub bind_host: String,
    pub bind_port: u16,
    pub status: ProxyStatus,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub active_connections: u32,
    pub last_error: Option<EngineError>,
}

/// 资源监控状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceMonitorStatus {
    Checking,
    Ready,
    Unsupported,
}

/// 资源监控不可用原因。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceMonitorUnsupportedReason {
    HostKeyUntrusted,
    ProbeFailed,
    ConnectFailed,
    UnsupportedPlatform,
    SampleFailed,
}

/// CPU 资源快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCpuSnapshot {
    pub total_percent: f32,
    pub user_percent: f32,
    pub system_percent: f32,
    pub idle_percent: f32,
    pub iowait_percent: f32,
    pub logical_cpu_count: Option<u32>,
}

/// 内存资源快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMemorySnapshot {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
    pub available_bytes: u64,
    pub cache_bytes: u64,
}

/// 会话资源快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResourceSnapshot {
    pub session_id: String,
    pub sampled_at: u64,
    pub source: String,
    pub status: ResourceMonitorStatus,
    pub unsupported_reason: Option<ResourceMonitorUnsupportedReason>,
    pub uptime_seconds: Option<u64>,
    pub cpu: Option<ResourceCpuSnapshot>,
    pub memory: Option<ResourceMemorySnapshot>,
}

/// 引擎事件回调载荷。
#[derive(Debug, Clone)]
pub enum EngineEvent {
    TerminalOutput {
        session_id: String,
        data: String,
    },
    TerminalExit {
        session_id: String,
    },
    SftpProgress(SftpProgress),
    SshTunnelUpdate(SshTunnelRuntime),
    ProxyUpdate(ProxyRuntime),
    SessionResource(SessionResourceSnapshot),
    SessionStatus {
        session_id: String,
        state: SessionState,
        error: Option<EngineError>,
    },
}

/// 引擎事件回调函数类型。
pub type EventCallback = Arc<dyn Fn(EngineEvent) + Send + Sync>;
