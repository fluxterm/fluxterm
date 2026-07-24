//! 全局代理运行时。
//!
//! 该模块提供与 SSH 会话解耦的全局代理能力：
//! 1. HTTP 代理（CONNECT + 绝对 URL）；
//! 2. SOCKS5 代理（支持无认证与用户名密码认证）；
//! 3. 代理连接数与流量统计。
use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Semaphore, watch};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::{Duration, Instant, sleep, timeout};
use uuid::Uuid;

use crate::error::EngineError;
use crate::proxy_error_codes::{
    PROXY_ACCEPT_FAILED, PROXY_AUTH_FAILED, PROXY_AUTH_REQUIRED, PROXY_BIND_FAILED,
    PROXY_CONNECTION_LIMIT_EXCEEDED, PROXY_HANDSHAKE_TIMEOUT, PROXY_HTTP_FORWARD_FAILED,
    PROXY_HTTP_HANDSHAKE_FAILED, PROXY_HTTP_PARSE_FAILED, PROXY_IO_READ_TIMEOUT,
    PROXY_IO_WRITE_TIMEOUT, PROXY_SHUTDOWN_TIMEOUT, PROXY_SOCKS5_HANDSHAKE_FAILED,
    PROXY_SOCKS5_REQUEST_FAILED, PROXY_TRANSFER_FAILED, PROXY_UPSTREAM_CONNECT_FAILED,
};
use crate::types::{
    EngineEvent, EventCallback, ProxyAuth, ProxyProtocol, ProxyRuntime, ProxySpec, ProxyStatus,
};
use fluxterm_logging::{LogLevel, log_event};

const MAX_ACTIVE_CONNECTIONS: u32 = 256;
const HANDSHAKE_TIMEOUT_SEC: u64 = 8;
const READ_TIMEOUT_SEC: u64 = 120;
const WRITE_TIMEOUT_SEC: u64 = 30;
const CLOSE_GRACE_TIMEOUT_MS: u64 = 1500;
const CLOSE_FORCE_ABORT_WAIT_MS: u64 = 500;
/// 流量上报节流间隔，避免高吞吐时事件风暴导致 UI 抖动与日志噪音。
const TRAFFIC_UPDATE_INTERVAL_MS: u64 = 200;

#[derive(Clone)]
struct ProxyLogContext {
    operation_id: Option<String>,
    proxy_id: String,
    protocol: ProxyProtocol,
    bind_host: String,
    bind_port: u16,
}

#[derive(Clone)]
struct ConnectionLogContext {
    proxy: ProxyLogContext,
    connection_id: String,
    peer_addr: Option<String>,
}

/// 单个代理实例句柄。
pub struct ProxyHandle {
    runtime: Arc<Mutex<ProxyRuntime>>,
    stop: watch::Sender<bool>,
}

impl ProxyHandle {
    /// 读取当前运行时快照。
    pub async fn snapshot(&self) -> ProxyRuntime {
        self.runtime.lock().await.clone()
    }

    /// 发送关闭信号。
    pub fn close(&self) {
        let _ = self.stop.send(true);
    }
}

