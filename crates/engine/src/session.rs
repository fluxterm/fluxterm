//! 会话执行与命令分发。
//!
//! 除了终端读写，本模块还负责把 SFTP 传输命令调度到独立异步任务。
//! 这样长时间运行的上传/下载不会阻塞会话主循环，取消命令也能被及时接收。
//!
//! 对 SSH 会话而言，本模块负责主连接链路本身：
//!
//! - 建立 SSH 握手与认证
//! - 分配 PTY 并驱动终端输入输出
//! - 维护会话状态流转
//! - 调度 SFTP、端口转发等附属能力
//!
//! 资源监控不复用本模块内的主终端会话，而是通过独立 SSH 连接执行远端采样。
//! 这样可以隔离 PTY/终端交互与监控采样，避免监控链路承载用户态终端语义。
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex as StdMutex, MutexGuard};
use std::time::Duration;

use russh::client;
use russh::keys::{self, PublicKeyBase64};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, RwLock, mpsc};
use tokio::time::{MissedTickBehavior, interval, timeout};
use uuid::Uuid;

use crate::auth::{AuthPurpose, authenticate};
use crate::error::EngineError;
use crate::sftp::{
    next_transfer_id, sftp_download, sftp_download_dir, sftp_home, sftp_list, sftp_mkdir,
    sftp_remove, sftp_rename, sftp_resolve_path, sftp_stat, sftp_upload, sftp_upload_batch,
};
use crate::ssh_transport::{JumpHostSpec, connect_ssh_client};
use crate::telemetry::{TelemetryLevel, log_telemetry};
use crate::types::{
    EngineEvent, EventCallback, HostProfile, SessionState, SftpEntry, SshTunnelKind,
    SshTunnelRuntime, SshTunnelSpec, SshTunnelStatus, TerminalSize,
};
use crate::util::decode_terminal_output;

const TERMINAL_OUTPUT_BATCH_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// 会话发送通道句柄。
#[derive(Clone)]
pub struct SessionHandle {
    pub tx: mpsc::UnboundedSender<SessionCommand>,
}

/// 将 SSH 通道累计的字节解码并发送为单个终端输出批次。
fn emit_terminal_output_batch(
    on_event: &EventCallback,
    session_id: &str,
    buffer: &mut Vec<u8>,
    end_of_stream: bool,
) {
    let data = decode_terminal_output(buffer, end_of_stream);
    if data.is_empty() {
        return;
    }
    on_event(EngineEvent::TerminalOutput {
        session_id: session_id.to_string(),
        data,
    });
}

/// 正式 SSH 握手阶段要求匹配的 Host Key。
#[derive(Debug, Clone)]
pub struct ExpectedHostKey {
    pub public_key_base64: String,
    pub fingerprint_sha256: String,
}

