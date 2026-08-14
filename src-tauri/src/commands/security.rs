//! 安全状态与保护模式命令。

use engine::{EngineError, HostProfile};
use tauri::{AppHandle, State};

use crate::ai_settings::{AiSettings, read_ai_settings, write_ai_settings};
use crate::credential_store::{
    Credential, CredentialStore, decrypt_credentials, encrypt_credentials, read_credentials,
    write_credentials,
};
use crate::profile_secrets::{
    decrypt_profile_secrets, decrypt_rdp_profile_secrets, encrypt_profile_secrets,
    encrypt_rdp_profile_secrets,
};
use crate::rdp::RdpProfile;
use crate::rdp_profile_store::{RdpProfileStore, read_rdp_profiles, write_rdp_profiles};
use crate::security::{CryptoService, SecretStore, SecurityStatus};
use crate::security_store::{read_security_config, write_security_config};
use crate::ssh_profile_store::{SshProfileStore, read_ssh_profiles, write_ssh_profiles};
use crate::state::SecurityState;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityPasswordInput {
    pub password: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityPasswordChangeInput {
    pub current_password: String,
    pub next_password: String,
}

/// 返回当前安全服务状态。
#[tauri::command]
pub fn security_status(
    app: AppHandle,
    security: State<'_, SecurityState>,
) -> Result<SecurityStatus, EngineError> {
    let security_config = read_security_config(&app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    Ok(crypto.status())
}

/// 使用当前安全密码解锁强保护模式数据。
#[tauri::command]
pub fn security_unlock(
    app: AppHandle,
    security: State<'_, SecurityState>,
    input: SecurityPasswordInput,
) -> Result<SecurityStatus, EngineError> {
    let security_config = read_security_config(&app)?;
    let config = security_config.as_ref().ok_or_else(|| {
        EngineError::new("security_mode_invalid", "Security mode is not configured")
    })?;
    let provider = config.provider.trim().to_ascii_lowercase();
    if provider != "user_password" {
        return Err(EngineError::new(
            "security_unlock_unavailable",
            "Strong protection mode is not enabled",
        ));
    }
    let session = CryptoService::unlock_user_password(config, &input.password)?;
    security.set_session(session);
    security_status(app, security)
}

/// 清除当前内存中的已解锁主密码。
#[tauri::command]
pub fn security_lock(
    app: AppHandle,
    security: State<'_, SecurityState>,
) -> Result<SecurityStatus, EngineError> {
    let security_config = read_security_config(&app)?;
    let provider = security_config
        .as_ref()
        .map(|config| config.provider.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "embedded".to_string());
    if provider != "user_password" {
        return Err(EngineError::new(
            "security_unlock_unavailable",
            "Strong protection mode is not enabled",
        ));
    }
    security.clear_session();
    security_status(app, security)
}

/// 从弱保护模式切换到强保护模式，并对现有敏感字段统一重加密。
#[tauri::command]
pub fn security_enable_strong_protection(
    app: AppHandle,
    security: State<'_, SecurityState>,
    input: SecurityPasswordInput,
) -> Result<SecurityStatus, EngineError> {
    let mut ssh_store = read_ssh_profiles(&app)?;
    let mut rdp_store = read_rdp_profiles(&app)?;
    let mut credential_store = read_credentials(&app)?;
    let current_config = read_security_config(&app)?;
    let current_session = security.current_session();
    let current_crypto = CryptoService::new(current_config.as_ref(), current_session.as_ref())?;
    if current_crypto.provider_kind() != crate::security::EncryptionProviderKind::Embedded {
        return Err(EngineError::new(
            "security_enable_unavailable",
            "Strong protection mode is already enabled",
        ));
    }

    let ssh_profiles_plain = decrypt_ssh_profiles(&ssh_store, &current_crypto)?;
    let rdp_profiles_plain = decrypt_rdp_profiles(&rdp_store, &current_crypto)?;
    let credentials_plain = decrypt_credential_store(&credential_store, &current_crypto)?;
    let ai_plain = decrypt_ai_settings(&app, &current_crypto)?;
    let (next_config, next_session) = CryptoService::build_user_password_config(&input.password)?;
    let next_crypto = CryptoService::new(Some(&next_config), Some(&next_session))?;

    ssh_store.profiles = encrypt_ssh_profiles(ssh_profiles_plain, &next_crypto)?;
    ssh_store.updated_at = now_epoch();
    rdp_store.profiles = encrypt_rdp_profiles(rdp_profiles_plain, &next_crypto)?;
    rdp_store.updated_at = now_epoch();
    credential_store.credentials = encrypt_credential_store(credentials_plain, &next_crypto)?;
    credential_store.updated_at = now_epoch();
    write_ssh_profiles(&app, &ssh_store)?;
    write_rdp_profiles(&app, &rdp_store)?;
    write_credentials(&app, &credential_store)?;
    write_security_config(&app, &next_config)?;
    write_ai_settings(&app, encrypt_ai_settings(ai_plain, &next_crypto)?)?;
    security.set_session(next_session);
    security_status(app, security)
}

/// 修改当前强保护模式的主密码，并对现有密文执行重加密。
#[tauri::command]
pub fn security_change_password(
    app: AppHandle,
    security: State<'_, SecurityState>,
    input: SecurityPasswordChangeInput,
) -> Result<SecurityStatus, EngineError> {
    let mut ssh_store = read_ssh_profiles(&app)?;
    let mut rdp_store = read_rdp_profiles(&app)?;
    let mut credential_store = read_credentials(&app)?;
    let current_config = read_security_config(&app)?;
    let config = current_config.as_ref().ok_or_else(|| {
        EngineError::new("security_mode_invalid", "Security mode is not configured")
    })?;
    if !config.provider.trim().eq_ignore_ascii_case("user_password") {
        return Err(EngineError::new(
            "security_change_unavailable",
            "Strong protection mode is not enabled",
        ));
    }

    let current_session = CryptoService::unlock_user_password(config, &input.current_password)?;
    let current_crypto = CryptoService::new(current_config.as_ref(), Some(&current_session))?;
    let ssh_profiles_plain = decrypt_ssh_profiles(&ssh_store, &current_crypto)?;
    let rdp_profiles_plain = decrypt_rdp_profiles(&rdp_store, &current_crypto)?;
    let credentials_plain = decrypt_credential_store(&credential_store, &current_crypto)?;
    let ai_plain = decrypt_ai_settings(&app, &current_crypto)?;
    let (next_config, next_session) =
        CryptoService::build_user_password_config(&input.next_password)?;
    let next_crypto = CryptoService::new(Some(&next_config), Some(&next_session))?;

    ssh_store.profiles = encrypt_ssh_profiles(ssh_profiles_plain, &next_crypto)?;
    ssh_store.updated_at = now_epoch();
    rdp_store.profiles = encrypt_rdp_profiles(rdp_profiles_plain, &next_crypto)?;
    rdp_store.updated_at = now_epoch();
    credential_store.credentials = encrypt_credential_store(credentials_plain, &next_crypto)?;
    credential_store.updated_at = now_epoch();
    write_ssh_profiles(&app, &ssh_store)?;
    write_rdp_profiles(&app, &rdp_store)?;
    write_credentials(&app, &credential_store)?;
    write_security_config(&app, &next_config)?;
    write_ai_settings(&app, encrypt_ai_settings(ai_plain, &next_crypto)?)?;
    security.set_session(next_session);
    security_status(app, security)
}

/// 从强保护模式切换回弱保护模式，并使用内置密钥重新加密敏感字段。
#[tauri::command]
pub fn security_enable_weak_protection(
    app: AppHandle,
    security: State<'_, SecurityState>,
) -> Result<SecurityStatus, EngineError> {
    let mut ssh_store = read_ssh_profiles(&app)?;
    let mut rdp_store = read_rdp_profiles(&app)?;
    let mut credential_store = read_credentials(&app)?;
    let current_config = read_security_config(&app)?;
    let current_session = security.current_session();
    let current_crypto = CryptoService::new(current_config.as_ref(), current_session.as_ref())?;
    if current_crypto.provider_kind() == crate::security::EncryptionProviderKind::UserPassword
        && current_session.is_none()
    {
        return Err(EngineError::new(
            "security_locked",
            "Security data is locked",
        ));
    }
    if current_crypto.provider_kind() == crate::security::EncryptionProviderKind::Embedded {
        return Err(EngineError::new(
            "security_enable_unavailable",
            "Weak protection mode is already enabled",
        ));
    }

    let ssh_profiles_plain = decrypt_ssh_profiles(&ssh_store, &current_crypto)?;
    let rdp_profiles_plain = decrypt_rdp_profiles(&rdp_store, &current_crypto)?;
    let credentials_plain = decrypt_credential_store(&credential_store, &current_crypto)?;
    let ai_plain = decrypt_ai_settings(&app, &current_crypto)?;
    let weak_config = CryptoService::build_embedded_config();
    let weak_crypto = CryptoService::embedded();

    ssh_store.profiles = encrypt_ssh_profiles(ssh_profiles_plain, &weak_crypto)?;
    ssh_store.updated_at = now_epoch();
    rdp_store.profiles = encrypt_rdp_profiles(rdp_profiles_plain, &weak_crypto)?;
    rdp_store.updated_at = now_epoch();
    credential_store.credentials = encrypt_credential_store(credentials_plain, &weak_crypto)?;
    credential_store.updated_at = now_epoch();
    write_ssh_profiles(&app, &ssh_store)?;
    write_rdp_profiles(&app, &rdp_store)?;
    write_credentials(&app, &credential_store)?;
    write_security_config(&app, &weak_config)?;
    write_ai_settings(&app, encrypt_ai_settings(ai_plain, &weak_crypto)?)?;
    security.clear_session();
    security_status(app, security)
}

fn decrypt_ssh_profiles(
    store: &SshProfileStore,
    crypto: &CryptoService,
) -> Result<Vec<HostProfile>, EngineError> {
    let secret_store = SecretStore::new(crypto);
    store
        .profiles
        .clone()
        .into_iter()
        .map(|profile| decrypt_profile_secrets(profile, &secret_store))
        .collect()
}

fn encrypt_ssh_profiles(
    profiles: Vec<HostProfile>,
    crypto: &CryptoService,
) -> Result<Vec<HostProfile>, EngineError> {
    let secret_store = SecretStore::new(crypto);
    profiles
        .into_iter()
        .map(|profile| encrypt_profile_secrets(profile, &secret_store))
        .collect()
}

fn decrypt_rdp_profiles(
    store: &RdpProfileStore,
    crypto: &CryptoService,
) -> Result<Vec<RdpProfile>, EngineError> {
    let secret_store = SecretStore::new(crypto);
    store
        .profiles
        .clone()
        .into_iter()
        .map(|profile| decrypt_rdp_profile_secrets(profile, &secret_store))
        .collect()
}

fn encrypt_rdp_profiles(
    profiles: Vec<RdpProfile>,
    crypto: &CryptoService,
) -> Result<Vec<RdpProfile>, EngineError> {
    let secret_store = SecretStore::new(crypto);
    profiles
        .into_iter()
        .map(|profile| encrypt_rdp_profile_secrets(profile, &secret_store))
        .collect()
}

fn decrypt_credential_store(
    store: &CredentialStore,
    crypto: &CryptoService,
) -> Result<Vec<Credential>, EngineError> {
    decrypt_credentials(store.credentials.clone(), &SecretStore::new(crypto))
}

fn encrypt_credential_store(
    credentials: Vec<Credential>,
    crypto: &CryptoService,
) -> Result<Vec<Credential>, EngineError> {
    encrypt_credentials(credentials, &SecretStore::new(crypto))
}

fn decrypt_ai_settings(app: &AppHandle, crypto: &CryptoService) -> Result<AiSettings, EngineError> {
    let mut settings = read_ai_settings(app)?;
    let secret_store = SecretStore::new(crypto);
    for provider in &mut settings.providers {
        provider.api_key_ref = secret_store.reveal_optional_string(provider.api_key_ref.take())?;
    }
    Ok(settings)
}

fn encrypt_ai_settings(
    mut settings: AiSettings,
    crypto: &CryptoService,
) -> Result<AiSettings, EngineError> {
    let secret_store = SecretStore::new(crypto);
    for provider in &mut settings.providers {
        provider.api_key_ref = secret_store.protect_optional_string(provider.api_key_ref.take())?;
    }
    Ok(settings)
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