/// 启动一个代理实例并返回句柄。
pub async fn open_proxy(
    spec: ProxySpec,
    on_event: EventCallback,
    operation_id: Option<&str>,
) -> Result<ProxyHandle, EngineError> {
    let proxy_id = Uuid::new_v4().to_string();
    let runtime = Arc::new(Mutex::new(ProxyRuntime {
        proxy_id: proxy_id.clone(),
        protocol: spec.protocol,
        name: spec.name.clone(),
        bind_host: spec.bind_host.clone(),
        bind_port: spec.bind_port,
        status: ProxyStatus::Starting,
        bytes_in: 0,
        bytes_out: 0,
        active_connections: 0,
        last_error: None,
    }));
    emit_proxy_update(&on_event, &runtime).await;

    let listener = TcpListener::bind(format!("{}:{}", spec.bind_host, spec.bind_port))
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_BIND_FAILED,
                "Failed to bind the proxy listener",
                err.to_string(),
            )
        })?;
    {
        let mut guard = runtime.lock().await;
        guard.bind_port = listener
            .local_addr()
            .map(|addr| addr.port())
            .unwrap_or(spec.bind_port);
        guard.status = ProxyStatus::Running;
        guard.last_error = None;
    }
    let snapshot = runtime.lock().await.clone();
    let proxy_log_ctx = ProxyLogContext {
        operation_id: operation_id.map(ToString::to_string),
        proxy_id: proxy_id.clone(),
        protocol: spec.protocol,
        bind_host: snapshot.bind_host.clone(),
        bind_port: snapshot.bind_port,
    };
    emit_proxy_update(&on_event, &runtime).await;

    let (stop_tx, mut stop_rx) = watch::channel(false);
    let runtime_for_loop = Arc::clone(&runtime);
    let on_event_for_loop = Arc::clone(&on_event);
    let tasks_for_loop: Arc<Mutex<HashMap<String, JoinHandle<()>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let tasks_for_conn_accept = Arc::clone(&tasks_for_loop);
    let stop_tx_for_accept = stop_tx.clone();
    let connection_limit = Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS as usize));
    let connection_limit_for_accept = Arc::clone(&connection_limit);
    let proxy_log_ctx_for_loop = proxy_log_ctx.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let Ok((stream, peer_addr)) = accepted else {
                        let err = EngineError::new(PROXY_ACCEPT_FAILED, "Failed to accept the proxy connection");
                        log_event!(
                            LogLevel::Error,
                            "proxy.runtime.accept.failed",
                            proxy_log_ctx_for_loop.operation_id.as_deref(),
                            json!({
                                "proxyId": proxy_log_ctx_for_loop.proxy_id,
                                "protocol": proxy_log_ctx_for_loop.protocol,
                                "bindHost": proxy_log_ctx_for_loop.bind_host,
                                "bindPort": proxy_log_ctx_for_loop.bind_port,
                                "error": {
                                    "code": err.code.clone(),
                                    "message": "Proxy runtime failed",
                                    "detail": err.detail.clone().unwrap_or(err.message.clone()),
                                }
                            }),
                        );
                        let mut guard = runtime_for_loop.lock().await;
                        guard.last_error = Some(err);
                        drop(guard);
                        emit_proxy_update(&on_event_for_loop, &runtime_for_loop).await;
                        break;
                    };
                    let Ok(connection_permit) = Arc::clone(&connection_limit_for_accept).try_acquire_owned() else {
                        log_event!(
                            LogLevel::Debug,
                            "proxy.connection.failed",
                            proxy_log_ctx_for_loop.operation_id.as_deref(),
                            json!({
                                "proxyId": proxy_log_ctx_for_loop.proxy_id,
                                "protocol": proxy_log_ctx_for_loop.protocol,
                                "bindHost": proxy_log_ctx_for_loop.bind_host,
                                "bindPort": proxy_log_ctx_for_loop.bind_port,
                                "peerAddr": peer_addr.to_string(),
                                "error": {
                                    "code": PROXY_CONNECTION_LIMIT_EXCEEDED,
                                    "message": "The connection limit has been reached",
                                },
                                "maxActiveConnections": MAX_ACTIVE_CONNECTIONS,
                            }),
                        );
                        let mut guard = runtime_for_loop.lock().await;
                        guard.last_error = Some(EngineError::new(
                            PROXY_CONNECTION_LIMIT_EXCEEDED,
                            "The connection limit has been reached",
                        ));
                        drop(guard);
                        emit_proxy_update(&on_event_for_loop, &runtime_for_loop).await;
                        drop(stream);
                        continue;
                    };
                    let runtime_for_conn = Arc::clone(&runtime_for_loop);
                    let on_event_for_conn = Arc::clone(&on_event_for_loop);
                    let mut stop_rx_for_conn = stop_tx_for_accept.subscribe();
                    let spec_for_conn = spec.clone();
                    let conn_task_id = Uuid::new_v4().to_string();
                    let conn_log_ctx = ConnectionLogContext {
                        proxy: proxy_log_ctx_for_loop.clone(),
                        connection_id: conn_task_id.clone(),
                        peer_addr: Some(peer_addr.to_string()),
                    };
                    let task = tokio::spawn(async move {
                        let _connection_permit = connection_permit;
                        let started_at = Instant::now();
                        on_conn_open(&runtime_for_conn, &on_event_for_conn, &conn_log_ctx).await;
                        let handled = tokio::select! {
                            _ = stop_rx_for_conn.changed() => {
                                Err(EngineError::new(PROXY_SHUTDOWN_TIMEOUT, "The connection was terminated while the proxy was shutting down"))
                            }
                            result = handle_client(
                                stream,
                                &spec_for_conn,
                                &runtime_for_conn,
                                &on_event_for_conn,
                                &conn_log_ctx,
                            ) => result,
                        };
                        match handled {
                            Ok((bytes_out, bytes_in)) => {
                                log_event!(
                                    LogLevel::Debug,
                                    "proxy.connection.succeeded",
                                    conn_log_ctx.proxy.operation_id.as_deref(),
                                    json!({
                                        "proxyId": conn_log_ctx.proxy.proxy_id,
                                        "connectionId": conn_log_ctx.connection_id,
                                        "protocol": conn_log_ctx.proxy.protocol,
                                        "bindHost": conn_log_ctx.proxy.bind_host,
                                        "bindPort": conn_log_ctx.proxy.bind_port,
                                        "peerAddr": conn_log_ctx.peer_addr,
                                        "bytesOut": bytes_out,
                                        "bytesIn": bytes_in,
                                        "durationMs": started_at.elapsed().as_millis(),
                                    }),
                                );
                            }
                            Err(err) => {
                                let err_code = err.code.clone();
                                let err_message = err.message.clone();
                                let err_detail = err.detail.clone();
                                let peer_addr = conn_log_ctx
                                    .peer_addr
                                    .clone()
                                    .unwrap_or_else(|| "unknown".to_string());
                                let mut detail_segments = vec![
                                    format!("peerAddr={peer_addr}"),
                                    format!("connectionId={}", conn_log_ctx.connection_id),
                                ];
                                if let Some(detail) = err_detail.clone()
                                    && !detail.trim().is_empty()
                                {
                                    detail_segments.push(detail);
                                }
                                let enriched_detail = detail_segments.join("; ");
                                log_event!(
                                    LogLevel::Debug,
                                    "proxy.connection.failed",
                                    conn_log_ctx.proxy.operation_id.as_deref(),
                                    json!({
                                        "proxyId": conn_log_ctx.proxy.proxy_id,
                                        "connectionId": conn_log_ctx.connection_id,
                                        "protocol": spec_for_conn.protocol,
                                        "bindHost": spec_for_conn.bind_host,
                                        "bindPort": spec_for_conn.bind_port,
                                        "peerAddr": conn_log_ctx.peer_addr,
                                        "durationMs": started_at.elapsed().as_millis(),
                                        "error": {
                                            "code": err_code,
                                            "message": "Proxy connection failed",
                                            "detail": err_detail.clone().unwrap_or(err_message.clone()),
                                        }
                                    }),
                                );
                                let mut guard = runtime_for_conn.lock().await;
                                guard.last_error = Some(EngineError::with_detail(
                                    err.code,
                                    err.message,
                                    enriched_detail,
                                ));
                                drop(guard);
                                emit_proxy_update(&on_event_for_conn, &runtime_for_conn).await;
                            }
                        }
                        on_conn_close(&runtime_for_conn, &on_event_for_conn, &conn_log_ctx).await;
                    });
                    tasks_for_conn_accept.lock().await.insert(conn_task_id, task);
                    reap_finished_tasks(&tasks_for_loop).await;
                }
            }
        }
        {
            let mut guard = runtime_for_loop.lock().await;
            guard.status = ProxyStatus::Stopping;
        }
        emit_proxy_update(&on_event_for_loop, &runtime_for_loop).await;

        let graceful_deadline = Instant::now() + Duration::from_millis(CLOSE_GRACE_TIMEOUT_MS);
        loop {
            reap_finished_tasks(&tasks_for_loop).await;
            if tasks_for_loop.lock().await.is_empty() {
                break;
            }
            if Instant::now() >= graceful_deadline {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
        let force_abort_targets = {
            let mut guard = tasks_for_loop.lock().await;
            if guard.is_empty() {
                Vec::new()
            } else {
                let targets = guard.drain().map(|(_, handle)| handle).collect::<Vec<_>>();
                log_event!(
                    LogLevel::Warn,
                    "proxy.runtime.failed",
                    proxy_log_ctx_for_loop.operation_id.as_deref(),
                    json!({
                        "proxyId": proxy_log_ctx_for_loop.proxy_id,
                        "protocol": proxy_log_ctx_for_loop.protocol,
                        "bindHost": proxy_log_ctx_for_loop.bind_host,
                        "bindPort": proxy_log_ctx_for_loop.bind_port,
                        "error": {
                            "code": PROXY_SHUTDOWN_TIMEOUT,
                            "message": "Graceful shutdown timed out; forcing termination",
                        },
                    }),
                );
                targets
            }
        };
        if !force_abort_targets.is_empty() {
            force_abort_targets.into_iter().for_each(|handle| {
                handle.abort();
            });
            sleep(Duration::from_millis(CLOSE_FORCE_ABORT_WAIT_MS)).await;
        }
        {
            let mut guard = runtime_for_loop.lock().await;
            guard.status = ProxyStatus::Stopped;
            guard.active_connections = 0;
        }
        emit_proxy_update(&on_event_for_loop, &runtime_for_loop).await;
    });

    Ok(ProxyHandle {
        runtime,
        stop: stop_tx,
    })
}

