//! # Bridge
//!
//! `bridge` 模块实现了一个本地 WebSocket 服务器，用于在 Rust RDP 运行时和前端 WebGL 渲染器之间建立高性能数据通道。
//!
//! 设计要点：
//! 1. 安全令牌：每个会话连接必须携带启动时生成的 UUID 令牌。
//! 2. 控制事件使用广播；图形由协议任务按连接独立发送并等待消费确认。
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
use tokio::sync::{Mutex, broadcast, mpsc};
use uuid::Uuid;

use crate::protocol::RuntimeSessionSnapshot;
use crate::session_manager::{RuntimeCommand, SessionManager, json_message};
use crate::{RuntimeError, RuntimeResult};
use fluxterm_logging::{LogLevel, log_event};

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
    token: Option<String>,
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
                log_event!(
                    LogLevel::Error,
                    "rdp.bridge.server.failed",
                    None,
                    json!({
                        "error": {
                            "code": "rdp_bridge_server_failed",
                            "message": "RDP bridge server failed",
                            "detail": error.to_string(),
                        },
                    }),
                );
            }
        });

        let info = BridgeServerInfo {
            base_url: format!("ws://{}", addr),
            token,
        };
        log_event!(LogLevel::Debug, "rdp.bridge.server.ready", None, json!({}),);
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
    log_event!(
        LogLevel::Debug,
        "rdp.bridge.request.received",
        None,
        json!({
            "sessionId": &session_id,
            "hasToken": query.token.is_some(),
        }),
    );

    let Some(token) = query.token.as_deref() else {
        log_event!(
            LogLevel::Warn,
            "rdp.bridge.auth.failed",
            None,
            json!({
                "sessionId": &session_id,
                "reason": "missing_token",
                "error": {
                    "code": "rdp_bridge_token_missing",
                    "message": "RDP bridge authentication failed",
                },
            }),
        );
        return Err((
            StatusCode::UNAUTHORIZED,
            "RDP bridge token mismatch".to_string(),
        ));
    };

    if token != state.token {
        log_event!(
            LogLevel::Warn,
            "rdp.bridge.auth.failed",
            None,
            json!({
                "sessionId": &session_id,
                "reason": "token_mismatch",
                "error": {
                    "code": "rdp_bridge_token_mismatch",
                    "message": "RDP bridge authentication failed",
                },
            }),
        );
        return Err((
            StatusCode::UNAUTHORIZED,
            "RDP bridge token mismatch".to_string(),
        ));
    }
    let (snapshot, rx) = match state.sessions.subscribe(&session_id) {
        Ok(result) => result,
        Err(error) => {
            log_event!(
                LogLevel::Warn,
                "rdp.bridge.subscribe.failed",
                None,
                json!({
                    "sessionId": &session_id,
                    "error": {
                        "code": &error.code,
                        "message": "RDP bridge subscription failed",
                        "detail": error.detail.clone().unwrap_or(error.message.clone()),
                    },
                }),
            );
            return Err((StatusCode::NOT_FOUND, error.detail.unwrap_or(error.message)));
        }
    };
    if !can_attach_bridge(&snapshot, token) {
        log_event!(
            LogLevel::Warn,
            "rdp.bridge.attach.rejected",
            None,
            json!({
                "sessionId": &session_id,
                "state": &snapshot.state,
                "hasWsUrl": snapshot.ws_url.is_some(),
                "width": snapshot.width,
                "height": snapshot.height,
                "error": {
                    "code": "rdp_bridge_attach_rejected",
                    "message": "RDP bridge attachment rejected",
                },
            }),
        );
        return Err((
            StatusCode::GONE,
            "The RDP session bridge is no longer valid; reconnect the session".to_string(),
        ));
    }
    log_event!(
        LogLevel::Debug,
        "rdp.bridge.upgrade.succeeded",
        None,
        json!({
            "sessionId": &session_id,
            "state": &snapshot.state,
            "hasWsUrl": snapshot.ws_url.is_some(),
            "width": snapshot.width,
            "height": snapshot.height,
        }),
    );
    Ok(
        ws.on_upgrade(move |socket| {
            run_bridge_socket(socket, snapshot, rx, state.sessions.clone())
        }),
    )
}

/// 前端完成纹理提交后返回的批次标识。
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename = "graphics-ack")]
struct GraphicsAck {
    generation: u32,
    sequence: u32,
}

