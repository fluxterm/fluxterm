//! AI 能力接入模块。
//!
//! 当前职责：
//! - 维护 OpenAI 配置解析
//! - 维护终端会话问答所需的运行时缓存
//! - 向命令层暴露会话上下文构建能力

pub mod context;

const AI_PROVIDER_CONFIG_INVALID_CODE: &str = "ai_provider_config_invalid";
const AI_STATE_LOCK_FAILED_CODE: &str = "ai_state_lock_failed";

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use engine::{EngineError, HostProfile, Session, SessionResourceSnapshot, SessionState};
use openai::OpenAiClientConfig;
use tauri::{AppHandle, Manager};

use crate::ai_settings::{AiProviderSettings, AiSettings, read_ai_settings};
use crate::security::{CryptoService, SecretStore};
use crate::security_store::read_security_config;
use crate::state::SecurityState;

const MAX_OUTPUT_CHARS: usize = 6_000;
const MAX_OUTPUT_SNIPPETS: usize = 8;
const MAX_OUTPUT_INPUT_BYTES: usize = 16 * 1024;

/// AI 运行时共享状态。
pub struct AiRuntimeState {
    inner: Mutex<AiRuntimeStore>,
}

impl Default for AiRuntimeState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(AiRuntimeStore::default()),
        }
    }
}

#[derive(Default)]
pub(crate) struct AiRuntimeStore {
    sessions: HashMap<String, SessionContextRecord>,
    active_streams: HashMap<String, Arc<AtomicBool>>,
    request_cache: HashMap<String, CachedAiResponse>,
}

#[derive(Clone)]
pub(crate) struct SessionContextRecord {
    pub session_id: String,
    pub session_label: String,
    pub session_kind: String,
    pub host: Option<String>,
    pub username: Option<String>,
    pub platform: Option<String>,
    pub shell_name: Option<String>,
    pub session_state: String,
    pub resource_monitor_status: Option<String>,
    pub host_key_status: Option<String>,
    pub recent_terminal_output: VecDeque<String>,
}

#[derive(Clone)]
struct CachedAiResponse {
    content: String,
    expires_at: Instant,
}

impl SessionContextRecord {
    fn from_remote(session: &Session, profile: &HostProfile) -> Self {
        Self {
            session_id: session.session_id.clone(),
            session_label: profile.name.clone(),
            session_kind: "ssh".to_string(),
            host: Some(profile.host.clone()),
            username: (!profile.username.trim().is_empty()).then(|| profile.username.clone()),
            platform: None,
            shell_name: None,
            session_state: "connected".to_string(),
            resource_monitor_status: None,
            host_key_status: Some("trusted".to_string()),
            recent_terminal_output: VecDeque::new(),
        }
    }

    fn from_local(session: &Session, label: &str, shell_name: Option<String>) -> Self {
        Self {
            session_id: session.session_id.clone(),
            session_label: label.to_string(),
            session_kind: "local".to_string(),
            host: None,
            username: None,
            platform: Some(current_platform().to_string()),
            shell_name,
            session_state: "connected".to_string(),
            resource_monitor_status: None,
            host_key_status: None,
            recent_terminal_output: VecDeque::new(),
        }
    }
}

/// 读取当前激活的 AI 接入配置。
pub fn read_active_provider_config(app: &AppHandle) -> Result<OpenAiClientConfig, EngineError> {
    read_provider_config_by_id(app, None)
}

/// 按 id 读取指定接入配置；未传入时读取当前激活配置。
pub fn read_provider_config_by_id(
    app: &AppHandle,
    provider_id: Option<&str>,
) -> Result<OpenAiClientConfig, EngineError> {
    let ai_settings = read_ai_settings(app)?;
    let selected_provider = resolve_provider(&ai_settings, provider_id)?;
    let base_url = selected_provider.base_url.trim().to_string();
    let model = selected_provider.model.trim().to_string();
    if base_url.is_empty() || model.is_empty() {
        return Err(EngineError::new(
            AI_PROVIDER_CONFIG_INVALID_CODE,
            "The active AI provider configuration is incomplete",
        ));
    }
    let api_key = resolve_provider_api_key(app, &ai_settings, selected_provider.id.as_str())?;

    Ok(OpenAiClientConfig {
        api_key,
        base_url,
        model,
        timeout_ms: ai_settings.request_timeout_ms,
    })
}