async fn on_conn_open(
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
    conn: &ConnectionLogContext,
) {
    {
        let mut guard = runtime.lock().await;
        guard.active_connections = guard.active_connections.saturating_add(1);
        log_event!(
            LogLevel::Debug,
            "proxy.connection.opened",
            conn.proxy.operation_id.as_deref(),
            json!({
                "proxyId": guard.proxy_id,
                "connectionId": conn.connection_id,
                "protocol": conn.proxy.protocol,
                "bindHost": conn.proxy.bind_host,
                "bindPort": conn.proxy.bind_port,
                "peerAddr": conn.peer_addr,
                "activeConnections": guard.active_connections,
            }),
        );
    }
    emit_proxy_update(on_event, runtime).await;
}

async fn on_conn_close(
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
    conn: &ConnectionLogContext,
) {
    {
        let mut guard = runtime.lock().await;
        guard.active_connections = guard.active_connections.saturating_sub(1);
        log_event!(
            LogLevel::Debug,
            "proxy.connection.closed",
            conn.proxy.operation_id.as_deref(),
            json!({
                "proxyId": guard.proxy_id,
                "connectionId": conn.connection_id,
                "protocol": conn.proxy.protocol,
                "bindHost": conn.proxy.bind_host,
                "bindPort": conn.proxy.bind_port,
                "peerAddr": conn.peer_addr,
                "activeConnections": guard.active_connections,
            }),
        );
    }
    emit_proxy_update(on_event, runtime).await;
}

async fn add_traffic(
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
    bytes_out: u64,
    bytes_in: u64,
) {
    {
        let mut guard = runtime.lock().await;
        guard.bytes_out = guard.bytes_out.saturating_add(bytes_out);
        guard.bytes_in = guard.bytes_in.saturating_add(bytes_in);
    }
    emit_proxy_update(on_event, runtime).await;
}

async fn emit_proxy_update(on_event: &EventCallback, runtime: &Arc<Mutex<ProxyRuntime>>) {
    on_event(EngineEvent::ProxyUpdate(runtime.lock().await.clone()));
}

/// 成功建立新连接后清理历史错误，避免旧错误在 UI 中滞留。
async fn clear_last_error_if_any(runtime: &Arc<Mutex<ProxyRuntime>>, on_event: &EventCallback) {
    let cleared = {
        let mut guard = runtime.lock().await;
        if guard.last_error.is_some() {
            guard.last_error = None;
            true
        } else {
            false
        }
    };
    if cleared {
        emit_proxy_update(on_event, runtime).await;
    }
}

async fn reap_finished_tasks(tasks: &Arc<Mutex<HashMap<String, JoinHandle<()>>>>) {
    let finished_ids = {
        let guard = tasks.lock().await;
        guard
            .iter()
            .filter_map(|(id, handle)| {
                if handle.is_finished() {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
    };
    if finished_ids.is_empty() {
        return;
    }
    let mut handles = Vec::with_capacity(finished_ids.len());
    {
        let mut guard = tasks.lock().await;
        finished_ids.into_iter().for_each(|id| {
            if let Some(handle) = guard.remove(&id) {
                handles.push(handle);
            }
        });
    }
    for handle in handles {
        let _ = handle.await;
    }
}

async fn handle_client(
    stream: TcpStream,
    spec: &ProxySpec,
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
    conn: &ConnectionLogContext,
) -> Result<(u64, u64), EngineError> {
    match spec.protocol {
        ProxyProtocol::Socks5 => {
            handle_socks5_client(stream, spec.auth.as_ref(), runtime, on_event, conn).await
        }
        ProxyProtocol::Http => {
            handle_http_client(stream, spec.auth.as_ref(), runtime, on_event, conn).await
        }
    }
}

async fn handle_socks5_client(
    stream: TcpStream,
    auth: Option<&ProxyAuth>,
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
    conn: &ConnectionLogContext,
) -> Result<(u64, u64), EngineError> {
    log_event!(
        LogLevel::Debug,
        "proxy.handshake.started",
        conn.proxy.operation_id.as_deref(),
        json!({
            "proxyId": conn.proxy.proxy_id,
            "connectionId": conn.connection_id,
            "protocol": conn.proxy.protocol,
            "bindHost": conn.proxy.bind_host,
            "bindPort": conn.proxy.bind_port,
            "peerAddr": conn.peer_addr,
            "handshakeProtocol": "socks5",
        }),
    );
    let handshake = timeout(
        Duration::from_secs(HANDSHAKE_TIMEOUT_SEC),
        handle_socks5_handshake(stream, auth),
    )
    .await
    .map_err(|_| EngineError::new(PROXY_HANDSHAKE_TIMEOUT, "SOCKS5 handshake timed out"))?;
    let handshake = match handshake {
        Ok(result) => {
            log_event!(
                LogLevel::Debug,
                "proxy.handshake.succeeded",
                conn.proxy.operation_id.as_deref(),
                json!({
                    "proxyId": conn.proxy.proxy_id,
                    "connectionId": conn.connection_id,
                    "handshakeProtocol": "socks5",
                }),
            );
            result
        }
        Err(err) => {
            log_event!(
                LogLevel::Debug,
                "proxy.handshake.failed",
                conn.proxy.operation_id.as_deref(),
                json!({
                    "proxyId": conn.proxy.proxy_id,
                    "connectionId": conn.connection_id,
                    "handshakeProtocol": "socks5",
                    "error": {
                        "code": err.code.clone(),
                        "message": "Proxy handshake failed",
                        "detail": err.detail.clone().unwrap_or(err.message.clone()),
                    }
                }),
            );
            return Err(err);
        }
    };
    clear_last_error_if_any(runtime, on_event).await;
    relay_with_timeouts(handshake.client, handshake.upstream, runtime, on_event)
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_TRANSFER_FAILED,
                "Proxy forwarding failed",
                err.to_string(),
            )
        })
}