/// 单个 WebSocket 连接的消息循环任务。
async fn run_bridge_socket(
    mut socket: WebSocket,
    snapshot: RuntimeSessionSnapshot,
    mut rx: broadcast::Receiver<axum::extract::ws::Message>,
    sessions: SessionManager,
) {
    log_event!(
        LogLevel::Debug,
        "rdp.bridge.opened",
        None,
        json!({
            "sessionId": &snapshot.session_id,
            "state": &snapshot.state,
            "width": snapshot.width,
            "height": snapshot.height,
        }),
    );

    let connection_id = Uuid::new_v4();
    let (graphics_tx, mut graphics_rx) = mpsc::channel(1);
    if sessions
        .graphics_command(
            &snapshot.session_id,
            RuntimeCommand::GraphicsAttach {
                id: connection_id,
                sender: graphics_tx,
            },
        )
        .is_err()
    {
        return;
    }

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
            frame = graphics_rx.recv() => {
                let Some(frame) = frame else { break; };
                if socket.send(frame).await.is_err() { break; }
            }
            // 从会话广播频道接收消息并推送到 WebSocket
            outbound = rx.recv() => {
                match outbound {
                    Ok(message) => {
                        if socket.send(message).await.is_err() {
                            log_event!(
            LogLevel::Warn,
            "rdp.bridge.send.failed",
            None,
            json!({
                                "sessionId": &snapshot.session_id,
                                "error": {
                                    "code": "rdp_bridge_send_failed",
                                    "message": "RDP bridge send failed",
                                },
                            }),
                            );
                            break;
                        }
                    }
                    Err(RecvError::Lagged(count)) => {
                        // 控制事件不可跳过：显式关闭并要求重建桥接与完整快照。
                        log_event!(
            LogLevel::Debug,
            "rdp.bridge.receiver.lagged",
            None,
            json!({
                                "sessionId": &snapshot.session_id,
                                "lagged": count,
                            }),
                        );
                        let _ = socket.send(axum::extract::ws::Message::Close(Some(axum::extract::ws::CloseFrame {
                            code: 1013, reason: "RDP control stream overflow; reconnect bridge".into(),
                        }))).await;
                        break;
                    }
                    Err(RecvError::Closed) => {
                        log_event!(
            LogLevel::Debug,
            "rdp.bridge.channel.closed",
            None,
            json!({ "sessionId": &snapshot.session_id }),
                        );
                        break;
                    }
                }
            }
            // 接收来自 WebSocket 的控制消息（目前主要用于链路监控）
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(axum::extract::ws::Message::Close(frame))) => {
                        log_event!(
            LogLevel::Debug,
            "rdp.bridge.client.close.received",
            None,
            json!({
                                "sessionId": &snapshot.session_id,
                                "hasCloseFrame": frame.is_some(),
                            }),
                        );
                        break;
                    }
                    None => break,
                    Some(Ok(axum::extract::ws::Message::Text(text))) => {
                        if let Ok(ack) = serde_json::from_str::<GraphicsAck>(&text) {
                            let _ = sessions.graphics_command(&snapshot.session_id, RuntimeCommand::GraphicsAck {
                                id: connection_id, generation: ack.generation, sequence: ack.sequence,
                            });
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        log_event!(
            LogLevel::Warn,
            "rdp.bridge.receive.failed",
            None,
            json!({
                                "sessionId": &snapshot.session_id,
                                "error": {
                                    "code": "rdp_bridge_receive_failed",
                                    "message": "RDP bridge receive failed",
                                    "detail": error.to_string(),
                                },
                            }),
                        );
                        break;
                    }
                }
            }
        }
    }
    log_event!(
        LogLevel::Debug,
        "rdp.bridge.closed",
        None,
        json!({
            "sessionId": &snapshot.session_id,
            "state": &snapshot.state,
        }),
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
        "Failed to start the RDP bridge",
        err.to_string(),
    )
}

#[cfg(test)]
mod tests {
    /// 确认前端 JSON 控制消息能进入准确的批次确认路径。
    #[test]
    fn decodes_graphics_acknowledgement() {
        let ack: super::GraphicsAck =
            serde_json::from_str(r#"{"type":"graphics-ack","generation":2,"sequence":19}"#)
                .unwrap();
        assert_eq!((ack.generation, ack.sequence), (2, 19));
        assert!(serde_json::from_str::<super::GraphicsAck>(
            r#"{"type":"graphics-ack","generation":2}"#,
        ).is_err());
    }
}
