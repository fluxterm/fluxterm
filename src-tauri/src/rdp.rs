//! RDP profile、会话与进程内运行时编排。
const RDP_SESSION_NOT_FOUND_CODE: &str = "rdp_session_not_found";

#[cfg(feature = "performance-telemetry")]
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use fluxterm_engine::EngineError;
#[cfg(feature = "performance-telemetry")]
use fluxterm_performance_telemetry::{
    PerformanceDomain, RecordOutcome, StreamCorrelation, StreamKind, StreamOutcome,
    StreamParameter, StreamTarget, close_stream as close_performance_stream,
    create_stream_descriptor, domain_enabled, open_stream as open_performance_stream, unix_time_ms,
};
use fluxterm_rdp_core::{
    RdpRuntime, RuntimeAudioState, RuntimeConnectRequest, RuntimeError, RuntimeInputEvent,
    RuntimePerformanceFlags, RuntimeSessionSnapshot,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// RDP 显示模式。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RdpDisplayMode {
    #[serde(rename = "fixed", alias = "Fixed")]
    Fixed,
    #[serde(rename = "window_sync", alias = "windowSync", alias = "WindowSync")]
    WindowSync,
}

/// RDP 本地显示策略。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub enum RdpDisplayStrategy {
    #[default]
    #[serde(rename = "fit", alias = "Fit")]
    Fit,
    #[serde(rename = "cover", alias = "Cover")]
    Cover,
    #[serde(rename = "stretch", alias = "Stretch")]
    Stretch,
}

/// RDP 剪贴板模式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RdpClipboardMode {
    Disabled,
    Text,
}

/// RDP 自动重连策略。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpReconnectPolicy {
    pub enabled: bool,
    pub max_attempts: u8,
}

/// RDP 远端体验标志。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpPerformanceFlags {
    #[serde(default = "default_false")]
    pub wallpaper: bool,
    #[serde(default = "default_false")]
    pub full_window_drag: bool,
    #[serde(default = "default_false")]
    pub menu_animations: bool,
    #[serde(default = "default_false")]
    pub theming: bool,
    #[serde(default = "default_false")]
    pub cursor_shadow: bool,
    #[serde(default = "default_true")]
    pub cursor_settings: bool,
    #[serde(default = "default_false")]
    pub font_smoothing: bool,
    #[serde(default = "default_false")]
    pub desktop_composition: bool,
}

impl Default for RdpPerformanceFlags {
    fn default() -> Self {
        Self {
            wallpaper: false,
            full_window_drag: false,
            menu_animations: false,
            theming: false,
            cursor_shadow: false,
            cursor_settings: true,
            font_smoothing: false,
            desktop_composition: false,
        }
    }
}

/// RDP Profile。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub credential_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub tags: Option<Vec<String>>,
    pub password_ref: Option<String>,
    pub domain: Option<String>,
    pub ignore_certificate: bool,
    pub resolution_mode: RdpDisplayMode,
    #[serde(default)]
    pub display_strategy: RdpDisplayStrategy,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub clipboard_mode: RdpClipboardMode,
    pub reconnect_policy: RdpReconnectPolicy,
    #[serde(default)]
    pub performance_flags: RdpPerformanceFlags,
}

/// RDP 会话状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RdpSessionState {
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
    Error,
    CertificatePrompt,
}

/// RDP 会话音频状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RdpSessionAudioState {
    Idle,
    Negotiating,
    Playing,
    Muted,
    Error,
}

/// RDP 证书确认信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpCertificatePrompt {
    pub fingerprint: String,
    pub subject: String,
    pub issuer: String,
}

/// RDP 运行时快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpSessionSnapshot {
    pub session_id: String,
    pub profile_id: String,
    pub state: RdpSessionState,
    pub created_at: u64,
    pub width: u32,
    pub height: u32,
    pub ws_url: Option<String>,
    pub audio_enabled: bool,
    pub audio_muted: bool,
    pub audio_state: RdpSessionAudioState,
    pub last_error: Option<EngineError>,
    pub certificate_prompt: Option<RdpCertificatePrompt>,
    /// 匿名性能数据流 ID，不等同于业务会话 ID。
    #[cfg(feature = "performance-telemetry")]
    pub performance_stream_id: Option<String>,
}

/// RDP 输入事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpInputEvent {
    pub kind: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub button: Option<u8>,
    pub delta_x: Option<f64>,
    pub delta_y: Option<f64>,
    pub text: Option<String>,
    pub code: Option<String>,
    pub ctrl_key: Option<bool>,
    pub shift_key: Option<bool>,
    pub alt_key: Option<bool>,
    pub meta_key: Option<bool>,
}