struct Socks5HandshakeResult {
    client: TcpStream,
    upstream: TcpStream,
}

async fn handle_socks5_handshake(
    mut stream: TcpStream,
    auth: Option<&ProxyAuth>,
) -> Result<Socks5HandshakeResult, EngineError> {
    let mut greeting = [0u8; 2];
    read_exact_with_timeout(
        &mut stream,
        &mut greeting,
        PROXY_SOCKS5_HANDSHAKE_FAILED,
        "SOCKS5 handshake failed",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_SOCKS5_HANDSHAKE_FAILED,
            "SOCKS5 handshake failed",
            err.to_string(),
        )
    })?;
    if greeting[0] != 0x05 {
        return Err(EngineError::new(
            PROXY_SOCKS5_HANDSHAKE_FAILED,
            "Only SOCKS5 proxies are supported",
        ));
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    read_exact_with_timeout(
        &mut stream,
        &mut methods,
        PROXY_SOCKS5_HANDSHAKE_FAILED,
        "SOCKS5 handshake failed",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_SOCKS5_HANDSHAKE_FAILED,
            "SOCKS5 handshake failed",
            err.to_string(),
        )
    })?;

    if let Some(auth) = auth {
        if !methods.contains(&0x02) {
            let _ = stream.write_all(&[0x05, 0xFF]).await;
            return Err(EngineError::new(
                PROXY_AUTH_REQUIRED,
                "The SOCKS5 client does not support username/password authentication",
            ));
        }
        write_all_with_timeout(
            &mut stream,
            &[0x05, 0x02],
            PROXY_SOCKS5_HANDSHAKE_FAILED,
            "SOCKS5 handshake failed",
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_SOCKS5_HANDSHAKE_FAILED,
                "SOCKS5 handshake failed",
                err.to_string(),
            )
        })?;
        validate_socks5_username_password(&mut stream, auth).await?;
    } else {
        if !methods.contains(&0x00) {
            let _ = stream.write_all(&[0x05, 0xFF]).await;
            return Err(EngineError::new(
                PROXY_SOCKS5_HANDSHAKE_FAILED,
                "The SOCKS5 client does not support unauthenticated mode",
            ));
        }
        write_all_with_timeout(
            &mut stream,
            &[0x05, 0x00],
            PROXY_SOCKS5_HANDSHAKE_FAILED,
            "SOCKS5 handshake failed",
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_SOCKS5_HANDSHAKE_FAILED,
                "SOCKS5 handshake failed",
                err.to_string(),
            )
        })?;
    }

    let mut req_head = [0u8; 4];
    read_exact_with_timeout(
        &mut stream,
        &mut req_head,
        PROXY_SOCKS5_REQUEST_FAILED,
        "Failed to read the SOCKS5 request",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_SOCKS5_REQUEST_FAILED,
            "Failed to read the SOCKS5 request",
            err.to_string(),
        )
    })?;
    if req_head[0] != 0x05 {
        return Err(EngineError::new(
            PROXY_SOCKS5_REQUEST_FAILED,
            "Invalid SOCKS5 request version",
        ));
    }
    if req_head[1] != 0x01 {
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err(EngineError::new(
            PROXY_SOCKS5_REQUEST_FAILED,
            "Only the CONNECT command is supported",
        ));
    }
    let target_host = match req_head[3] {
        0x01 => {
            let mut ipv4 = [0u8; 4];
            read_exact_with_timeout(
                &mut stream,
                &mut ipv4,
                PROXY_SOCKS5_REQUEST_FAILED,
                "Failed to read the target address",
            )
            .await
            .map_err(|err| {
                EngineError::with_detail(
                    PROXY_SOCKS5_REQUEST_FAILED,
                    "Failed to read the target address",
                    err.to_string(),
                )
            })?;
            format!("{}.{}.{}.{}", ipv4[0], ipv4[1], ipv4[2], ipv4[3])
        }
        0x03 => {
            let mut len_buf = [0u8; 1];
            read_exact_with_timeout(
                &mut stream,
                &mut len_buf,
                PROXY_SOCKS5_REQUEST_FAILED,
                "Failed to read the target domain",
            )
            .await
            .map_err(|err| {
                EngineError::with_detail(
                    PROXY_SOCKS5_REQUEST_FAILED,
                    "Failed to read the target domain",
                    err.to_string(),
                )
            })?;
            let len = len_buf[0] as usize;
            let mut domain = vec![0u8; len];
            read_exact_with_timeout(
                &mut stream,
                &mut domain,
                PROXY_SOCKS5_REQUEST_FAILED,
                "Failed to read the target domain",
            )
            .await
            .map_err(|err| {
                EngineError::with_detail(
                    PROXY_SOCKS5_REQUEST_FAILED,
                    "Failed to read the target domain",
                    err.to_string(),
                )
            })?;
            String::from_utf8(domain).map_err(|err| {
                EngineError::with_detail(
                    PROXY_SOCKS5_REQUEST_FAILED,
                    "The target domain is not valid UTF-8",
                    err.to_string(),
                )
            })?
        }
        0x04 => {
            let mut ipv6 = [0u8; 16];
            read_exact_with_timeout(
                &mut stream,
                &mut ipv6,
                PROXY_SOCKS5_REQUEST_FAILED,
                "Failed to read the target address",
            )
            .await
            .map_err(|err| {
                EngineError::with_detail(
                    PROXY_SOCKS5_REQUEST_FAILED,
                    "Failed to read the target address",
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
                PROXY_SOCKS5_REQUEST_FAILED,
                "Unsupported target address type",
            ));
        }
    };
    let mut port_buf = [0u8; 2];
    read_exact_with_timeout(
        &mut stream,
        &mut port_buf,
        PROXY_SOCKS5_REQUEST_FAILED,
        "Failed to read the target port",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_SOCKS5_REQUEST_FAILED,
            "Failed to read the target port",
            err.to_string(),
        )
    })?;
    let target_port = u16::from_be_bytes(port_buf);
    let target = format!("{target_host}:{target_port}");
    let upstream = connect_with_timeout(&target).await.map_err(|err| {
        EngineError::with_detail(
            PROXY_UPSTREAM_CONNECT_FAILED,
            "Failed to connect to the upstream server",
            err.to_string(),
        )
    })?;
    write_all_with_timeout(
        &mut stream,
        &[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0],
        PROXY_SOCKS5_REQUEST_FAILED,
        "Failed to send the response",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_SOCKS5_REQUEST_FAILED,
            "Failed to send the response",
            err.to_string(),
        )
    })?;
    Ok(Socks5HandshakeResult {
        client: stream,
        upstream,
    })
}

