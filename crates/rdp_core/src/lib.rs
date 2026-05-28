//! # RdpCore
//!
//! `rdp_core` crate 提供了 FluxTerm 进程内 RDP (远程桌面协议) 核心能力。
//! 它封装了底层 RDP 协议处理、会话管理以及与前端 WebGL 渲染器通信的 WebSocket 桥接。

mod bridge;
mod cliprdr;
mod ironrdp_runtime;
mod keyboard;
mod protocol;
mod session_manager;
mod telemetry;

use std::sync::Arc;

pub use protocol::{
    RuntimeConnectRequest, RuntimeInputEvent, RuntimePerformanceFlags, RuntimeSessionSnapshot,
};
use thiserror::Error;

use crate::bridge::BridgeServer;
use crate::session_manager::SessionManager;

/// 运行时操作的结果类型。
pub type RuntimeResult<T> = Result<T, RuntimeError>;

/// 表示运行时中发生的各种错误。
#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct RuntimeError {
    /// 错误的机器可读代码。
    pub code: String,
    /// 错误的简短描述。
    pub message: String,
    /// 可选的详细错误信息或堆栈跟踪。
    pub detail: Option<String>,
}

impl RuntimeError {
    /// 创建一个新的简单错误。
    ///
    /// # 参数
    ///
    /// * `code` - 错误码字符串。
    /// * `message` - 错误描述信息。
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            detail: None,
        }
    }

    /// 创建一个带有详细信息的错误。
    ///
    /// # 参数
    ///
    /// * `code` - 错误码字符串。
    /// * `message` - 错误描述信息。
    /// * `detail` - 详细错误背景信息。
    pub fn with_detail(code: &str, message: &str, detail: String) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            detail: Some(detail),
        }
    }
}

/// 进程内 RDP 运行时的核心入口。
///
/// 负责协调多个 RDP 会话的创建、连接以及消息路由。
/// 包含一个会话管理器和一个用于视频流传输的 WebSocket 桥接服务器。
#[derive(Debug, Clone, Default)]
pub struct RdpRuntime {
    /// 管理所有活动和挂起的 RDP 会话。
    sessions: SessionManager,
    /// WebSocket 桥接服务器，用于将 RDP 画面帧推送到前端。
    bridge: Arc<BridgeServer>,
}

impl RdpRuntime {
    /// 创建一个新的 RDP 会话。
    ///
    /// 确保 WebSocket 桥接已准备就绪，并初始化会话元数据。
    ///
    /// # 参数
    ///
    /// * `session_id` - 唯一的会话标识符。
    /// * `profile_id` - 关联的配置标识符。
    pub async fn create_session(
        &self,
        session_id: String,
        profile_id: String,
    ) -> RuntimeResult<RuntimeSessionSnapshot> {
        let _ = self.bridge.ensure_ready(self.sessions.clone()).await?;
        Ok(self.sessions.create_session(session_id, profile_id))
    }

    /// 启动到远程主机的连接。
    ///
    /// # 参数
    ///
    /// * `session_id` - 目标会话的 ID。
    /// * `request` - 包含主机、端口、凭据和分辨率的连接请求。
    pub async fn connect_session(
        &self,
        session_id: &str,
        request: RuntimeConnectRequest,
    ) -> RuntimeResult<RuntimeSessionSnapshot> {
        let bridge = self.bridge.ensure_ready(self.sessions.clone()).await?;
        let ws_url = format!(
            "{}/v1/bridge/{}?token={}",
            bridge.base_url, session_id, bridge.token
        );
        self.sessions.connect_session(session_id, request, ws_url)
    }

    /// 断开指定的 RDP 会话。
    pub fn disconnect_session(&self, session_id: &str) -> RuntimeResult<RuntimeSessionSnapshot> {
        self.sessions.disconnect_session(session_id)
    }

    /// 动态调整 RDP 会话的分辨率。
    ///
    /// 如果连接支持，将发送 Display Control 协议消息。
    pub fn resize_session(
        &self,
        session_id: &str,
        width: u32,
        height: u32,
    ) -> RuntimeResult<RuntimeSessionSnapshot> {
        self.sessions.resize_session(session_id, width, height)
    }

    /// 向远端会话发送键盘或鼠标输入事件。
    pub fn send_input(&self, session_id: &str, input: RuntimeInputEvent) -> RuntimeResult<()> {
        self.sessions.send_input(session_id, input)
    }

    /// 将本地剪贴板文本同步到远程桌面。
    pub fn set_clipboard(&self, session_id: &str, text: String) -> RuntimeResult<()> {
        self.sessions.set_clipboard(session_id, text)
    }

    /// 响应连接过程中的服务器证书决策。
    pub fn decide_certificate(
        &self,
        session_id: &str,
        accept: bool,
    ) -> RuntimeResult<RuntimeSessionSnapshot> {
        self.sessions.decide_certificate(session_id, accept)
    }

    /// 安全关闭所有活动会话并释放相关资源。
    /// 建议在应用退出前调用。
    pub fn shutdown(&self) -> RuntimeResult<()> {
        self.sessions.clear()
    }
}
