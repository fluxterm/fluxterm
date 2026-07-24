//! RDP profile 与会话命令。

use engine::EngineError;
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

use super::profile::{
    dedupe_groups, normalize_profile_tags, validate_and_dedupe_groups, validate_profile_name,
};

#[tauri::command]
/// 读取 RDP 分组列表。
pub fn rdp_profile_groups_list(
    app: AppHandle,
    _operation_id: String,
) -> Result<Vec<String>, EngineError> {
    read_rdp_groups(&app).map(dedupe_groups)
}

#[tauri::command]
/// 写入 RDP 分组列表。
pub fn rdp_profile_groups_save(
    app: AppHandle,
    groups: Vec<String>,
    _operation_id: String,
) -> Result<Vec<String>, EngineError> {
    validate_and_dedupe_groups(groups).and_then(|next| {
        write_rdp_groups(&app, &next)?;
        Ok(next)
    })
}

#[tauri::command]
/// 读取 RDP Profile 列表。
pub fn rdp_profile_list(
    app: AppHandle,
    security: State<'_, SecurityState>,
    _operation_id: String,
) -> Result<Vec<RdpProfile>, EngineError> {
    let store = read_rdp_profiles(&app)?;
    let security_config = read_security_config(&app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    let secret_store = SecretStore::new(&crypto);

    store
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
        .collect()
}

#[tauri::command]
/// 保存 RDP Profile。
pub fn rdp_profile_save(
    app: AppHandle,
    security: State<'_, SecurityState>,
    mut profile: RdpProfile,
    _operation_id: String,
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
    let encrypted = encrypt_rdp_profile_secrets(profile.clone(), &secret_store)?;
    if let Some(item) = store.profiles.iter_mut().find(|item| item.id == profile.id) {
        *item = encrypted;
    } else {
        store.profiles.push(encrypted);
    }
    store.updated_at = now_epoch();
    write_rdp_profiles(&app, &store)?;
    Ok(saved_profile)
}

#[tauri::command]
/// 删除 RDP Profile。
pub fn rdp_profile_delete(
    app: AppHandle,
    profile_id: String,
    _operation_id: String,
) -> Result<bool, EngineError> {
    let mut store = read_rdp_profiles(&app)?;
    let before = store.profiles.len();
    store.profiles.retain(|item| item.id != profile_id);
    store.updated_at = now_epoch();
    write_rdp_profiles(&app, &store)?;
    Ok(before != store.profiles.len())
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
    _operation_id: String,
) -> Result<RdpSessionSnapshot, EngineError> {
    let profile = load_profile(&app, &security, &profile_id)?;
    rdp.create_session(&profile, width.zip(height)).await
}

#[tauri::command]
/// 启动 RDP 会话桥接。
pub async fn rdp_session_connect(
    rdp: State<'_, RdpState>,
    session_id: String,
    operation_id: String,
) -> Result<RdpSessionSnapshot, EngineError> {
    rdp.connect_session(&session_id, operation_id).await
}

#[tauri::command]
/// 断开 RDP 会话。
pub async fn rdp_session_disconnect(
    rdp: State<'_, RdpState>,
    session_id: String,
    _operation_id: String,
) -> Result<RdpSessionSnapshot, EngineError> {
    rdp.disconnect_session(&session_id).await
}

#[tauri::command]
/// 发送 RDP 输入。
pub async fn rdp_session_send_input(
    rdp: State<'_, RdpState>,
    session_id: String,
    input: RdpInputEvent,
    _operation_id: Option<String>,
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
    _operation_id: String,
) -> Result<RdpSessionSnapshot, EngineError> {
    rdp.resize_session(&session_id, width, height).await
}

#[tauri::command]
/// 设置 RDP 剪贴板内容。
pub async fn rdp_session_set_clipboard(
    rdp: State<'_, RdpState>,
    session_id: String,
    text: String,
    _operation_id: String,
) -> Result<(), EngineError> {
    rdp.set_clipboard(&session_id, text).await
}

#[tauri::command]
/// 设置 RDP 会话静音状态。
pub async fn rdp_session_set_audio_muted(
    rdp: State<'_, RdpState>,
    session_id: String,
    muted: bool,
    _operation_id: String,
) -> Result<(), EngineError> {
    rdp.set_audio_muted(&session_id, muted).await
}

#[tauri::command]
/// 响应 RDP 证书确认。
pub async fn rdp_session_cert_decide(
    rdp: State<'_, RdpState>,
    session_id: String,
    accept: bool,
    _operation_id: String,
) -> Result<RdpSessionSnapshot, EngineError> {
    rdp.decide_certificate(&session_id, accept).await
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
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}