async fn validate_socks5_username_password(
    stream: &mut TcpStream,
    expected: &ProxyAuth,
) -> Result<(), EngineError> {
    let mut ver = [0u8; 1];
    read_exact_with_timeout(
        stream,
        &mut ver,
        PROXY_AUTH_FAILED,
        "SOCKS5 authentication failed",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_AUTH_FAILED,
            "SOCKS5 authentication failed",
            err.to_string(),
        )
    })?;
    if ver[0] != 0x01 {
        let _ = stream.write_all(&[0x01, 0x01]).await;
        return Err(EngineError::new(
            PROXY_AUTH_FAILED,
            "Invalid SOCKS5 authentication version",
        ));
    }
    let mut ulen = [0u8; 1];
    read_exact_with_timeout(
        stream,
        &mut ulen,
        PROXY_AUTH_FAILED,
        "SOCKS5 authentication failed",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_AUTH_FAILED,
            "SOCKS5 authentication failed",
            err.to_string(),
        )
    })?;
    let mut user = vec![0u8; ulen[0] as usize];
    read_exact_with_timeout(
        stream,
        &mut user,
        PROXY_AUTH_FAILED,
        "SOCKS5 authentication failed",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_AUTH_FAILED,
            "SOCKS5 authentication failed",
            err.to_string(),
        )
    })?;
    let mut plen = [0u8; 1];
    read_exact_with_timeout(
        stream,
        &mut plen,
        PROXY_AUTH_FAILED,
        "SOCKS5 authentication failed",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_AUTH_FAILED,
            "SOCKS5 authentication failed",
            err.to_string(),
        )
    })?;
    let mut pass = vec![0u8; plen[0] as usize];
    read_exact_with_timeout(
        stream,
        &mut pass,
        PROXY_AUTH_FAILED,
        "SOCKS5 authentication failed",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_AUTH_FAILED,
            "SOCKS5 authentication failed",
            err.to_string(),
        )
    })?;
    let username = String::from_utf8(user).map_err(|err| {
        EngineError::with_detail(
            PROXY_AUTH_FAILED,
            "Invalid SOCKS5 authentication username",
            err.to_string(),
        )
    })?;
    let password = String::from_utf8(pass).map_err(|err| {
        EngineError::with_detail(
            PROXY_AUTH_FAILED,
            "Invalid SOCKS5 authentication password",
            err.to_string(),
        )
    })?;

    if username == expected.username && password == expected.password {
        write_all_with_timeout(
            stream,
            &[0x01, 0x00],
            PROXY_AUTH_FAILED,
            "SOCKS5 authentication failed",
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_AUTH_FAILED,
                "SOCKS5 authentication failed",
                err.to_string(),
            )
        })?;
        return Ok(());
    }

    let _ = stream.write_all(&[0x01, 0x01]).await;
    Err(EngineError::new(
        PROXY_AUTH_FAILED,
        "Invalid SOCKS5 username or password",
    ))
}

async fn handle_http_client(
    client: TcpStream,
    auth: Option<&ProxyAuth>,
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
    conn: &ConnectionLogContext,
) -> Result<(u64, u64), EngineError> {
    log_event!(
        LogLevel::Debug,
        "proxy.handshake.started",
        conn.proxy.operation_id.as_deref(),
        json!({
            "proxyId": conn.proxy.proxy_id,
            "connectionId": conn.connection_id,
            "protocol": conn.proxy.protocol,
            "bindHost": conn.proxy.bind_host,
            "bindPort": conn.proxy.bind_port,
            "peerAddr": conn.peer_addr,
            "handshakeProtocol": "http",
        }),
    );
    let handshake = timeout(
        Duration::from_secs(HANDSHAKE_TIMEOUT_SEC),
        handle_http_handshake(client, auth),
    )
    .await
    .map_err(|_| EngineError::new(PROXY_HANDSHAKE_TIMEOUT, "HTTP proxy handshake timed out"))?;
    let handshake = match handshake {
        Ok(result) => {
            log_event!(
                LogLevel::Debug,
                "proxy.handshake.succeeded",
                conn.proxy.operation_id.as_deref(),
                json!({
                    "proxyId": conn.proxy.proxy_id,
                    "connectionId": conn.connection_id,
                    "handshakeProtocol": "http",
                }),
            );
            result
        }
        Err(err) => {
            log_event!(
                LogLevel::Debug,
                "proxy.handshake.failed",
                conn.proxy.operation_id.as_deref(),
                json!({
                    "proxyId": conn.proxy.proxy_id,
                    "connectionId": conn.connection_id,
                    "handshakeProtocol": "http",
                    "error": {
                        "code": err.code.clone(),
                        "message": "Proxy handshake failed",
                        "detail": err.detail.clone().unwrap_or(err.message.clone()),
                    }
                }),
            );
            return Err(err);
        }
    };
    clear_last_error_if_any(runtime, on_event).await;
    if handshake.initial_bytes_out > 0 {
        add_traffic(runtime, on_event, handshake.initial_bytes_out, 0).await;
    }
    let (body_out, body_in) =
        relay_with_timeouts(handshake.client, handshake.upstream, runtime, on_event)
            .await
            .map_err(|err| {
                EngineError::with_detail(
                    PROXY_TRANSFER_FAILED,
                    "Proxy forwarding failed",
                    err.to_string(),
                )
            })?;
    Ok((handshake.initial_bytes_out + body_out, body_in))
}

