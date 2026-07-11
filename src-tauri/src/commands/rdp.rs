//! RDP profile 与会话命令。
use engine::EngineError;
use serde_json::json;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::profile_secrets::{decrypt_rdp_profile_secrets, encrypt_rdp_profile_secrets};
use crate::rdp::{RdpDisplayMode, RdpInputEvent, RdpProfile, RdpSessionSnapshot, RdpState};
use crate::rdp_profile_store::{
    read_rdp_groups, read_rdp_profiles, write_rdp_groups, write_rdp_profiles,
};
use crate::security::{CryptoService, SecretStore};
use crate::security_store::read_security_config;
use crate::state::SecurityState;
use crate::telemetry::{TelemetryLevel, log_telemetry};

use super::profile::{
    dedupe_groups, normalize_profile_tags, validate_and_dedupe_groups, validate_profile_name,
};

#[tauri::command]
/// 读取 RDP 分组列表。
pub fn rdp_profile_groups_list(
    app: AppHandle,
    trace_id: Option<String>,
) -> Result<Vec<String>, EngineError> {
    match read_rdp_groups(&app).map(dedupe_groups) {
        Ok(groups) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.profile.group.list.success",
                trace_id.as_deref(),
                json!({
                    "count": groups.len(),
                }),
            );
            Ok(groups)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.profile.group.list.failed",
                trace_id.as_deref(),
                json!({
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 写入 RDP 分组列表。
pub fn rdp_profile_groups_save(
    app: AppHandle,
    groups: Vec<String>,
    trace_id: Option<String>,
) -> Result<Vec<String>, EngineError> {
    match validate_and_dedupe_groups(groups).and_then(|next| {
        write_rdp_groups(&app, &next)?;
        Ok(next)
    }) {
        Ok(next) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.profile.group.save.success",
                trace_id.as_deref(),
                json!({
                    "count": next.len(),
                }),
            );
            Ok(next)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.profile.group.save.failed",
                trace_id.as_deref(),
                json!({
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 读取 RDP Profile 列表。
pub fn rdp_profile_list(
    app: AppHandle,
    security: State<'_, SecurityState>,
    trace_id: Option<String>,
) -> Result<Vec<RdpProfile>, EngineError> {
    let store = read_rdp_profiles(&app)?;
    let security_config = read_security_config(&app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    let secret_store = SecretStore::new(&crypto);
    let result: Result<Vec<RdpProfile>, EngineError> = store
        .profiles
        .into_iter()
        .map(
            |profile| match decrypt_rdp_profile_secrets(profile.clone(), &secret_store) {
                Ok(decrypted) => Ok(decrypted),
                Err(err)
                    if err.code == "security_locked"
                        && crypto.provider_kind()
                            == crate::security::EncryptionProviderKind::UserPassword =>
                {
                    let mut profile = profile;
                    profile.password_ref = None;
                    Ok(profile)
                }
                Err(err) => Err(err),
            },
        )
        .collect();
    match result {
        Ok(profiles) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.profile.list.success",
                trace_id.as_deref(),
                json!({
                    "count": profiles.len(),
                }),
            );
            Ok(profiles)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.profile.list.failed",
                trace_id.as_deref(),
                json!({
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 保存 RDP Profile。
pub fn rdp_profile_save(
    app: AppHandle,
    security: State<'_, SecurityState>,
    mut profile: RdpProfile,
    trace_id: Option<String>,
) -> Result<RdpProfile, EngineError> {
    let mut store = read_rdp_profiles(&app)?;
    let security_config = read_security_config(&app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    let secret_store = SecretStore::new(&crypto);

    profile.name = validate_profile_name(profile.name)?;
    profile.host = profile.host.trim().to_string();
    profile.username = profile.username.trim().to_string();
    profile.tags = normalize_profile_tags(profile.tags)?;
    if profile.host.is_empty() || profile.username.is_empty() {
        return Err(EngineError::new(
            "rdp_profile_required",
            "RDP host and username are required",
        ));
    }
    if profile.id.is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }
    if profile.port == 0 {
        profile.port = 3389;
    }
    match profile.resolution_mode {
        RdpDisplayMode::WindowSync => {
            profile.width = None;
            profile.height = None;
        }
        RdpDisplayMode::Fixed => {
            let width = profile.width.unwrap_or(0);
            let height = profile.height.unwrap_or(0);
            if width == 0 || height == 0 {
                return Err(EngineError::new(
                    "rdp_fixed_resolution_required",
                    "Fixed resolution mode requires a valid width and height",
                ));
            }
            profile.width = Some(width.max(320));
            profile.height = Some(height.max(200));
        }
    }
    let saved_profile = profile.clone();
    match encrypt_rdp_profile_secrets(profile.clone(), &secret_store).and_then(|encrypted| {
        let existing = store.profiles.iter_mut().find(|item| item.id == profile.id);
        if let Some(item) = existing {
            *item = encrypted;
        } else {
            store.profiles.push(encrypted);
        }
        store.updated_at = now_epoch();
        write_rdp_profiles(&app, &store)?;
        Ok(saved_profile)
    }) {
        Ok(profile) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.profile.save.success",
                trace_id.as_deref(),
                profile_payload(&profile),
            );
            Ok(profile)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.profile.save.failed",
                trace_id.as_deref(),
                json!({
                    "profileId": profile.id,
                    "resolutionMode": profile.resolution_mode,
                    "displayStrategy": profile.display_strategy,
                    "ignoreCertificate": profile.ignore_certificate,
                    "tagCount": profile.tags.as_ref().map_or(0, Vec::len),
                    "hasPassword": profile.password_ref.is_some(),
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 删除 RDP Profile。
pub fn rdp_profile_delete(
    app: AppHandle,
    profile_id: String,
    trace_id: Option<String>,
) -> Result<bool, EngineError> {
    let mut store = read_rdp_profiles(&app)?;
    let before = store.profiles.len();
    store.profiles.retain(|item| item.id != profile_id);
    store.updated_at = now_epoch();
    match write_rdp_profiles(&app, &store) {
        Ok(()) => {
            let removed = before != store.profiles.len();
            log_telemetry(
                TelemetryLevel::Debug,
                if removed {
                    "rdp.profile.delete.success"
                } else {
                    "rdp.profile.delete.failed"
                },
                trace_id.as_deref(),
                json!({
                    "profileId": profile_id,
                    "removed": removed,
                }),
            );
            Ok(removed)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.profile.delete.failed",
                trace_id.as_deref(),
                json!({
                    "profileId": profile_id,
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 创建 RDP 会话。
pub async fn rdp_session_create(
    app: AppHandle,
    security: State<'_, SecurityState>,
    rdp: State<'_, RdpState>,
    profile_id: String,
    width: Option<u32>,
    height: Option<u32>,
    trace_id: Option<String>,
) -> Result<RdpSessionSnapshot, EngineError> {
    log_telemetry(
        TelemetryLevel::Debug,
        "rdp.session.create.start",
        trace_id.as_deref(),
        json!({
            "profileId": profile_id,
            "width": width,
            "height": height,
        }),
    );
    let profile = load_profile(&app, &security, &profile_id)?;
    match rdp.create_session(&profile, width.zip(height)).await {
        Ok(snapshot) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.session.create.success",
                trace_id.as_deref(),
                session_payload(&snapshot),
            );
            Ok(snapshot)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.session.create.failed",
                trace_id.as_deref(),
                json!({
                    "profileId": profile.id,
                    "width": width,
                    "height": height,
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 启动 RDP 会话桥接。
pub async fn rdp_session_connect(
    rdp: State<'_, RdpState>,
    session_id: String,
    trace_id: Option<String>,
) -> Result<RdpSessionSnapshot, EngineError> {
    log_telemetry(
        TelemetryLevel::Debug,
        "rdp.session.connect.start",
        trace_id.as_deref(),
        json!({
            "sessionId": session_id,
        }),
    );
    match rdp.connect_session(&session_id).await {
        Ok(snapshot) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.session.connect.success",
                trace_id.as_deref(),
                session_payload(&snapshot),
            );
            Ok(snapshot)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.session.connect.failed",
                trace_id.as_deref(),
                json!({
                    "sessionId": session_id,
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 断开 RDP 会话。
pub async fn rdp_session_disconnect(
    rdp: State<'_, RdpState>,
    session_id: String,
    trace_id: Option<String>,
) -> Result<RdpSessionSnapshot, EngineError> {
    log_telemetry(
        TelemetryLevel::Debug,
        "rdp.session.disconnect.start",
        trace_id.as_deref(),
        json!({
            "sessionId": session_id,
        }),
    );
    match rdp.disconnect_session(&session_id).await {
        Ok(snapshot) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.session.disconnect.success",
                trace_id.as_deref(),
                session_payload(&snapshot),
            );
            Ok(snapshot)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.session.disconnect.failed",
                trace_id.as_deref(),
                json!({
                    "sessionId": session_id,
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 发送 RDP 输入。
pub async fn rdp_session_send_input(
    rdp: State<'_, RdpState>,
    session_id: String,
    input: RdpInputEvent,
    _trace_id: Option<String>,
) -> Result<(), EngineError> {
    rdp.send_input(&session_id, input).await
}

#[tauri::command]
/// 调整 RDP 远端分辨率。
pub async fn rdp_session_resize(
    rdp: State<'_, RdpState>,
    session_id: String,
    width: u32,
    height: u32,
    trace_id: Option<String>,
) -> Result<RdpSessionSnapshot, EngineError> {
    log_telemetry(
        TelemetryLevel::Debug,
        "rdp.session.resize.start",
        trace_id.as_deref(),
        json!({
            "sessionId": session_id,
            "width": width,
            "height": height,
        }),
    );
    match rdp.resize_session(&session_id, width, height).await {
        Ok(snapshot) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.session.resize.success",
                trace_id.as_deref(),
                session_payload(&snapshot),
            );
            Ok(snapshot)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.session.resize.failed",
                trace_id.as_deref(),
                json!({
                    "sessionId": session_id,
                    "width": width,
                    "height": height,
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 设置 RDP 剪贴板内容。
pub async fn rdp_session_set_clipboard(
    rdp: State<'_, RdpState>,
    session_id: String,
    text: String,
    _trace_id: Option<String>,
) -> Result<(), EngineError> {
    rdp.set_clipboard(&session_id, text).await
}

#[tauri::command]
/// 响应 RDP 证书确认。
pub async fn rdp_session_cert_decide(
    rdp: State<'_, RdpState>,
    session_id: String,
    accept: bool,
    trace_id: Option<String>,
) -> Result<RdpSessionSnapshot, EngineError> {
    log_telemetry(
        TelemetryLevel::Debug,
        "rdp.session.certificate.start",
        trace_id.as_deref(),
        json!({
            "sessionId": session_id,
            "accept": accept,
        }),
    );
    match rdp.decide_certificate(&session_id, accept).await {
        Ok(snapshot) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "rdp.session.certificate.success",
                trace_id.as_deref(),
                json!({
                    "sessionId": snapshot.session_id,
                    "accept": accept,
                    "state": snapshot.state,
                }),
            );
            Ok(snapshot)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "rdp.session.certificate.failed",
                trace_id.as_deref(),
                json!({
                    "sessionId": session_id,
                    "accept": accept,
                    "error": error_payload(&err),
                }),
            );
            Err(err)
        }
    }
}

fn load_profile(
    app: &AppHandle,
    security: &State<'_, SecurityState>,
    profile_id: &str,
) -> Result<RdpProfile, EngineError> {
    let store = read_rdp_profiles(app)?;
    let security_config = read_security_config(app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    let secret_store = SecretStore::new(&crypto);
    let profile = store
        .profiles
        .into_iter()
        .find(|item| item.id == profile_id)
        .ok_or_else(|| EngineError::new("rdp_profile_not_found", "RDP profile not found"))?;
    decrypt_rdp_profile_secrets(profile, &secret_store)
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn error_payload(error: &EngineError) -> serde_json::Value {
    json!({
        "code": &error.code,
        "message": &error.message,
        "detail": &error.detail,
    })
}

fn profile_payload(profile: &RdpProfile) -> serde_json::Value {
    json!({
        "profileId": &profile.id,
        "resolutionMode": &profile.resolution_mode,
        "displayStrategy": &profile.display_strategy,
        "ignoreCertificate": profile.ignore_certificate,
        "tagCount": profile.tags.as_ref().map_or(0, Vec::len),
        "hasPassword": profile.password_ref.is_some(),
    })
}

fn session_payload(snapshot: &RdpSessionSnapshot) -> serde_json::Value {
    json!({
        "sessionId": &snapshot.session_id,
        "profileId": &snapshot.profile_id,
        "state": &snapshot.state,
        "width": snapshot.width,
        "height": snapshot.height,
        "hasWsUrl": snapshot.ws_url.is_some(),
    })
}
