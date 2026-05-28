//! # Bridge
//!
//! `bridge` 模块实现了一个本地 WebSocket 服务器，用于在 Rust RDP 运行时和前端 WebGL 渲染器之间建立高性能数据通道。
//!
//! 设计要点：
//! 1. 安全令牌：每个会话连接必须携带启动时生成的 UUID 令牌。
//! 2. 广播机制：利用 `tokio::sync::broadcast` 将 RDP 画面帧同时推送到所有已连接的桥接客户端。
//! 3. 自动扩缩容：通过 `axum` 提供轻量级的 HTTP/WS 路由。

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::Router;
use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

use crate::protocol::RuntimeSessionSnapshot;
use crate::session_manager::{SessionManager, json_message};
use crate::telemetry::{TelemetryLevel, log_telemetry};
use crate::{RuntimeError, RuntimeResult};

/// 内部应用状态。
#[derive(Debug, Clone)]
struct AppState {
    /// 全局访问令牌，用于 WS 连接认证。
    token: String,
    /// 会话管理器引用。
    sessions: SessionManager,
}

/// WebSocket 连接查询参数。
#[derive(Debug, Clone, serde::Deserialize)]
struct BridgeQuery {
    /// 必须匹配 `AppState.token`。
    token: String,
}

/// 描述已启动的 Bridge 服务的信息。
#[derive(Debug, Clone)]
pub struct BridgeServerInfo {
    /// 基础 WebSocket URL (如 `ws://127.0.0.1:12345`)。
    pub base_url: String,
    /// 用于当前服务实例的身份验证令牌。
    pub token: String,
}

/// 运行时 Bridge 服务器管理器。
#[derive(Debug, Clone, Default)]
pub struct BridgeServer {
    /// 持有单例服务器信息的互斥锁。
    inner: Arc<Mutex<Option<BridgeServerInfo>>>,
}

impl BridgeServer {
    /// 确保 Bridge 服务已在随机可用端口启动。
    ///
    /// 如果服务尚未启动，将初始化 `axum` 路由并启动后台监听任务。
    ///
    /// # 参数
    ///
    /// * `sessions` - 用于路由 WS 请求到对应会话的消息源。
    pub async fn ensure_ready(&self, sessions: SessionManager) -> RuntimeResult<BridgeServerInfo> {
        let mut inner = self.inner.lock().await;
        if let Some(info) = inner.clone() {
            return Ok(info);
        }

        let token = Uuid::new_v4().to_string();
        // 绑定到本地回环地址的随机端口
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .map_err(io_error)?;
        let addr = listener.local_addr().map_err(io_error)?;
        let state = Arc::new(AppState {
            token: token.clone(),
            sessions,
        });

        // 构建 API 路由
        let app = Router::new()
            .route("/healthz", get(handle_health))
            .route("/v1/bridge/{session_id}", get(handle_bridge_ws))
            .with_state(state);

        // 在后台启动服务器任务
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                log_telemetry(
                    TelemetryLevel::Error,
                    "rdp.bridge.server.failed",
                    json!({
                        "error": {
                            "code": "rdp_bridge_server_failed",
                            "message": error.to_string(),
                        },
                    }),
                );
            }
        });

        let info = BridgeServerInfo {
            base_url: format!("ws://{}", addr),
            token,
        };
        log_telemetry(
            TelemetryLevel::Info,
            "rdp.bridge.server.ready",
            json!({ "baseUrl": &info.base_url }),
        );
        *inner = Some(info.clone());
        Ok(info)
    }
}

/// 健康检查端点。
async fn handle_health() -> impl IntoResponse {
    "ok"
}

/// WebSocket 升级处理器。
///
/// 校验令牌并根据 `session_id` 订阅对应会话的消息流。
async fn handle_bridge_ws(
    Path(session_id): Path<String>,
    Query(query): Query<BridgeQuery>,
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if query.token != state.token {
        log_telemetry(
            TelemetryLevel::Warn,
            "rdp.bridge.auth.failed",
            json!({ "sessionId": session_id }),
        );
        return Err((
            StatusCode::UNAUTHORIZED,
            "RDP bridge token 不匹配".to_string(),
        ));
    }
    let (snapshot, rx) = match state.sessions.subscribe(&session_id) {
        Ok(result) => result,
        Err(error) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.bridge.subscribe.failed",
                json!({
                    "sessionId": session_id,
                    "error": {
                        "code": &error.code,
                        "message": &error.message,
                    },
                }),
            );
            return Err((StatusCode::NOT_FOUND, error.detail.unwrap_or(error.message)));
        }
    };
    if !can_attach_bridge(&snapshot, &query.token) {
        log_telemetry(
            TelemetryLevel::Warn,
            "rdp.bridge.attach.rejected",
            json!({
                "sessionId": &session_id,
                "state": &snapshot.state,
                "hasWsUrl": snapshot.ws_url.is_some(),
            }),
        );
        return Err((
            StatusCode::GONE,
            "RDP 会话桥接已失效，请重新发起连接".to_string(),
        ));
    }
    Ok(ws.on_upgrade(move |socket| run_bridge_socket(socket, snapshot, rx)))
}