struct HttpHandshakeResult {
    client: TcpStream,
    upstream: TcpStream,
    initial_bytes_out: u64,
}

async fn handle_http_handshake(
    mut client: TcpStream,
    auth: Option<&ProxyAuth>,
) -> Result<HttpHandshakeResult, EngineError> {
    let (header_bytes, buffered_body) = read_http_headers(&mut client).await?;
    let req_text = String::from_utf8_lossy(&header_bytes).to_string();
    let parsed = parse_http_request_head(&req_text)?;

    if let Some(expected) = auth
        && !check_http_basic_auth(parsed.proxy_authorization.as_deref(), expected)
    {
        write_all_with_timeout(
            &mut client,
            b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"FluxTerm Proxy\"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            PROXY_AUTH_FAILED,
            "Failed to send the authentication failure response",
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(PROXY_AUTH_FAILED, "Failed to send the authentication failure response", err.to_string())
        })?;
        let target_hint = parsed
            .host_header
            .clone()
            .unwrap_or_else(|| parsed.target.clone());
        return Err(EngineError::with_detail(
            PROXY_AUTH_FAILED,
            "HTTP proxy authentication failed",
            format!("target={target_hint}"),
        ));
    }

    if parsed.method.eq_ignore_ascii_case("CONNECT") {
        let (target_host, target_port) = parse_connect_target(&parsed.target)?;
        let mut upstream = connect_with_timeout(&format!("{target_host}:{target_port}"))
            .await
            .map_err(|err| {
                EngineError::with_detail(
                    PROXY_UPSTREAM_CONNECT_FAILED,
                    "Failed to connect to the upstream server",
                    err.to_string(),
                )
            })?;
        write_all_with_timeout(
            &mut client,
            b"HTTP/1.1 200 Connection Established\r\n\r\n",
            PROXY_HTTP_HANDSHAKE_FAILED,
            "Failed to send the CONNECT response",
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_HTTP_HANDSHAKE_FAILED,
                "Failed to send the CONNECT response",
                err.to_string(),
            )
        })?;
        if !buffered_body.is_empty() {
            write_all_with_timeout(
                &mut upstream,
                &buffered_body,
                PROXY_HTTP_FORWARD_FAILED,
                "Failed to send the request body",
            )
            .await
            .map_err(|err| {
                EngineError::with_detail(
                    PROXY_HTTP_FORWARD_FAILED,
                    "Failed to send the request body",
                    err.to_string(),
                )
            })?;
        }
        return Ok(HttpHandshakeResult {
            client,
            upstream,
            initial_bytes_out: buffered_body.len() as u64,
        });
    }

    let target = resolve_http_target(&parsed)?;
    let mut forwarded = format!("{} {} {}\r\n", parsed.method, target.path, parsed.version);
    let mut has_host_header = false;
    for (name, value) in &parsed.headers {
        let lower = name.to_ascii_lowercase();
        if lower == "proxy-authorization" || lower == "proxy-connection" {
            continue;
        }
        if lower == "host" {
            has_host_header = true;
        }
        forwarded.push_str(name);
        forwarded.push_str(": ");
        forwarded.push_str(value);
        forwarded.push_str("\r\n");
    }
    if !has_host_header {
        forwarded.push_str("Host: ");
        forwarded.push_str(&target.host);
        if target.port != 80 {
            forwarded.push(':');
            forwarded.push_str(&target.port.to_string());
        }
        forwarded.push_str("\r\n");
    }
    forwarded.push_str("\r\n");

    let mut upstream = connect_with_timeout(&format!("{}:{}", target.host, target.port))
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_UPSTREAM_CONNECT_FAILED,
                "Failed to connect to the upstream server",
                err.to_string(),
            )
        })?;
    write_all_with_timeout(
        &mut upstream,
        forwarded.as_bytes(),
        PROXY_HTTP_FORWARD_FAILED,
        "Failed to send the upstream request",
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_HTTP_FORWARD_FAILED,
            "Failed to send the upstream request",
            err.to_string(),
        )
    })?;
    if !buffered_body.is_empty() {
        write_all_with_timeout(
            &mut upstream,
            &buffered_body,
            PROXY_HTTP_FORWARD_FAILED,
            "Failed to send the request body",
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_HTTP_FORWARD_FAILED,
                "Failed to send the request body",
                err.to_string(),
            )
        })?;
    }
    Ok(HttpHandshakeResult {
        client,
        upstream,
        initial_bytes_out: forwarded.len() as u64 + buffered_body.len() as u64,
    })
}

async fn read_http_headers(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), EngineError> {
    const MAX_HEADER: usize = 64 * 1024;
    let mut buf = Vec::with_capacity(2048);
    loop {
        let mut chunk = [0u8; 1024];
        let n = read_with_timeout(
            stream,
            &mut chunk,
            PROXY_HTTP_PARSE_FAILED,
            "Failed to read the HTTP request",
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                PROXY_HTTP_PARSE_FAILED,
                "Failed to read the HTTP request",
                err.to_string(),
            )
        })?;
        if n == 0 {
            return Err(EngineError::new(
                PROXY_HTTP_PARSE_FAILED,
                "The HTTP request ended unexpectedly",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(index) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head_end = index + 4;
            let headers = buf[..head_end].to_vec();
            let rest = buf[head_end..].to_vec();
            return Ok((headers, rest));
        }
        if buf.len() > MAX_HEADER {
            return Err(EngineError::new(
                PROXY_HTTP_PARSE_FAILED,
                "The HTTP request headers are too large",
            ));
        }
    }
}

async fn connect_with_timeout(target: &str) -> Result<TcpStream, EngineError> {
    timeout(
        Duration::from_secs(HANDSHAKE_TIMEOUT_SEC),
        TcpStream::connect(target),
    )
    .await
    .map_err(|_| EngineError::new(PROXY_HANDSHAKE_TIMEOUT, "Upstream connection timed out"))?
    .map_err(|err| {
        EngineError::with_detail(
            PROXY_UPSTREAM_CONNECT_FAILED,
            "Failed to connect to the upstream server",
            err.to_string(),
        )
    })
}