fn resolve_provider_api_key(
    app: &AppHandle,
    settings: &crate::ai_settings::AiSettings,
    provider_id: &str,
) -> Result<String, EngineError> {
    if let Some(token) = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .and_then(|provider| provider.api_key_ref.as_ref())
    {
        let security_config = read_security_config(app)?;
        let security = app.state::<SecurityState>();
        let session = security.current_session();
        let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
        let secret_store = SecretStore::new(&crypto);
        return secret_store
            .reveal_optional_string(Some(token.clone()))
            .map(|value| value.unwrap_or_default());
    }
    Ok(String::new())
}

fn resolve_provider<'a>(
    settings: &'a AiSettings,
    provider_id: Option<&str>,
) -> Result<&'a AiProviderSettings, EngineError> {
    let selected = if let Some(provider_id) = provider_id.map(str::trim).filter(|id| !id.is_empty())
    {
        settings
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
    } else {
        settings.active_provider()
    };
    selected.ok_or_else(|| {
        EngineError::new(
            AI_PROVIDER_CONFIG_INVALID_CODE,
            "The active AI provider configuration is incomplete",
        )
    })
}

/// 记录 SSH 会话元数据，供后续 AI 上下文消费。
pub fn register_remote_session(
    state: &AiRuntimeState,
    session: &Session,
    profile: &HostProfile,
) -> Result<(), EngineError> {
    let mut store = state.inner.lock().map_err(|_| {
        EngineError::new(AI_STATE_LOCK_FAILED_CODE, "AI runtime state is unavailable")
    })?;
    store.sessions.insert(
        session.session_id.clone(),
        SessionContextRecord::from_remote(session, profile),
    );
    Ok(())
}

/// 记录本地 Shell 会话元数据，供后续 AI 上下文消费。
pub fn register_local_session(
    state: &AiRuntimeState,
    session: &Session,
    label: &str,
    shell_name: Option<String>,
) -> Result<(), EngineError> {
    let mut store = state.inner.lock().map_err(|_| {
        EngineError::new(AI_STATE_LOCK_FAILED_CODE, "AI runtime state is unavailable")
    })?;
    store.sessions.insert(
        session.session_id.clone(),
        SessionContextRecord::from_local(session, label, shell_name),
    );
    Ok(())
}

/// 记录终端输出片段。
pub fn record_terminal_output_from_app(app: &AppHandle, session_id: &str, data: &str) {
    let state = app.state::<AiRuntimeState>();
    if let Ok(mut store) = state.inner.lock()
        && let Some(session) = store.sessions.get_mut(session_id)
    {
        // 先清洗 ANSI 与控制字符，再进入去重流程，避免把终端重绘噪音写入上下文。
        // 高频输出批次可能很大；AI 上下文只需要最近尾部，先限制清洗输入，
        // 避免 ANSI 解析和归一化反过来阻塞终端输出线程。
        let mut snippet_start = data.len().saturating_sub(MAX_OUTPUT_INPUT_BYTES);
        while !data.is_char_boundary(snippet_start) {
            snippet_start += 1;
        }
        let normalized = normalize_terminal_output_snippet(&data[snippet_start..]);
        if normalized.is_empty() {
            return;
        }
        let dedup_key = normalize_output_for_dedup(&normalized);
        if dedup_key.is_empty() {
            return;
        }
        // 采集层仅做“连续重复”去重：只比较队尾，保留真实时间序列。
        if session
            .recent_terminal_output
            .back()
            .map(|last| normalize_output_for_dedup(last))
            .as_deref()
            == Some(dedup_key.as_str())
        {
            return;
        }
        session
            .recent_terminal_output
            .push_back(truncate_chars(&normalized, 512));
        while session.recent_terminal_output.len() > MAX_OUTPUT_SNIPPETS {
            session.recent_terminal_output.pop_front();
        }
        // 片段数量和总字符预算双重限制，避免 prompt 体积失控。
        trim_output_budget(&mut session.recent_terminal_output, MAX_OUTPUT_CHARS);
    }
}

/// 记录终端退出。
pub fn record_terminal_exit_from_app(app: &AppHandle, session_id: &str) {
    let state = app.state::<AiRuntimeState>();
    if let Ok(mut store) = state.inner.lock()
        && let Some(session) = store.sessions.get_mut(session_id)
    {
        session.session_state = "disconnected".to_string();
    }
}