/// 会话内部命令。
pub enum SessionCommand {
    Write(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    SftpList {
        path: String,
        respond_to: tokio::sync::oneshot::Sender<Result<Vec<SftpEntry>, EngineError>>,
    },
    SftpStat {
        path: String,
        respond_to: tokio::sync::oneshot::Sender<Result<SftpEntry, EngineError>>,
    },
    SftpHome {
        respond_to: tokio::sync::oneshot::Sender<Result<String, EngineError>>,
    },
    SftpResolvePath {
        path: String,
        respond_to: tokio::sync::oneshot::Sender<Result<String, EngineError>>,
    },
    SftpUpload {
        local_path: String,
        remote_path: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    SftpUploadBatch {
        local_paths: Vec<String>,
        remote_dir: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    SftpDownload {
        remote_path: String,
        local_path: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    SftpDownloadDir {
        remote_path: String,
        local_dir: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    /// 标记指定 transfer_id 的传输任务为取消状态。
    SftpCancelTransfer {
        transfer_id: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    SftpRename {
        from: String,
        to: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    SftpRemove {
        path: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    SftpMkdir {
        path: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    TunnelOpen {
        spec: SshTunnelSpec,
        respond_to: tokio::sync::oneshot::Sender<Result<SshTunnelRuntime, EngineError>>,
    },
    TunnelClose {
        tunnel_id: String,
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    TunnelList {
        respond_to: tokio::sync::oneshot::Sender<Result<Vec<SshTunnelRuntime>, EngineError>>,
    },
    TunnelCloseAll {
        respond_to: tokio::sync::oneshot::Sender<Result<(), EngineError>>,
    },
    Disconnect,
}

#[derive(Debug, Clone)]
struct HostKeyCheckState {
    error: Arc<StdMutex<Option<EngineError>>>,
}

impl HostKeyCheckState {
    fn lock_error(&self) -> Result<MutexGuard<'_, Option<EngineError>>, anyhow::Error> {
        self.error
            .lock()
            .map_err(|_| anyhow::anyhow!("host key check state lock poisoned"))
    }
}

#[derive(Debug, Clone)]
struct RemoteRoute {
    tunnel_id: String,
    target_host: String,
    target_port: u16,
}

struct TunnelHandle {
    runtime: Arc<Mutex<SshTunnelRuntime>>,
    stop: tokio::sync::watch::Sender<bool>,
}

impl TunnelHandle {
    fn snapshot(&self) -> Arc<Mutex<SshTunnelRuntime>> {
        Arc::clone(&self.runtime)
    }
}

/// SSH 客户端回调处理器。
pub struct ClientHandler {
    expected_host_key: Option<ExpectedHostKey>,
    host_key_state: HostKeyCheckState,
    remote_routes: Arc<RwLock<HashMap<u16, RemoteRoute>>>,
    session_id: String,
    on_event: Option<EventCallback>,
}

impl ClientHandler {
    /// 创建默认不校验 Host Key 的处理器。
    pub fn unchecked() -> Self {
        Self {
            expected_host_key: None,
            host_key_state: HostKeyCheckState {
                error: Arc::new(StdMutex::new(None)),
            },
            remote_routes: Arc::new(RwLock::new(HashMap::new())),
            session_id: String::new(),
            on_event: None,
        }
    }

    /// 创建带有预期 Host Key 的处理器。
    pub fn with_expected(expected_host_key: ExpectedHostKey) -> Self {
        Self {
            expected_host_key: Some(expected_host_key),
            host_key_state: HostKeyCheckState {
                error: Arc::new(StdMutex::new(None)),
            },
            remote_routes: Arc::new(RwLock::new(HashMap::new())),
            session_id: String::new(),
            on_event: None,
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let Some(expected) = &self.expected_host_key else {
            return Ok(true);
        };
        // 正式握手期间校验当前服务端公钥与预期公钥一致。
        let actual = server_public_key.public_key_base64();
        if actual == expected.public_key_base64 {
            return Ok(true);
        }
        *self.host_key_state.lock_error()? = Some(EngineError::new(
            "ssh_host_key_untrusted",
            format!(
                "SSH host key verification failed: server fingerprint does not match expected value (expected {})",
                expected.fingerprint_sha256
            ),
        ));
        Ok(false)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some(route) = self
            .remote_routes
            .read()
            .await
            .get(&(connected_port as u16))
            .cloned()
        else {
            return Ok(());
        };

        let on_event = self.on_event.clone();
        let session_id = self.session_id.clone();
        tokio::spawn(async move {
            let Ok(local_stream) =
                TcpStream::connect(format!("{}:{}", route.target_host, route.target_port)).await
            else {
                let mut stream = channel.into_stream();
                let _ = stream.shutdown().await;
                if let Some(on_event) = on_event {
                    on_event(EngineEvent::SshTunnelUpdate(SshTunnelRuntime {
                        tunnel_id: route.tunnel_id,
                        session_id,
                        kind: SshTunnelKind::Remote,
                        name: None,
                        bind_host: String::new(),
                        bind_port: connected_port as u16,
                        target_host: None,
                        target_port: None,
                        status: SshTunnelStatus::Failed,
                        bytes_in: 0,
                        bytes_out: 0,
                        active_connections: 0,
                        last_error: Some(EngineError::new(
                            "ssh_tunnel_forward_failed",
                            "Remote forwarding failed to connect to local target",
                        )),
                    }));
                }
                return;
            };

            let mut ssh_stream = channel.into_stream();
            let mut tcp_stream = local_stream;
            let _ = tokio::io::copy_bidirectional(&mut ssh_stream, &mut tcp_stream).await;
            let _ = ssh_stream.shutdown().await;
            let _ = tcp_stream.shutdown().await;
        });
        Ok(())
    }
}

fn build_tunnel_runtime(
    session_id: &str,
    tunnel_id: &str,
    spec: &SshTunnelSpec,
    status: SshTunnelStatus,
) -> SshTunnelRuntime {
    SshTunnelRuntime {
        tunnel_id: tunnel_id.to_string(),
        session_id: session_id.to_string(),
        kind: spec.kind,
        name: spec.name.clone(),
        bind_host: spec.bind_host.clone(),
        bind_port: spec.bind_port,
        target_host: spec.target_host.clone(),
        target_port: spec.target_port,
        status,
        bytes_in: 0,
        bytes_out: 0,
        active_connections: 0,
        last_error: None,
    }
}

fn emit_tunnel_update(on_event: &EventCallback, runtime: &SshTunnelRuntime) {
    on_event(EngineEvent::SshTunnelUpdate(runtime.clone()));
}

async fn open_local_or_dynamic_tunnel(
    session_id: String,
    session: Arc<Mutex<client::Handle<ClientHandler>>>,
    spec: SshTunnelSpec,
    on_event: EventCallback,
) -> Result<TunnelHandle, EngineError> {
    let tunnel_id = Uuid::new_v4().to_string();
    log_telemetry(
        TelemetryLevel::Info,
        "ssh.tunnel.open.start",
        None,
        json!({
            "sessionId": session_id.clone(),
            "tunnelId": tunnel_id.clone(),
            "kind": format!("{:?}", spec.kind),
            "bindHost": spec.bind_host.clone(),
            "bindPort": spec.bind_port,
            "targetHost": spec.target_host.clone(),
            "targetPort": spec.target_port,
        }),
    );
    let runtime = Arc::new(Mutex::new(build_tunnel_runtime(
        &session_id,
        &tunnel_id,
        &spec,
        SshTunnelStatus::Starting,
    )));

    let listener = TcpListener::bind(format!("{}:{}", spec.bind_host, spec.bind_port))
        .await
        .map_err(|err| {
            log_telemetry(
                TelemetryLevel::Warn,
                "ssh.tunnel.open.failed",
                None,
                json!({
                    "tunnelId": tunnel_id.clone(),
                    "error": {
                        "code": "ssh_tunnel_bind_failed",
                        "message": "Tunnel port listen failed",
                        "detail": err.to_string(),
                    }
                }),
            );
            EngineError::with_detail(
                "ssh_tunnel_bind_failed",
                "Tunnel port listen failed",
                err.to_string(),
            )
        })?;
    {
        let mut guard = runtime.lock().await;
        guard.bind_port = listener
            .local_addr()
            .map(|addr| addr.port())
            .unwrap_or(spec.bind_port);
        guard.status = SshTunnelStatus::Running;
        emit_tunnel_update(&on_event, &guard.clone());
    }

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let runtime_clone = Arc::clone(&runtime);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let Ok((tcp_stream, peer_addr)) = accepted else {
                        break;
                    };
                    let remote_host = match spec.kind {
                        SshTunnelKind::Dynamic => String::new(),
                        _ => spec.target_host.clone().unwrap_or_default(),
                    };
                    let remote_port = match spec.kind {
                        SshTunnelKind::Dynamic => 0,
                        _ => spec.target_port.unwrap_or_default(),
                    };
                    let runtime_for_conn = Arc::clone(&runtime_clone);
                    let on_event_for_conn = Arc::clone(&on_event);
                    let session_for_conn = Arc::clone(&session);
                    tokio::spawn(async move {
                        let (target_host, target_port, upstream) = match spec.kind {
                            SshTunnelKind::Dynamic => {
                                match socks5_connect_handshake(tcp_stream).await {
                                    Ok((host, port, stream)) => (host, port, stream),
                                    Err(_) => return,
                                }
                            }
                            _ => (remote_host, remote_port, tcp_stream),
                        };
                        {
                            let mut g = runtime_for_conn.lock().await;
                            g.active_connections = g.active_connections.saturating_add(1);
                            emit_tunnel_update(&on_event_for_conn, &g.clone());
                        }
                        let channel = session_for_conn
                            .lock()
                            .await
                            .channel_open_direct_tcpip(
                                target_host.clone(),
                                target_port as u32,
                                peer_addr.ip().to_string(),
                                peer_addr.port() as u32,
                            )
                            .await;
                        let Ok(channel) = channel else {
                            let mut g = runtime_for_conn.lock().await;
                            g.active_connections = g.active_connections.saturating_sub(1);
                            g.last_error = Some(EngineError::new("ssh_tunnel_open_failed", "Failed to create SSH forwarding channel"));
                            emit_tunnel_update(&on_event_for_conn, &g.clone());
                            return;
                        };

                        let mut ssh_stream = channel.into_stream();
                        let mut local_stream = upstream;
                        let copied = tokio::io::copy_bidirectional(&mut local_stream, &mut ssh_stream).await;
                        if let Ok((up, down)) = copied {
                            let mut g = runtime_for_conn.lock().await;
                            g.bytes_out = g.bytes_out.saturating_add(up);
                            g.bytes_in = g.bytes_in.saturating_add(down);
                        }
                        let _ = ssh_stream.shutdown().await;
                        let _ = local_stream.shutdown().await;
                        let mut g = runtime_for_conn.lock().await;
                        g.active_connections = g.active_connections.saturating_sub(1);
                        emit_tunnel_update(&on_event_for_conn, &g.clone());
                    });
                }
            }
        }
        let mut g = runtime_clone.lock().await;
        g.status = SshTunnelStatus::Stopped;
        g.active_connections = 0;
        log_telemetry(
            TelemetryLevel::Info,
            "ssh.tunnel.close.success",
            None,
            json!({
                "tunnelId": g.tunnel_id.clone(),
            }),
        );
        emit_tunnel_update(&on_event, &g.clone());
    });

    Ok(TunnelHandle {
        runtime,
        stop: stop_tx,
    })
}

async fn open_remote_tunnel(
    session_id: String,
    session: Arc<Mutex<client::Handle<ClientHandler>>>,
    spec: SshTunnelSpec,
    remote_routes: Arc<RwLock<HashMap<u16, RemoteRoute>>>,
    on_event: EventCallback,
) -> Result<TunnelHandle, EngineError> {
    let tunnel_id = Uuid::new_v4().to_string();
    log_telemetry(
        TelemetryLevel::Info,
        "ssh.tunnel.open.start",
        None,
        json!({
            "sessionId": session_id.clone(),
            "tunnelId": tunnel_id.clone(),
            "kind": format!("{:?}", spec.kind),
            "bindHost": spec.bind_host.clone(),
            "bindPort": spec.bind_port,
            "targetHost": spec.target_host.clone(),
            "targetPort": spec.target_port,
        }),
    );
    let runtime = Arc::new(Mutex::new(build_tunnel_runtime(
        &session_id,
        &tunnel_id,
        &spec,
        SshTunnelStatus::Starting,
    )));

    let assigned_port = session
        .lock()
        .await
        .tcpip_forward(spec.bind_host.clone(), spec.bind_port as u32)
        .await
        .map_err(|err| {
            log_telemetry(
                TelemetryLevel::Warn,
                "ssh.tunnel.open.failed",
                None,
                json!({
                    "tunnelId": tunnel_id.clone(),
                    "error": {
                        "code": "ssh_tunnel_open_failed",
                        "message": "Failed to create remote forwarding",
                        "detail": err.to_string(),
                    }
                }),
            );
            EngineError::with_detail(
                "ssh_tunnel_open_failed",
                "Failed to create remote forwarding",
                err.to_string(),
            )
        })?;
    let bind_port = assigned_port as u16;
    remote_routes.write().await.insert(
        bind_port,
        RemoteRoute {
            tunnel_id: tunnel_id.clone(),
            target_host: spec.target_host.clone().unwrap_or_default(),
            target_port: spec.target_port.unwrap_or_default(),
        },
    );
    {
        let mut guard = runtime.lock().await;
        guard.bind_port = bind_port;
        guard.status = SshTunnelStatus::Running;
        emit_tunnel_update(&on_event, &guard.clone());
    }

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let runtime_clone = Arc::clone(&runtime);
    tokio::spawn(async move {
        let _ = stop_rx.changed().await;
        {
            let mut g = runtime_clone.lock().await;
            g.status = SshTunnelStatus::Stopping;
            emit_tunnel_update(&on_event, &g.clone());
        }
        let _ = session
            .lock()
            .await
            .cancel_tcpip_forward(spec.bind_host.clone(), bind_port as u32)
            .await;
        remote_routes.write().await.remove(&bind_port);
        let mut g = runtime_clone.lock().await;
        g.status = SshTunnelStatus::Stopped;
        log_telemetry(
            TelemetryLevel::Info,
            "ssh.tunnel.close.success",
            None,
            json!({
                "tunnelId": g.tunnel_id.clone(),
            }),
        );
        emit_tunnel_update(&on_event, &g.clone());
    });

    Ok(TunnelHandle {
        runtime,
        stop: stop_tx,
    })
}

async fn close_tunnel(handle: TunnelHandle) -> Result<(), EngineError> {
    let _ = handle.stop.send(true);
    Ok(())
}

async fn socks5_connect_handshake(
    mut stream: TcpStream,
) -> Result<(String, u16, TcpStream), EngineError> {
    let mut greeting = [0u8; 2];
    stream.read_exact(&mut greeting).await.map_err(|err| {
        EngineError::with_detail(
            "ssh_tunnel_socks_handshake_failed",
            "SOCKS handshake failed",
            err.to_string(),
        )
    })?;
    if greeting[0] != 0x05 {
        return Err(EngineError::new(
            "ssh_tunnel_socks_handshake_failed",
            "Only SOCKS5 is supported",
        ));
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    stream.read_exact(&mut methods).await.map_err(|err| {
        EngineError::with_detail(
            "ssh_tunnel_socks_handshake_failed",
            "SOCKS handshake failed",
            err.to_string(),
        )
    })?;
    stream.write_all(&[0x05, 0x00]).await.map_err(|err| {
        EngineError::with_detail(
            "ssh_tunnel_socks_handshake_failed",
            "SOCKS handshake failed",
            err.to_string(),
        )
    })?;

    let mut request_head = [0u8; 4];
    stream.read_exact(&mut request_head).await.map_err(|err| {
        EngineError::with_detail(
            "ssh_tunnel_socks_handshake_failed",
            "Failed to read SOCKS request",
            err.to_string(),
        )
    })?;
    if request_head[1] != 0x01 {
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err(EngineError::new(
            "ssh_tunnel_socks_handshake_failed",
            "Only CONNECT command is supported",
        ));
    }
    let atyp = request_head[3];
    let host = match atyp {
        0x01 => {
            let mut ipv4 = [0u8; 4];
            stream.read_exact(&mut ipv4).await.map_err(|err| {
                EngineError::with_detail(
                    "ssh_tunnel_socks_handshake_failed",
                    "Failed to read SOCKS address",
                    err.to_string(),
                )
            })?;
            format!("{}.{}.{}.{}", ipv4[0], ipv4[1], ipv4[2], ipv4[3])
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(|err| {
                EngineError::with_detail(
                    "ssh_tunnel_socks_handshake_failed",
                    "Failed to read SOCKS domain",
                    err.to_string(),
                )
            })?;
            let mut domain = vec![0u8; len[0] as usize];
            stream.read_exact(&mut domain).await.map_err(|err| {
                EngineError::with_detail(
                    "ssh_tunnel_socks_handshake_failed",
                    "Failed to read SOCKS domain",
                    err.to_string(),
                )
            })?;
            String::from_utf8_lossy(&domain).to_string()
        }
        0x04 => {
            let mut ipv6 = [0u8; 16];
            stream.read_exact(&mut ipv6).await.map_err(|err| {
                EngineError::with_detail(
                    "ssh_tunnel_socks_handshake_failed",
                    "Failed to read SOCKS IPv6 address",
                    err.to_string(),
                )
            })?;
            std::net::Ipv6Addr::from(ipv6).to_string()
        }
        _ => {
            let _ = stream
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err(EngineError::new(
                "ssh_tunnel_socks_handshake_failed",
                "Unsupported address type",
            ));
        }
    };
    let mut port_buf = [0u8; 2];
    stream.read_exact(&mut port_buf).await.map_err(|err| {
        EngineError::with_detail(
            "ssh_tunnel_socks_handshake_failed",
            "Failed to read SOCKS port",
            err.to_string(),
        )
    })?;
    let port = u16::from_be_bytes(port_buf);
    stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|err| {
            EngineError::with_detail(
                "ssh_tunnel_socks_handshake_failed",
                "Failed to send SOCKS response",
                err.to_string(),
            )
        })?;
    Ok((host, port, stream))
}

/// 会话主循环，负责 SSH 与 SFTP 命令处理。
pub async fn run_session_loop(
    session_id: String,
    profile: HostProfile,
    expected_host_key: Option<ExpectedHostKey>,
    jump_spec: JumpHostSpec,
    size: TerminalSize,
    mut rx: mpsc::UnboundedReceiver<SessionCommand>,
    on_event: EventCallback,
) -> Result<(), EngineError> {
    // 正式 SSH 握手同样需要超时保护，覆盖 HostKeyPolicy::Off 等不走预检的路径。
    const SSH_CONNECT_TIMEOUT_SECS: u64 = 8;
    let host_key_state = HostKeyCheckState {
        error: Arc::new(StdMutex::new(None)),
    };
    let remote_routes: Arc<RwLock<HashMap<u16, RemoteRoute>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let connection = timeout(
        Duration::from_secs(SSH_CONNECT_TIMEOUT_SECS),
        connect_ssh_client(
            &profile,
            expected_host_key.clone(),
            &jump_spec,
            ClientHandler {
                expected_host_key,
                host_key_state: host_key_state.clone(),
                remote_routes: Arc::clone(&remote_routes),
                session_id: session_id.clone(),
                on_event: Some(Arc::clone(&on_event)),
            },
        ),
    )
    .await
    .map_err(|_| {
        EngineError::with_detail(
            "ssh_connect_failed",
            "Failed to connect to target host (connection timed out)",
            format!(
                "host={} port={} timeout={}s",
                profile.host, profile.port, SSH_CONNECT_TIMEOUT_SECS
            ),
        )
    })?
    .map_err(|err| {
        if let Ok(mut guard) = host_key_state.error.lock()
            && let Some(saved) = guard.take()
        {
            return saved;
        }
        err
    })?;
    let mut session = connection.handle;

    authenticate(&mut session, &profile, AuthPurpose::Session).await?;

    let mut channel = session.channel_open_session().await.map_err(|err| {
        EngineError::with_detail(
            "ssh_channel_open_failed",
            "Failed to open session channel",
            err.to_string(),
        )
    })?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            size.cols as u32,
            size.rows as u32,
            0,
            0,
            &[],
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                "ssh_pty_failed",
                "Failed to request terminal PTY",
                err.to_string(),
            )
        })?;
    channel.request_shell(true).await.map_err(|err| {
        EngineError::with_detail("ssh_shell_failed", "Failed to start shell", err.to_string())
    })?;

    // 只有在 PTY 和交互 shell 都就绪后，前端才应把会话视为真正可用。
    // 这样 files 面板首轮触发的 SFTP 初始化不会抢在首屏横幅/提示符输出之前，
    // 避免首个 SSH 会话在冷启动阶段出现“横幅缺失 + SFTP checking 卡住”的竞态。
    on_event(EngineEvent::SessionStatus {
        session_id: session_id.clone(),
        state: SessionState::Connected,
        error: None,
    });
    let session = Arc::new(Mutex::new(session));

    let mut running = true;
    // 传输任务使用 transfer_id 作为取消粒度；主循环只负责分发命令和置位取消标记，
    // 真正的读写执行发生在独立任务中，避免大文件传输期间无法响应取消请求。
    let transfer_cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let tunnel_handles: Arc<Mutex<HashMap<String, TunnelHandle>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let mut terminal_output = Vec::with_capacity(TERMINAL_OUTPUT_BATCH_BYTES);
    let mut terminal_output_interval = interval(TERMINAL_OUTPUT_FLUSH_INTERVAL);
    terminal_output_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    terminal_output_interval.tick().await;

    while running {
        tokio::select! {
            Some(cmd) = rx.recv() => {
                match cmd {
                    SessionCommand::Write(data) => {
                        let _ = channel.data(&data[..]).await;
                    }
                    SessionCommand::Resize { cols, rows } => {
                        let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    SessionCommand::SftpList { path, respond_to } => {
                        let session_handle = Arc::clone(&session);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let _ = respond_to.send(sftp_list(&guard, &path).await);
                        });
                    }
                    SessionCommand::SftpStat { path, respond_to } => {
                        let session_handle = Arc::clone(&session);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let _ = respond_to.send(sftp_stat(&guard, &path).await);
                        });
                    }
                    SessionCommand::SftpHome { respond_to } => {
                        let session_handle = Arc::clone(&session);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let _ = respond_to.send(sftp_home(&guard).await);
                        });
                    }
                    SessionCommand::SftpResolvePath { path, respond_to } => {
                        let session_handle = Arc::clone(&session);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let _ = respond_to.send(sftp_resolve_path(&guard, &path).await);
                        });
                    }
                    SessionCommand::SftpUpload { local_path, remote_path, respond_to } => {
                        let transfer_id = next_transfer_id();
                        let cancel_flag = Arc::new(AtomicBool::new(false));
                        transfer_cancellations.lock().await.insert(transfer_id.clone(), Arc::clone(&cancel_flag));
                        let session_handle = Arc::clone(&session);
                        let session_id = session_id.clone();
                        let on_event = Arc::clone(&on_event);
                        let transfer_cancellations = Arc::clone(&transfer_cancellations);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let result = sftp_upload(
                                &guard,
                                &session_id,
                                &local_path,
                                &remote_path,
                                &transfer_id,
                                &cancel_flag,
                                &on_event,
                            )
                            .await;
                            transfer_cancellations.lock().await.remove(&transfer_id);
                            let _ = respond_to.send(result);
                        });
                    }
                    SessionCommand::SftpUploadBatch { local_paths, remote_dir, respond_to } => {
                        let transfer_id = next_transfer_id();
                        let cancel_flag = Arc::new(AtomicBool::new(false));
                        transfer_cancellations.lock().await.insert(transfer_id.clone(), Arc::clone(&cancel_flag));
                        let session_handle = Arc::clone(&session);
                        let session_id = session_id.clone();
                        let on_event = Arc::clone(&on_event);
                        let transfer_cancellations = Arc::clone(&transfer_cancellations);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let result = sftp_upload_batch(
                                &guard,
                                &session_id,
                                &local_paths,
                                &remote_dir,
                                &transfer_id,
                                &cancel_flag,
                                &on_event,
                            )
                            .await;
                            transfer_cancellations.lock().await.remove(&transfer_id);
                            let _ = respond_to.send(result);
                        });
                    }
                    SessionCommand::SftpDownload { remote_path, local_path, respond_to } => {
                        let transfer_id = next_transfer_id();
                        let cancel_flag = Arc::new(AtomicBool::new(false));
                        transfer_cancellations.lock().await.insert(transfer_id.clone(), Arc::clone(&cancel_flag));
                        let session_handle = Arc::clone(&session);
                        let session_id = session_id.clone();
                        let on_event = Arc::clone(&on_event);
                        let transfer_cancellations = Arc::clone(&transfer_cancellations);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let result = sftp_download(
                                &guard,
                                &session_id,
                                &remote_path,
                                &local_path,
                                &transfer_id,
                                &cancel_flag,
                                &on_event,
                            )
                            .await;
                            transfer_cancellations.lock().await.remove(&transfer_id);
                            let _ = respond_to.send(result);
                        });
                    }
                    SessionCommand::SftpDownloadDir { remote_path, local_dir, respond_to } => {
                        let transfer_id = next_transfer_id();
                        let cancel_flag = Arc::new(AtomicBool::new(false));
                        transfer_cancellations.lock().await.insert(transfer_id.clone(), Arc::clone(&cancel_flag));
                        let session_handle = Arc::clone(&session);
                        let session_id = session_id.clone();
                        let on_event = Arc::clone(&on_event);
                        let transfer_cancellations = Arc::clone(&transfer_cancellations);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let result = sftp_download_dir(
                                &guard,
                                &session_id,
                                &remote_path,
                                &local_dir,
                                &transfer_id,
                                &cancel_flag,
                                &on_event,
                            )
                            .await;
                            transfer_cancellations.lock().await.remove(&transfer_id);
                            let _ = respond_to.send(result);
                        });
                    }
                    SessionCommand::SftpCancelTransfer { transfer_id, respond_to } => {
                        let result = transfer_cancellations
                            .lock()
                            .await
                            .get(&transfer_id)
                            .cloned()
                            .ok_or_else(|| EngineError::new("sftp_transfer_not_found", "Transfer task not found"))
                            .map(|flag| {
                                flag.store(true, Ordering::Relaxed);
                            });
                        let _ = respond_to.send(result.map(|_| ()));
                    }
                    SessionCommand::SftpRename { from, to, respond_to } => {
                        let session_handle = Arc::clone(&session);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let _ = respond_to.send(sftp_rename(&guard, &from, &to).await);
                        });
                    }
                    SessionCommand::SftpRemove { path, respond_to } => {
                        let session_handle = Arc::clone(&session);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let _ = respond_to.send(sftp_remove(&guard, &path).await);
                        });
                    }
                    SessionCommand::SftpMkdir { path, respond_to } => {
                        let session_handle = Arc::clone(&session);
                        tokio::spawn(async move {
                            let guard = session_handle.lock().await;
                            let _ = respond_to.send(sftp_mkdir(&guard, &path).await);
                        });
                    }
                    SessionCommand::TunnelOpen { spec, respond_to } => {
                        let open_result = match spec.kind {
                            SshTunnelKind::Local | SshTunnelKind::Dynamic => {
                                open_local_or_dynamic_tunnel(
                                    session_id.clone(),
                                    Arc::clone(&session),
                                    spec.clone(),
                                    Arc::clone(&on_event),
                                )
                                .await
                            }
                            SshTunnelKind::Remote => {
                                open_remote_tunnel(
                                    session_id.clone(),
                                    Arc::clone(&session),
                                    spec.clone(),
                                    Arc::clone(&remote_routes),
                                    Arc::clone(&on_event),
                                )
                                .await
                            }
                        };
                        match open_result {
                            Ok(handle) => {
                                let snapshot = handle.snapshot().lock().await.clone();
                                tunnel_handles.lock().await.insert(snapshot.tunnel_id.clone(), handle);
                                let _ = respond_to.send(Ok(snapshot));
                            }
                            Err(err) => {
                                let _ = respond_to.send(Err(err));
                            }
                        }
                    }
                    SessionCommand::TunnelClose { tunnel_id, respond_to } => {
                        let handle = tunnel_handles.lock().await.remove(&tunnel_id);
                        let result = if let Some(handle) = handle {
                            close_tunnel(handle).await
                        } else {
                            Err(EngineError::new("ssh_tunnel_not_found", "Tunnel not found"))
                        };
                        let _ = respond_to.send(result);
                    }
                    SessionCommand::TunnelList { respond_to } => {
                        let handles = tunnel_handles.lock().await;
                        let mut snapshots = Vec::with_capacity(handles.len());
                        for handle in handles.values() {
                            snapshots.push(handle.snapshot().lock().await.clone());
                        }
                        let _ = respond_to.send(Ok(snapshots));
                    }
                    SessionCommand::TunnelCloseAll { respond_to } => {
                        let mut handles = tunnel_handles.lock().await;
                        let values: Vec<TunnelHandle> = handles.drain().map(|(_, value)| value).collect();
                        drop(handles);
                        for handle in values {
                            let _ = close_tunnel(handle).await;
                        }
                        let _ = respond_to.send(Ok(()));
                    }
                    SessionCommand::Disconnect => {
                        let mut handles = tunnel_handles.lock().await;
                        let values: Vec<TunnelHandle> =
                            handles.drain().map(|(_, value)| value).collect();
                        drop(handles);
                        for handle in values {
                            let _ = close_tunnel(handle).await;
                        }
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        running = false;
                    }
                }
            }
            result = channel.wait(), if terminal_output.len() < TERMINAL_OUTPUT_BATCH_BYTES => {
                match result {
                    Some(russh::ChannelMsg::Data { data }) => {
                        terminal_output.extend_from_slice(data.as_ref());
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        terminal_output.extend_from_slice(data.as_ref());
                    }
                    Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => {
                        running = false;
                    }
                    Some(_) => {}
                }
            }
            _ = terminal_output_interval.tick(), if !terminal_output.is_empty() => {
                emit_terminal_output_batch(
                    &on_event,
                    &session_id,
                    &mut terminal_output,
                    false,
                );
            }
        }
    }
    emit_terminal_output_batch(&on_event, &session_id, &mut terminal_output, true);
    let mut handles = tunnel_handles.lock().await;
    let values: Vec<TunnelHandle> = handles.drain().map(|(_, value)| value).collect();
    drop(handles);
    for handle in values {
        let _ = close_tunnel(handle).await;
    }

    on_event(EngineEvent::TerminalExit {
        session_id: session_id.clone(),
    });
    on_event(EngineEvent::SessionStatus {
        session_id,
        state: SessionState::Disconnected,
        error: None,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ClientHandler, ExpectedHostKey};
    use crate::error::EngineError;
    use russh::client::Handler;
    use russh::keys::{self, HashAlg, PublicKeyBase64};

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";

    #[tokio::test]
    async fn client_handler_accepts_matching_expected_host_key() {
        let public_key = keys::parse_public_key_base64(KEY_A).expect("public key");
        let expected = ExpectedHostKey {
            public_key_base64: public_key.public_key_base64(),
            fingerprint_sha256: public_key.fingerprint(HashAlg::Sha256).to_string(),
        };
        let mut handler = ClientHandler::with_expected(expected);

        let accepted = handler
            .check_server_key(&public_key)
            .await
            .expect("check server key");

        assert!(accepted);
    }

    #[tokio::test]
    async fn client_handler_rejects_mismatched_expected_host_key() {
        let expected_key = keys::parse_public_key_base64(KEY_A).expect("expected key");
        let actual_key = keys::parse_public_key_base64(KEY_B).expect("actual key");
        let expected = ExpectedHostKey {
            public_key_base64: expected_key.public_key_base64(),
            fingerprint_sha256: expected_key.fingerprint(HashAlg::Sha256).to_string(),
        };
        let mut handler = ClientHandler::with_expected(expected);

        let accepted = handler
            .check_server_key(&actual_key)
            .await
            .expect("check server key");

        assert!(!accepted);
        let saved = handler
            .host_key_state
            .error
            .lock()
            .expect("lock")
            .clone()
            .expect("saved error");
        assert_eq!(saved.code, "ssh_host_key_untrusted");
    }

    #[tokio::test]
    async fn client_handler_unchecked_accepts_any_host_key() {
        let public_key = keys::parse_public_key_base64(KEY_A).expect("public key");
        let mut handler = ClientHandler::unchecked();

        let accepted = handler
            .check_server_key(&public_key)
            .await
            .expect("check server key");

        assert!(accepted);
        let saved: Option<EngineError> = handler.host_key_state.error.lock().expect("lock").clone();
        assert!(saved.is_none());
    }
}