async fn read_exact_with_timeout(
    stream: &mut TcpStream,
    buf: &mut [u8],
    code: &str,
    message: &str,
) -> Result<(), EngineError> {
    timeout(
        Duration::from_secs(READ_TIMEOUT_SEC),
        stream.read_exact(buf),
    )
    .await
    .map_err(|_| EngineError::new(PROXY_IO_READ_TIMEOUT, "Read operation timed out"))?
    .map(|_| ())
    .map_err(|err| EngineError::with_detail(code, message, err.to_string()))
}

async fn read_with_timeout(
    stream: &mut TcpStream,
    buf: &mut [u8],
    code: &str,
    message: &str,
) -> Result<usize, EngineError> {
    timeout(Duration::from_secs(READ_TIMEOUT_SEC), stream.read(buf))
        .await
        .map_err(|_| EngineError::new(PROXY_IO_READ_TIMEOUT, "Read operation timed out"))?
        .map_err(|err| EngineError::with_detail(code, message, err.to_string()))
}

async fn write_all_with_timeout(
    stream: &mut TcpStream,
    buf: &[u8],
    code: &str,
    message: &str,
) -> Result<(), EngineError> {
    timeout(
        Duration::from_secs(WRITE_TIMEOUT_SEC),
        stream.write_all(buf),
    )
    .await
    .map_err(|_| EngineError::new(PROXY_IO_WRITE_TIMEOUT, "Write operation timed out"))?
    .map_err(|err| EngineError::with_detail(code, message, err.to_string()))
}

#[derive(Copy, Clone)]
enum TrafficDirection {
    Out,
    In,
}

async fn relay_with_timeouts(
    left: TcpStream,
    right: TcpStream,
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
) -> Result<(u64, u64), EngineError> {
    let (left_read, left_write) = left.into_split();
    let (right_read, right_write) = right.into_split();
    let runtime_for_out = Arc::clone(runtime);
    let runtime_for_in = Arc::clone(runtime);
    let on_event_for_out = Arc::clone(on_event);
    let on_event_for_in = Arc::clone(on_event);
    let mut left_to_right = tokio::spawn(async move {
        relay_one_way_with_timeout(
            left_read,
            right_write,
            &runtime_for_out,
            &on_event_for_out,
            TrafficDirection::Out,
        )
        .await
    });
    let mut right_to_left = tokio::spawn(async move {
        relay_one_way_with_timeout(
            right_read,
            left_write,
            &runtime_for_in,
            &on_event_for_in,
            TrafficDirection::In,
        )
        .await
    });
    tokio::select! {
        left_res = &mut left_to_right => {
            let bytes_out = match unwrap_relay_result(left_res) {
                Ok(bytes) => bytes,
                Err(err) => {
                    right_to_left.abort();
                    let _ = right_to_left.await;
                    return Err(err);
                }
            };
            let bytes_in = match right_to_left.await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(err)) => return Err(err),
                Err(err) => {
                    return Err(EngineError::with_detail(PROXY_TRANSFER_FAILED, "The proxy forwarding task failed", err.to_string()));
                }
            };
            Ok((bytes_out, bytes_in))
        }
        right_res = &mut right_to_left => {
            let bytes_in = match unwrap_relay_result(right_res) {
                Ok(bytes) => bytes,
                Err(err) => {
                    left_to_right.abort();
                    let _ = left_to_right.await;
                    return Err(err);
                }
            };
            let bytes_out = match left_to_right.await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(err)) => return Err(err),
                Err(err) => {
                    return Err(EngineError::with_detail(PROXY_TRANSFER_FAILED, "The proxy forwarding task failed", err.to_string()));
                }
            };
            Ok((bytes_out, bytes_in))
        }
    }
}

fn unwrap_relay_result(
    result: Result<Result<u64, EngineError>, JoinError>,
) -> Result<u64, EngineError> {
    match result {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(err)) => Err(err),
        Err(err) => Err(EngineError::with_detail(
            PROXY_TRANSFER_FAILED,
            "The proxy forwarding task failed",
            err.to_string(),
        )),
    }
}

async fn relay_one_way_with_timeout<R, W>(
    mut reader: R,
    mut writer: W,
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
    direction: TrafficDirection,
) -> Result<u64, EngineError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut total = 0u64;
    let mut pending = 0u64;
    let mut last_emit = Instant::now();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let read_result = timeout(
            Duration::from_secs(READ_TIMEOUT_SEC),
            reader.read(&mut buffer),
        )
        .await;
        let read = match read_result {
            Ok(Ok(read)) => read,
            Ok(Err(err)) => {
                flush_pending_traffic(runtime, on_event, direction, pending).await;
                return Err(EngineError::with_detail(
                    PROXY_TRANSFER_FAILED,
                    "Failed to read proxy data",
                    err.to_string(),
                ));
            }
            Err(_) => {
                flush_pending_traffic(runtime, on_event, direction, pending).await;
                return Err(EngineError::new(
                    PROXY_IO_READ_TIMEOUT,
                    "Read operation timed out",
                ));
            }
        };
        if read == 0 {
            flush_pending_traffic(runtime, on_event, direction, pending).await;
            return Ok(total);
        }
        let write_result = timeout(
            Duration::from_secs(WRITE_TIMEOUT_SEC),
            writer.write_all(&buffer[..read]),
        )
        .await;
        match write_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                flush_pending_traffic(runtime, on_event, direction, pending).await;
                return Err(EngineError::with_detail(
                    PROXY_TRANSFER_FAILED,
                    "Failed to write proxy data",
                    err.to_string(),
                ));
            }
            Err(_) => {
                flush_pending_traffic(runtime, on_event, direction, pending).await;
                return Err(EngineError::new(
                    PROXY_IO_WRITE_TIMEOUT,
                    "Write operation timed out",
                ));
            }
        }
        let delta = read as u64;
        total = total.saturating_add(delta);
        pending = pending.saturating_add(delta);
        if pending > 0 && last_emit.elapsed() >= Duration::from_millis(TRAFFIC_UPDATE_INTERVAL_MS) {
            match direction {
                TrafficDirection::Out => add_traffic(runtime, on_event, pending, 0).await,
                TrafficDirection::In => add_traffic(runtime, on_event, 0, pending).await,
            }
            pending = 0;
            last_emit = Instant::now();
        }
    }
}

