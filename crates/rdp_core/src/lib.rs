//! # RdpCore
//!
//! `fluxterm-rdp-core` crate 提供了 FluxTerm 进程内 RDP (远程桌面协议) 核心能力。
//! 它封装了底层 RDP 协议处理、会话管理以及与前端 WebGL 渲染器通信的 WebSocket 桥接。

mod audio;
mod bridge;
mod cliprdr;
mod ironrdp_runtime;
mod keyboard;
mod protocol;
mod session_manager;

use std::sync::Arc;

#[doc(hidden)]
pub mod benchmark_support {
    //! RDP core 内部算法的基准测试入口。
    //!
    //! 该模块仅用于 `benches/` 中的 Criterion 测试，避免把运行时内部类型直接暴露给应用层。

    /// 执行一次 RDP 图形脏矩形合并。
    ///
    /// # 参数
    ///
    /// * `rects` - `(left, top, right, bottom)` 形式的闭区间矩形列表。
    ///
    /// # 返回
    ///
    /// 返回合并后的同格式矩形列表。
    pub fn merge_update_rects(rects: &[(u16, u16, u16, u16)]) -> Vec<(u16, u16, u16, u16)> {
        crate::ironrdp_runtime::benchmark_merge_update_rects(rects)
    }

    /// 构造一张确定性的 RGBA 测试画面。
    pub fn create_test_rgba_surface(width: u32, height: u32) -> Vec<u8> {
        crate::session_manager::benchmark_create_test_rgba_surface(width, height)
    }

    /// 从测试画面中拷贝一个矩形区域到目标缓冲。
    pub fn copy_rgba_rect(
        surface: &[u8],
        surface_width: u32,
        rect: (u32, u32, u32, u32),
        dest: &mut [u8],
    ) {
        crate::session_manager::benchmark_copy_rgba_rect(surface, surface_width, rect, dest);
    }

    /// 构造单矩形 RGBA 帧消息。
    pub fn build_rgba_frame_message(
        surface: &[u8],
        surface_width: u32,
        surface_height: u32,
        rect: (u32, u32, u32, u32),
    ) -> usize {
        crate::session_manager::benchmark_build_rgba_frame_message(
            surface,
            surface_width,
            surface_height,
            rect,
        )
    }

    /// 构造批量 RGBA 帧消息。
    pub fn build_rgba_frame_batch_message(
        surface: &[u8],
        surface_width: u32,
        surface_height: u32,
        rects: &[(u32, u32, u32, u32)],
    ) -> usize {
        crate::session_manager::benchmark_build_rgba_frame_batch_message(
            surface,
            surface_width,
            surface_height,
            rects,
        )
    }

    /// 脏矩形策略评估结果。
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct OverdrawStats {
        /// 原始矩形数量。
        pub raw_rects: usize,
        /// 最终发送矩形数量。
        pub final_rects: usize,
        /// 原始矩形面积之和。
        pub raw_pixels: u64,
        /// 最终发送像素面积之和。
        pub sent_pixels: u64,
        /// 相对原始面积多发送的像素数。
        pub overdraw_pixels: u64,
        /// `sent_pixels / raw_pixels`。
        pub overdraw_ratio: f64,
    }

    /// 评估当前脏矩形合并与高压 collapse 策略。
    pub fn evaluate_overdraw_policy(
        rects: &[(u16, u16, u16, u16)],
        high_pressure: bool,
    ) -> OverdrawStats {
        let (raw_rects, final_rects, raw_pixels, sent_pixels) =
            crate::ironrdp_runtime::benchmark_evaluate_overdraw_policy(rects, high_pressure);
        OverdrawStats {
            raw_rects,
            final_rects,
            raw_pixels,
            sent_pixels,
            overdraw_pixels: sent_pixels.saturating_sub(raw_pixels),
            overdraw_ratio: sent_pixels as f64 / raw_pixels.max(1) as f64,
        }
    }
}

pub use protocol::{
    RuntimeAudioState, RuntimeConnectRequest, RuntimeInputEvent, RuntimePerformanceFlags,
    RuntimeSessionSnapshot,
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
        operation_id: String,
    ) -> RuntimeResult<RuntimeSessionSnapshot> {
        let bridge = self.bridge.ensure_ready(self.sessions.clone()).await?;
        let ws_url = format!(
            "{}/v1/bridge/{}?token={}",
            bridge.base_url, session_id, bridge.token
        );
        self.sessions
            .connect_session(session_id, request, ws_url, operation_id)
    }

    /// 断开指定的 RDP 会话。
    pub async fn disconnect_session(
        &self,
        session_id: &str,
    ) -> RuntimeResult<RuntimeSessionSnapshot> {
        self.sessions.disconnect_session(session_id).await
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

    /// 设置指定会话的本地静音状态。
    pub fn set_audio_muted(&self, session_id: &str, muted: bool) -> RuntimeResult<()> {
        self.sessions.set_audio_muted(session_id, muted)
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