/// 单个 WebSocket 连接的消息循环任务。
async fn run_bridge_socket(
    mut socket: WebSocket,
    snapshot: RuntimeSessionSnapshot,
    mut rx: broadcast::Receiver<axum::extract::ws::Message>,
) {
    log_telemetry(
        TelemetryLevel::Info,
        "rdp.bridge.open",
        json!({
            "sessionId": &snapshot.session_id,
            "state": &snapshot.state,
        }),
    );

    // 发送初始连接确认
    let _ = socket
        .send(json_message(
            "state",
            serde_json::json!({
                "state": snapshot.state,
                "message": format!("FluxTerm RDP bridge attached ({})", snapshot.state),
                "width": snapshot.width,
                "height": snapshot.height,
            }),
        ))
        .await;

    // 发送默认光标状态
    let _ = socket
        .send(json_message(
            "cursor",
            serde_json::json!({
                "cursor": "default",
            }),
        ))
        .await;

    loop {
        tokio::select! {
            // 从会话广播频道接收消息并推送到 WebSocket
            outbound = rx.recv() => {
                match outbound {
                    Ok(message) => {
                        if socket.send(message).await.is_err() {
                            log_telemetry(
                                TelemetryLevel::Warn,
                                "rdp.bridge.send.failed",
                                json!({ "sessionId": &snapshot.session_id }),
                            );
                            break;
                        }
                    }
                    Err(RecvError::Lagged(count)) => {
                        // 客户端消费太慢，跳过过期帧以维持实时性
                        log_telemetry(
                            TelemetryLevel::Warn,
                            "rdp.bridge.receiver.lagged",
                            json!({
                                "sessionId": &snapshot.session_id,
                                "lagged": count,
                            }),
                        );
                        continue;
                    }
                    Err(RecvError::Closed) => {
                        log_telemetry(
                            TelemetryLevel::Warn,
                            "rdp.bridge.channel.closed",
                            json!({ "sessionId": &snapshot.session_id }),
                        );
                        break;
                    }
                }
            }
            // 接收来自 WebSocket 的控制消息（目前主要用于链路监控）
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(axum::extract::ws::Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        log_telemetry(
                            TelemetryLevel::Warn,
                            "rdp.bridge.receive.failed",
                            json!({
                                "sessionId": &snapshot.session_id,
                                "error": {
                                    "code": "rdp_bridge_receive_failed",
                                    "message": error.to_string(),
                                },
                            }),
                        );
                        break;
                    }
                }
            }
        }
    }
    log_telemetry(
        TelemetryLevel::Info,
        "rdp.bridge.closed",
        json!({ "sessionId": &snapshot.session_id }),
    );
}

/// 判断桥接客户端是否仍允许附着到当前会话。
///
/// 约束：
/// 1. 会话必须仍处于可桥接状态，不能是 `idle` / `disconnected` / `error`。
/// 2. 会话快照中必须保留当前有效的 `ws_url`。
/// 3. 入站请求携带的 token 必须与快照中的桥接地址保持一致，避免旧地址复用。
fn can_attach_bridge(snapshot: &RuntimeSessionSnapshot, token: &str) -> bool {
    let Some(ws_url) = snapshot.ws_url.as_deref() else {
        return false;
    };

    if matches!(snapshot.state.as_str(), "disconnected" | "error" | "idle") {
        return false;
    }

    ws_url.contains(&format!("token={token}"))
}

fn io_error(err: std::io::Error) -> RuntimeError {
    RuntimeError::with_detail(
        "rdp_runtime_bridge_io_error",
        "RDP bridge 启动失败",
        err.to_string(),
    )
}
