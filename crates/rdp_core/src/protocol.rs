use serde::{Deserialize, Serialize};

/// RDP 会话的远端音频播放状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeAudioState {
    /// 尚未开始协商或远端当前没有输出音频。
    Idle,
    /// 已声明远端音频能力，正在等待服务端完成协商。
    Negotiating,
    /// 远端音频正在本机播放。
    Playing,
    /// 当前会话已静音。
    Muted,
    /// 协商或本地播放设备发生错误。
    Error,
}

/// RDP 运行时远端体验标志。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePerformanceFlags {
    /// 是否显示远端桌面壁纸。
    pub wallpaper: bool,
    /// 拖动窗口时是否显示完整内容。
    pub full_window_drag: bool,
    /// 是否启用菜单动画。
    pub menu_animations: bool,
    /// 是否启用视觉主题。
    pub theming: bool,
    /// 是否启用光标阴影。
    pub cursor_shadow: bool,
    /// 是否应用远端光标设置。
    pub cursor_settings: bool,
    /// 是否启用字体平滑。
    pub font_smoothing: bool,
    /// 是否启用桌面组合。
    pub desktop_composition: bool,
}

/// 进程内 RDP 会话的连接参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConnectRequest {
    /// 唯一的会话 ID。
    pub session_id: String,
    /// 远端 RDP 主机地址。
    pub host: String,
    /// 远端 RDP 服务端口（通常为 3389）。
    pub port: u16,
    /// 登录用户名。
    pub username: String,
    /// 登录密码。
    pub password: String,
    /// 登录域名（可选）。
    pub domain: Option<String>,
    /// 是否忽略服务器证书错误。
    pub ignore_certificate: bool,
    /// 请求的初始宽度。
    pub width: u32,
    /// 请求的初始高度。
    pub height: u32,
    /// 远端体验标志。
    pub performance_flags: RuntimePerformanceFlags,
    /// 匿名性能数据流 ID；未启用遥测时为空。
    #[cfg(feature = "performance-telemetry")]
    #[serde(default)]
    pub performance_stream_id: Option<String>,
}

/// 运行时 RDP 会话的快照信息。
///
/// 用于向前端同步当前会话的状态和元数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSessionSnapshot {
    /// 会话标识符。
    pub session_id: String,
    /// 配置标识符。
    pub profile_id: String,
    /// 当前连接状态 (例如 "connected", "disconnected", "error")。
    pub state: String,
    /// 会话当前的实际宽度。
    pub width: u32,
    /// 会话当前的实际高度。
    pub height: u32,
    /// 用于前端 WebGL 连接的 WebSocket URL。
    pub ws_url: Option<String>,
    /// 是否为此会话启用远端音频播放。
    pub audio_enabled: bool,
    /// 当前会话是否静音。
    pub audio_muted: bool,
    /// 当前远端音频播放状态。
    pub audio_state: RuntimeAudioState,
}

/// 统一的键盘和鼠标输入事件负载。
///
/// 支持多种输入类型，包括按键、鼠标点击、移动以及滚轮事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInputEvent {
    /// 事件类型 (如 "key_down", "mouse_move", "wheel")。
    pub kind: String,
    /// 鼠标 X 坐标（像素）。
    pub x: Option<f64>,
    /// 鼠标 Y 坐标（像素）。
    pub y: Option<f64>,
    /// 鼠标按钮索引。
    pub button: Option<u8>,
    /// 滚轮 X 偏移。
    pub delta_x: Option<f64>,
    /// 滚轮 Y 偏移。
    pub delta_y: Option<f64>,
    /// 按键的显示文本（如 "a", "Enter"）。
    pub text: Option<String>,
    /// 按键的机器码（如 "KeyA", "Space"）。
    pub code: Option<String>,
    /// Ctrl 键是否按下。
    pub ctrl_key: Option<bool>,
    /// Shift 键是否按下。
    pub shift_key: Option<bool>,
    /// Alt 键是否按下。
    pub alt_key: Option<bool>,
    /// Meta 键是否按下。
    pub meta_key: Option<bool>,
}