#[derive(Debug, Clone)]
struct LocalSessionRuntime {
    snapshot: RdpSessionSnapshot,
    profile: RdpProfile,
}

/// RDP 运行时状态。
#[derive(Debug, Clone, Default)]
pub struct RdpState {
    sessions: Arc<Mutex<HashMap<String, LocalSessionRuntime>>>,
    runtime: RdpRuntime,
}

impl RdpState {
    /// 创建会话。
    pub async fn create_session(
        &self,
        profile: &RdpProfile,
        initial_size: Option<(u32, u32)>,
    ) -> Result<RdpSessionSnapshot, EngineError> {
        let (initial_width, initial_height) = initial_size
            .map(|(width, height)| (width.max(320), height.max(200)))
            .or_else(|| {
                profile
                    .width
                    .zip(profile.height)
                    .map(|(width, height)| (width.max(320), height.max(200)))
            })
            .ok_or_else(|| {
                EngineError::new(
                    "rdp_resolution_required",
                    "The RDP session does not have a valid resolution",
                )
            })?;
        let snapshot = RdpSessionSnapshot {
            session_id: Uuid::new_v4().to_string(),
            profile_id: profile.id.clone(),
            state: RdpSessionState::Idle,
            created_at: now_epoch(),
            width: initial_width,
            height: initial_height,
            ws_url: None,
            audio_enabled: true,
            audio_muted: false,
            audio_state: RdpSessionAudioState::Idle,
            last_error: None,
            certificate_prompt: None,
            #[cfg(feature = "performance-telemetry")]
            performance_stream_id: None,
        };
        let runtime_snapshot = self
            .runtime
            .create_session(snapshot.session_id.clone(), snapshot.profile_id.clone())
            .await
            .map_err(runtime_error)?;
        let snapshot = merge_runtime_snapshot_preserving_dimensions(snapshot, runtime_snapshot);
        #[cfg(feature = "performance-telemetry")]
        let snapshot = {
            let mut snapshot = snapshot;
            snapshot.performance_stream_id = open_rdp_performance_stream(
                profile,
                &snapshot.session_id,
                initial_width,
                initial_height,
            );
            snapshot
        };
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        sessions.insert(
            snapshot.session_id.clone(),
            LocalSessionRuntime {
                snapshot: snapshot.clone(),
                profile: profile.clone(),
            },
        );
        Ok(snapshot)
    }

    /// 建立会话连接。
    pub async fn connect_session(
        &self,
        session_id: &str,
        operation_id: String,
    ) -> Result<RdpSessionSnapshot, EngineError> {
        let (current, profile) = self.get_session_with_profile(session_id)?;
        let runtime_snapshot = self
            .runtime
            .connect_session(
                session_id,
                RuntimeConnectRequest {
                    session_id: session_id.to_string(),
                    host: profile.host.clone(),
                    port: profile.port,
                    username: profile.username.clone(),
                    password: profile.password_ref.clone().unwrap_or_default(),
                    domain: profile.domain.clone(),
                    ignore_certificate: profile.ignore_certificate,
                    width: current.width,
                    height: current.height,
                    performance_flags: convert_performance_flags(profile.performance_flags.clone()),
                    #[cfg(feature = "performance-telemetry")]
                    performance_stream_id: current.performance_stream_id.clone(),
                },
                operation_id,
            )
            .await
            .map_err(runtime_error)?;
        self.update_session_snapshot(session_id, |snapshot| {
            *snapshot = merge_runtime_snapshot(snapshot.clone(), runtime_snapshot);
        })
    }

    /// 断开会话。
    pub async fn disconnect_session(
        &self,
        session_id: &str,
    ) -> Result<RdpSessionSnapshot, EngineError> {
        let runtime_snapshot = self
            .runtime
            .disconnect_session(session_id)
            .await
            .map_err(runtime_error)?;
        let snapshot = self.update_session_snapshot(session_id, |snapshot| {
            *snapshot = merge_runtime_snapshot(snapshot.clone(), runtime_snapshot);
        })?;
        #[cfg(feature = "performance-telemetry")]
        if let Some(stream_id) = snapshot.performance_stream_id.as_deref() {
            let _ =
                close_performance_stream(stream_id, StreamOutcome::Disconnected, unix_time_ms());
        }
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        sessions.remove(session_id);
        Ok(snapshot)
    }

    /// 更新会话分辨率。
    pub async fn resize_session(
        &self,
        session_id: &str,
        width: u32,
        height: u32,
    ) -> Result<RdpSessionSnapshot, EngineError> {
        let runtime_snapshot = self
            .runtime
            .resize_session(session_id, width, height)
            .map_err(runtime_error)?;
        self.update_session_snapshot(session_id, |snapshot| {
            *snapshot = merge_runtime_snapshot(snapshot.clone(), runtime_snapshot);
        })
    }