/// 记录会话状态事件。
pub fn record_session_status_from_app(
    app: &AppHandle,
    session_id: &str,
    state_name: SessionState,
    error: Option<engine::EngineError>,
) {
    let state = app.state::<AiRuntimeState>();
    if let Ok(mut store) = state.inner.lock()
        && let Some(session) = store.sessions.get_mut(session_id)
    {
        session.session_state = match state_name {
            SessionState::Connecting => "connecting",
            SessionState::Connected => "connected",
            SessionState::Disconnected => "disconnected",
            SessionState::Error => "error",
        }
        .to_string();
        if let Some(error) = error {
            update_host_key_status(session, &error.code);
        }
    }
}

/// 记录资源监控状态。
pub fn record_resource_snapshot_from_app(app: &AppHandle, snapshot: &SessionResourceSnapshot) {
    let state = app.state::<AiRuntimeState>();
    if let Ok(mut store) = state.inner.lock()
        && let Some(session) = store.sessions.get_mut(&snapshot.session_id)
    {
        session.resource_monitor_status = Some(format!("{:?}", snapshot.status).to_lowercase());
    }
}

pub(crate) fn with_store<T>(
    state: &AiRuntimeState,
    callback: impl FnOnce(&AiRuntimeStore) -> Result<T, EngineError>,
) -> Result<T, EngineError> {
    let store = state.inner.lock().map_err(|_| {
        EngineError::new(AI_STATE_LOCK_FAILED_CODE, "AI runtime state is unavailable")
    })?;
    callback(&store)
}

/// 注册流式问答请求，返回取消标记。
pub fn register_chat_stream(
    state: &AiRuntimeState,
    request_id: &str,
) -> Result<Arc<AtomicBool>, EngineError> {
    let mut store = state.inner.lock().map_err(|_| {
        EngineError::new(AI_STATE_LOCK_FAILED_CODE, "AI runtime state is unavailable")
    })?;
    let cancelled = Arc::new(AtomicBool::new(false));
    store
        .active_streams
        .insert(request_id.to_string(), cancelled.clone());
    Ok(cancelled)
}

/// 取消流式问答请求。
pub fn cancel_chat_stream(state: &AiRuntimeState, request_id: &str) -> Result<bool, EngineError> {
    let store = state.inner.lock().map_err(|_| {
        EngineError::new(AI_STATE_LOCK_FAILED_CODE, "AI runtime state is unavailable")
    })?;
    Ok(store
        .active_streams
        .get(request_id)
        .map(|flag| {
            flag.store(true, Ordering::SeqCst);
            true
        })
        .unwrap_or(false))
}

/// 清理流式问答请求。
pub fn finish_chat_stream(state: &AiRuntimeState, request_id: &str) -> Result<(), EngineError> {
    let mut store = state.inner.lock().map_err(|_| {
        EngineError::new(AI_STATE_LOCK_FAILED_CODE, "AI runtime state is unavailable")
    })?;
    store.active_streams.remove(request_id);
    Ok(())
}

/// 尝试读取尚未过期的 AI 响应缓存。
pub fn get_cached_response(
    state: &AiRuntimeState,
    cache_key: &str,
) -> Result<Option<String>, EngineError> {
    let mut store = state.inner.lock().map_err(|_| {
        EngineError::new(AI_STATE_LOCK_FAILED_CODE, "AI runtime state is unavailable")
    })?;
    prune_expired_cache(&mut store.request_cache);
    Ok(store
        .request_cache
        .get(cache_key)
        .map(|entry| entry.content.clone()))
}

/// 写入短时间内可复用的 AI 响应缓存。
pub fn store_cached_response(
    state: &AiRuntimeState,
    cache_key: String,
    content: String,
    ttl_ms: u64,
) -> Result<(), EngineError> {
    let mut store = state.inner.lock().map_err(|_| {
        EngineError::new(AI_STATE_LOCK_FAILED_CODE, "AI runtime state is unavailable")
    })?;
    prune_expired_cache(&mut store.request_cache);
    store.request_cache.insert(
        cache_key,
        CachedAiResponse {
            content,
            expires_at: Instant::now() + Duration::from_millis(ttl_ms),
        },
    );
    Ok(())
}

fn update_host_key_status(session: &mut SessionContextRecord, error_code: &str) {
    session.host_key_status =
        resolve_host_key_status(error_code).or_else(|| session.host_key_status.clone());
}