async fn flush_pending_traffic(
    runtime: &Arc<Mutex<ProxyRuntime>>,
    on_event: &EventCallback,
    direction: TrafficDirection,
    pending: u64,
) {
    if pending == 0 {
        return;
    }
    match direction {
        TrafficDirection::Out => add_traffic(runtime, on_event, pending, 0).await,
        TrafficDirection::In => add_traffic(runtime, on_event, 0, pending).await,
    }
}

#[derive(Debug, Clone)]
struct ParsedHttpRequestHead {
    method: String,
    target: String,
    version: String,
    headers: Vec<(String, String)>,
    proxy_authorization: Option<String>,
    host_header: Option<String>,
}

fn parse_http_request_head(raw: &str) -> Result<ParsedHttpRequestHead, EngineError> {
    let mut lines = raw.split("\r\n");
    let req_line = lines
        .next()
        .ok_or_else(|| EngineError::new(PROXY_HTTP_PARSE_FAILED, "Missing HTTP request line"))?;
    let mut parts = req_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| EngineError::new(PROXY_HTTP_PARSE_FAILED, "Missing HTTP request method"))?
        .to_string();
    let target = parts
        .next()
        .ok_or_else(|| EngineError::new(PROXY_HTTP_PARSE_FAILED, "Missing HTTP request target"))?
        .to_string();
    let version = parts
        .next()
        .ok_or_else(|| EngineError::new(PROXY_HTTP_PARSE_FAILED, "Missing HTTP version"))?
        .to_string();

    let mut headers = Vec::new();
    let mut proxy_authorization = None;
    let mut host_header = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_string();
        if name.eq_ignore_ascii_case("Proxy-Authorization") {
            proxy_authorization = Some(value.clone());
        }
        if name.eq_ignore_ascii_case("Host") {
            host_header = Some(value.clone());
        }
        headers.push((name.to_string(), value));
    }

    Ok(ParsedHttpRequestHead {
        method,
        target,
        version,
        headers,
        proxy_authorization,
        host_header,
    })
}

fn check_http_basic_auth(auth_header: Option<&str>, expected: &ProxyAuth) -> bool {
    let Some(raw) = auth_header else {
        return false;
    };
    let Some(encoded) = raw
        .split_once(' ')
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("basic"))
        .map(|(_, v)| v.trim())
    else {
        return false;
    };
    let expected_token =
        BASE64_STANDARD.encode(format!("{}:{}", expected.username, expected.password));
    encoded == expected_token
}

fn parse_connect_target(target: &str) -> Result<(String, u16), EngineError> {
    let Some((host, port_raw)) = target.rsplit_once(':') else {
        return Err(EngineError::new(
            PROXY_HTTP_PARSE_FAILED,
            "Invalid CONNECT target format",
        ));
    };
    let port = port_raw
        .parse::<u16>()
        .map_err(|_| EngineError::new(PROXY_HTTP_PARSE_FAILED, "Invalid CONNECT target port"))?;
    if host.is_empty() {
        return Err(EngineError::new(
            PROXY_HTTP_PARSE_FAILED,
            "CONNECT target host is empty",
        ));
    }
    Ok((host.to_string(), port))
}

struct HttpTarget {
    host: String,
    port: u16,
    path: String,
}

fn resolve_http_target(req: &ParsedHttpRequestHead) -> Result<HttpTarget, EngineError> {
    if req.target.starts_with("http://") {
        return parse_absolute_http_target(&req.target);
    }
    let host_value = req.host_header.as_ref().ok_or_else(|| {
        EngineError::new(
            PROXY_HTTP_PARSE_FAILED,
            "Missing Host header; unable to determine the upstream address",
        )
    })?;
    let (host, port) = parse_host_port(host_value, 80)?;
    Ok(HttpTarget {
        host,
        port,
        path: req.target.clone(),
    })
}

fn parse_absolute_http_target(target: &str) -> Result<HttpTarget, EngineError> {
    let rest = target.strip_prefix("http://").ok_or_else(|| {
        EngineError::new(
            PROXY_HTTP_PARSE_FAILED,
            "Only absolute HTTP URLs are supported",
        )
    })?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let (host, port) = parse_host_port(authority, 80)?;
    Ok(HttpTarget {
        host,
        port,
        path: path.to_string(),
    })
}

fn parse_host_port(input: &str, default_port: u16) -> Result<(String, u16), EngineError> {
    let authority = input.rsplit('@').next().unwrap_or(input);
    if authority.starts_with('[') {
        let end = authority.find(']').ok_or_else(|| {
            EngineError::new(PROXY_HTTP_PARSE_FAILED, "Invalid IPv6 address format")
        })?;
        let host = authority[..=end].to_string();
        let remain = &authority[end + 1..];
        if let Some(port_str) = remain.strip_prefix(':') {
            let port = port_str
                .parse::<u16>()
                .map_err(|_| EngineError::new(PROXY_HTTP_PARSE_FAILED, "Invalid port format"))?;
            return Ok((host, port));
        }
        return Ok((host, default_port));
    }

    if let Some((host, port_str)) = authority.rsplit_once(':')
        && !host.contains(':')
        && !port_str.is_empty()
    {
        let port = port_str
            .parse::<u16>()
            .map_err(|_| EngineError::new(PROXY_HTTP_PARSE_FAILED, "Invalid port format"))?;
        return Ok((host.to_string(), port));
    }

    Ok((authority.to_string(), default_port))
}

/// 读取全部代理运行时快照。
pub async fn list_proxy_runtimes(handles: &HashMap<String, ProxyHandle>) -> Vec<ProxyRuntime> {
    let mut list = Vec::with_capacity(handles.len());
    for handle in handles.values() {
        list.push(handle.snapshot().await);
    }
    list
}

/// 关闭全部代理实例。
pub async fn close_all_proxies(handles: HashMap<String, ProxyHandle>) {
    for handle in handles.values() {
        handle.close();
    }
}

/// 关闭单个代理实例。
pub fn close_proxy(handle: &ProxyHandle) {
    handle.close();
}