    /// 发送输入事件。
    pub async fn send_input(
        &self,
        session_id: &str,
        input: RdpInputEvent,
    ) -> Result<(), EngineError> {
        self.runtime
            .send_input(session_id, convert_input(input))
            .map_err(runtime_error)
    }

    /// 更新剪贴板内容。
    pub async fn set_clipboard(&self, session_id: &str, text: String) -> Result<(), EngineError> {
        self.runtime
            .set_clipboard(session_id, text)
            .map_err(runtime_error)
    }

    /// 设置会话级本地静音状态。
    pub async fn set_audio_muted(&self, session_id: &str, muted: bool) -> Result<(), EngineError> {
        self.runtime
            .set_audio_muted(session_id, muted)
            .map_err(runtime_error)?;
        self.update_session_snapshot(session_id, |snapshot| {
            snapshot.audio_muted = muted;
            snapshot.audio_state = match (muted, &snapshot.audio_state) {
                (_, RdpSessionAudioState::Error) => RdpSessionAudioState::Error,
                (true, _) => RdpSessionAudioState::Muted,
                (false, RdpSessionAudioState::Muted) => RdpSessionAudioState::Negotiating,
                (false, state) => state.clone(),
            };
        })?;
        Ok(())
    }

    /// 处理证书确认。
    pub async fn decide_certificate(
        &self,
        session_id: &str,
        accept: bool,
    ) -> Result<RdpSessionSnapshot, EngineError> {
        let runtime_snapshot = self
            .runtime
            .decide_certificate(session_id, accept)
            .map_err(runtime_error)?;
        self.update_session_snapshot(session_id, |snapshot| {
            *snapshot = merge_runtime_snapshot(snapshot.clone(), runtime_snapshot);
        })
    }

    /// 关闭并回收当前运行时。
    pub fn shutdown_runtime(&self) -> Result<(), EngineError> {
        self.runtime.shutdown().map_err(runtime_error)?;
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        #[cfg(feature = "performance-telemetry")]
        for runtime in sessions.values() {
            if let Some(stream_id) = runtime.snapshot.performance_stream_id.as_deref() {
                let _ = close_performance_stream(
                    stream_id,
                    StreamOutcome::Disconnected,
                    unix_time_ms(),
                );
            }
        }
        sessions.clear();
        Ok(())
    }

    fn get_session_with_profile(
        &self,
        session_id: &str,
    ) -> Result<(RdpSessionSnapshot, RdpProfile), EngineError> {
        let sessions = self.sessions.lock().map_err(lock_error)?;
        sessions
            .get(session_id)
            .map(|runtime| (runtime.snapshot.clone(), runtime.profile.clone()))
            .ok_or_else(|| EngineError::new(RDP_SESSION_NOT_FOUND_CODE, "RDP session not found"))
    }

    fn update_session_snapshot(
        &self,
        session_id: &str,
        update: impl FnOnce(&mut RdpSessionSnapshot),
    ) -> Result<RdpSessionSnapshot, EngineError> {
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        let runtime = sessions
            .get_mut(session_id)
            .ok_or_else(|| EngineError::new(RDP_SESSION_NOT_FOUND_CODE, "RDP session not found"))?;
        update(&mut runtime.snapshot);
        Ok(runtime.snapshot.clone())
    }
}

fn merge_runtime_snapshot(
    current: RdpSessionSnapshot,
    runtime: RuntimeSessionSnapshot,
) -> RdpSessionSnapshot {
    RdpSessionSnapshot {
        session_id: current.session_id,
        profile_id: current.profile_id,
        state: parse_state(&runtime.state),
        created_at: current.created_at,
        width: runtime.width.max(320),
        height: runtime.height.max(200),
        ws_url: runtime.ws_url,
        audio_enabled: runtime.audio_enabled,
        audio_muted: runtime.audio_muted,
        audio_state: parse_audio_state(runtime.audio_state),
        last_error: current.last_error,
        certificate_prompt: current.certificate_prompt,
        #[cfg(feature = "performance-telemetry")]
        performance_stream_id: current.performance_stream_id,
    }
}

fn merge_runtime_snapshot_preserving_dimensions(
    current: RdpSessionSnapshot,
    runtime: RuntimeSessionSnapshot,
) -> RdpSessionSnapshot {
    RdpSessionSnapshot {
        session_id: current.session_id,
        profile_id: current.profile_id,
        state: parse_state(&runtime.state),
        created_at: current.created_at,
        width: current.width.max(320),
        height: current.height.max(200),
        ws_url: runtime.ws_url,
        audio_enabled: runtime.audio_enabled,
        audio_muted: runtime.audio_muted,
        audio_state: parse_audio_state(runtime.audio_state),
        last_error: current.last_error,
        certificate_prompt: current.certificate_prompt,
        #[cfg(feature = "performance-telemetry")]
        performance_stream_id: current.performance_stream_id,
    }
}