fn resolve_host_key_status(error_code: &str) -> Option<String> {
    match error_code {
        "ssh_host_key_unknown" => Some("unknown".to_string()),
        "ssh_host_key_mismatch" => Some("mismatch".to_string()),
        _ => None,
    }
}

fn trim_output_budget(items: &mut VecDeque<String>, limit: usize) {
    while items.iter().map(|item| item.chars().count()).sum::<usize>() > limit {
        items.pop_front();
    }
}

/// 清洗终端片段，移除 ANSI 控制序列和不可见控制字符，保留可读文本。
fn normalize_terminal_output_snippet(input: &str) -> String {
    let without_ansi = strip_ansi_escape_sequences(input);
    let normalized_newline = without_ansi.replace("\r\n", "\n").replace('\r', "\n");
    let mut visible = String::with_capacity(normalized_newline.len());
    for ch in normalized_newline.chars() {
        if ch == '\n' || ch == '\t' || !ch.is_control() {
            visible.push(ch);
        }
    }
    visible
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// 生成用于去重的归一化键，避免重复屏幕重绘污染上下文。
fn normalize_output_for_dedup(input: &str) -> String {
    input
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(|line| normalize_whitespace_runs(line.trim()))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_whitespace_runs(input: &str) -> String {
    // 去重键使用统一空白语义：连续空白折叠成单空格。
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_ansi_escape_sequences(input: &str) -> String {
    // 覆盖常见终端控制序列：
    // - CSI: ESC [ ... final-byte
    // - OSC: ESC ] ... BEL / ST(ESC \)
    let bytes = input.as_bytes();
    let mut i = 0usize;
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    while i < bytes.len() {
        if bytes[i] == 0x1B {
            if i + 1 < bytes.len() {
                match bytes[i + 1] {
                    b'[' => {
                        i += 2;
                        while i < bytes.len() {
                            let b = bytes[i];
                            if (0x40..=0x7E).contains(&b) {
                                i += 1;
                                break;
                            }
                            i += 1;
                        }
                        continue;
                    }
                    b']' => {
                        i += 2;
                        while i < bytes.len() {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1B && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                        continue;
                    }
                    _ => {
                        i += 2;
                        continue;
                    }
                }
            }
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn prune_expired_cache(cache: &mut HashMap<String, CachedAiResponse>) {
    let now = Instant::now();
    cache.retain(|_, value| value.expires_at > now);
}

fn truncate_chars(input: &str, limit: usize) -> String {
    if input.chars().count() <= limit {
        return input.to_string();
    }
    input.chars().take(limit).collect()
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }

    #[cfg(target_os = "linux")]
    {
        "linux"
    }

    #[cfg(target_os = "macos")]
    {
        "macos"
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        "unknown"
    }
}

#[cfg(test)]
pub fn record_terminal_output_for_test(state: &AiRuntimeState, session_id: &str, data: &str) {
    if let Ok(mut store) = state.inner.lock()
        && let Some(session) = store.sessions.get_mut(session_id)
    {
        session.recent_terminal_output.push_back(data.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_chars_keeps_limit() {
        let result = truncate_chars("abcdefgh", 4);
        assert_eq!(result, "abcd");
    }

    #[test]
    fn cached_response_expires() {
        let state = AiRuntimeState::default();
        store_cached_response(&state, "k".to_string(), "v".to_string(), 1).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        let cached = get_cached_response(&state, "k").unwrap();
        assert!(cached.is_none());
    }

    #[test]
    fn normalize_terminal_output_strips_ansi_and_controls() {
        let input = "\u{1b}[2J\u{1b}[Hhello\r\nworld\u{1b}[?25h\u{0008}";
        let normalized = normalize_terminal_output_snippet(input);
        assert_eq!(normalized, "hello\nworld");
    }

    #[test]
    fn normalize_output_for_dedup_ignores_whitespace_lines() {
        let first = "  PS C:\\>   \r\n";
        let second = "\nPS C:\\>\n\n";
        assert_eq!(
            normalize_output_for_dedup(first),
            normalize_output_for_dedup(second)
        );
    }

    #[test]
    fn normalize_output_for_dedup_collapses_internal_whitespace_runs() {
        let first = "PS   C:\\Users\\aw4>\tGet-ChildItem";
        let second = "PS C:\\Users\\aw4> Get-ChildItem";
        assert_eq!(
            normalize_output_for_dedup(first),
            normalize_output_for_dedup(second)
        );
    }
}