fn parse_state(value: &str) -> RdpSessionState {
    match value {
        "connecting" => RdpSessionState::Connecting,
        "connected" => RdpSessionState::Connected,
        "reconnecting" => RdpSessionState::Reconnecting,
        "disconnected" => RdpSessionState::Disconnected,
        "error" => RdpSessionState::Error,
        "certificate_prompt" => RdpSessionState::CertificatePrompt,
        _ => RdpSessionState::Idle,
    }
}

fn parse_audio_state(value: RuntimeAudioState) -> RdpSessionAudioState {
    match value {
        RuntimeAudioState::Idle => RdpSessionAudioState::Idle,
        RuntimeAudioState::Negotiating => RdpSessionAudioState::Negotiating,
        RuntimeAudioState::Playing => RdpSessionAudioState::Playing,
        RuntimeAudioState::Muted => RdpSessionAudioState::Muted,
        RuntimeAudioState::Error => RdpSessionAudioState::Error,
    }
}

fn convert_input(input: RdpInputEvent) -> RuntimeInputEvent {
    RuntimeInputEvent {
        kind: input.kind,
        x: input.x,
        y: input.y,
        button: input.button,
        delta_x: input.delta_x,
        delta_y: input.delta_y,
        text: input.text,
        code: input.code,
        ctrl_key: input.ctrl_key,
        shift_key: input.shift_key,
        alt_key: input.alt_key,
        meta_key: input.meta_key,
    }
}

fn convert_performance_flags(flags: RdpPerformanceFlags) -> RuntimePerformanceFlags {
    RuntimePerformanceFlags {
        wallpaper: flags.wallpaper,
        full_window_drag: flags.full_window_drag,
        menu_animations: flags.menu_animations,
        theming: flags.theming,
        cursor_shadow: flags.cursor_shadow,
        cursor_settings: flags.cursor_settings,
        font_smoothing: flags.font_smoothing,
        desktop_composition: flags.desktop_composition,
    }
}

/// 为 RDP 会话打开不包含业务身份的性能流。
#[cfg(feature = "performance-telemetry")]
fn open_rdp_performance_stream(
    profile: &RdpProfile,
    session_id: &str,
    width: u32,
    height: u32,
) -> Option<String> {
    if !domain_enabled(PerformanceDomain::Rdp) {
        return None;
    }
    let flags = &profile.performance_flags;
    let descriptor = create_stream_descriptor(
        StreamKind::RdpSession,
        unix_time_ms(),
        BTreeMap::from([
            ("width".into(), StreamParameter::Unsigned(u64::from(width))),
            (
                "height".into(),
                StreamParameter::Unsigned(u64::from(height)),
            ),
            ("wallpaper".into(), StreamParameter::Bool(flags.wallpaper)),
            (
                "fullWindowDrag".into(),
                StreamParameter::Bool(flags.full_window_drag),
            ),
            (
                "menuAnimations".into(),
                StreamParameter::Bool(flags.menu_animations),
            ),
            ("theming".into(), StreamParameter::Bool(flags.theming)),
            (
                "cursorShadow".into(),
                StreamParameter::Bool(flags.cursor_shadow),
            ),
            (
                "cursorSettings".into(),
                StreamParameter::Bool(flags.cursor_settings),
            ),
            (
                "fontSmoothing".into(),
                StreamParameter::Bool(flags.font_smoothing),
            ),
            (
                "desktopComposition".into(),
                StreamParameter::Bool(flags.desktop_composition),
            ),
        ]),
        StreamTarget {
            host: profile.host.clone(),
            port: profile.port,
        },
        StreamCorrelation {
            session_id: session_id.to_string(),
            transfer_id: None,
        },
    );
    let stream_id = descriptor.id.clone();
    (open_performance_stream(descriptor) == RecordOutcome::Accepted).then_some(stream_id)
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

fn runtime_error(err: RuntimeError) -> EngineError {
    if let Some(detail) = err.detail {
        EngineError::with_detail(&err.code, &err.message, detail)
    } else {
        EngineError::new(&err.code, &err.message)
    }
}

fn lock_error(
    _: std::sync::PoisonError<std::sync::MutexGuard<'_, HashMap<String, LocalSessionRuntime>>>,
) -> EngineError {
    EngineError::new("rdp_runtime_poisoned", "RDP runtime state is unavailable")
}
