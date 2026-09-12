//! 安全存储启动初始化。

use std::collections::HashSet;

use fluxterm_engine::EngineError;
use tauri::AppHandle;

use crate::ai_settings::{AiSettings, read_ai_settings};
use crate::config_key_store::{
    CONFIG_KEY_MISMATCH_CODE, CONFIG_KEY_MISSING_CODE, ConfigKey, create_config_key,
    read_config_key,
};
use crate::credential_store::{CredentialStore, read_credentials};
use crate::rdp_profile_store::{RdpProfileStore, read_rdp_profiles};
use crate::security::{CRYPTO_PROVIDER_INVALID_CODE, CryptoService};
use crate::security_store::{SecretConfig, read_security_config, write_security_config};
use crate::ssh_profile_store::{SshProfileStore, read_ssh_profiles};

/// 初始化并校验当前配置目录的安全存储。
pub fn initialize_security_storage(app: &AppHandle) -> Result<(), EngineError> {
    let security_config = read_security_config(app)?;
    let provider_name = security_config
        .as_ref()
        .map(|config| config.provider.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "embedded".to_string());
    if provider_name != "embedded" && !provider_name.is_empty() && provider_name != "user_password"
    {
        return Err(EngineError::new(
            CRYPTO_PROVIDER_INVALID_CODE,
            "Secret config is invalid or uses an unsupported version",
        ));
    }

    let stored_config_key = read_config_key(app)?;
    if provider_name == "user_password" {
        if stored_config_key.is_none() {
            create_config_key(app)?;
        }
        return Ok(());
    }

    let configured_key_id = security_config
        .as_ref()
        .and_then(|config| config.active_key_id.as_deref())
        .map(str::trim);
    if configured_key_id.is_some_and(|key_id| key_id.starts_with("config-")) {
        let stored = stored_config_key.ok_or_else(|| {
            EngineError::new(
                CONFIG_KEY_MISSING_CODE,
                "The configuration key file is missing",
            )
        })?;
        if configured_key_id != Some(stored.key_id.as_str()) {
            return Err(EngineError::new(
                CONFIG_KEY_MISMATCH_CODE,
                "The configuration key does not match the active key id",
            ));
        }
        return Ok(());
    }

    let ssh_store = read_ssh_profiles(app)?;
    let rdp_store = read_rdp_profiles(app)?;
    let credential_store = read_credentials(app)?;
    let ai_settings = read_ai_settings(app)?;
    let encrypted_key_ids =
        collect_encrypted_key_ids(&ssh_store, &rdp_store, &credential_store, &ai_settings)?;
    let config_key = resolve_startup_config_key(
        app,
        stored_config_key,
        security_config.as_ref(),
        &encrypted_key_ids,
    )?;
    if configured_key_id != Some(config_key.key_id.as_str()) {
        write_security_config(
            app,
            &CryptoService::build_embedded_config(&config_key.key_id),
        )?;
    }
    Ok(())
}

fn resolve_startup_config_key(
    app: &AppHandle,
    stored: Option<ConfigKey>,
    security_config: Option<&SecretConfig>,
    encrypted_key_ids: &HashSet<String>,
) -> Result<ConfigKey, EngineError> {
    match validate_config_key_state(stored, security_config, encrypted_key_ids)? {
        Some(stored) => Ok(stored),
        None => create_config_key(app),
    }
}

fn validate_config_key_state(
    stored: Option<ConfigKey>,
    security_config: Option<&SecretConfig>,
    encrypted_key_ids: &HashSet<String>,
) -> Result<Option<ConfigKey>, EngineError> {
    let encrypted_config_key_id = encrypted_key_ids
        .iter()
        .find(|key_id| key_id.starts_with("config-"));
    let configured_key_id = security_config
        .and_then(|config| config.active_key_id.as_deref())
        .map(str::trim)
        .filter(|key_id| key_id.starts_with("config-"));

    let Some(stored) = stored else {
        if encrypted_config_key_id.is_some() || configured_key_id.is_some() {
            return Err(EngineError::new(
                CONFIG_KEY_MISSING_CODE,
                "The configuration key file is missing",
            ));
        }
        return Ok(None);
    };
    if configured_key_id.is_some_and(|key_id| key_id != stored.key_id)
        || encrypted_config_key_id.is_some_and(|key_id| key_id != &stored.key_id)
        || encrypted_key_ids
            .iter()
            .any(|key_id| key_id.starts_with("config-") && key_id != &stored.key_id)
    {
        return Err(EngineError::new(
            CONFIG_KEY_MISMATCH_CODE,
            "The configuration key does not match encrypted data",
        ));
    }
    Ok(Some(stored))
}

fn collect_encrypted_key_ids(
    ssh_store: &SshProfileStore,
    rdp_store: &RdpProfileStore,
    credential_store: &CredentialStore,
    ai_settings: &AiSettings,
) -> Result<HashSet<String>, EngineError> {
    let mut values = Vec::new();
    for profile in &ssh_store.profiles {
        values.extend(profile.password_ref.iter().map(String::as_str));
        values.extend(
            profile
                .private_key_passphrase_ref
                .iter()
                .map(String::as_str),
        );
        if let Some(proxy) = &profile.proxy_config {
            values.extend(proxy.password_ref.iter().map(String::as_str));
        }
    }
    for profile in &rdp_store.profiles {
        values.extend(profile.password_ref.iter().map(String::as_str));
    }
    values.extend(
        credential_store
            .credentials
            .iter()
            .map(|credential| credential.password_ref.as_str()),
    );
    for provider in &ai_settings.providers {
        values.extend(provider.api_key_ref.iter().map(String::as_str));
    }

    values
        .into_iter()
        .filter_map(
            |value| match CryptoService::encrypted_payload_key_id(value) {
                Ok(Some(key_id)) => Some(Ok(key_id)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::validate_config_key_state;
    use crate::config_key_store::ConfigKey;
    use crate::security_store::SecretConfig;

    fn config_key(key_id: &str) -> ConfigKey {
        ConfigKey {
            key_id: key_id.to_string(),
            key_material: [7_u8; 32],
        }
    }

    fn embedded_config(key_id: &str) -> SecretConfig {
        SecretConfig {
            version: 1,
            provider: "embedded".to_string(),
            active_key_id: Some(key_id.to_string()),
            kdf_salt: None,
            verify_hash: None,
        }
    }

    #[test]
    fn missing_key_is_rejected_when_configuration_ciphertext_exists() {
        let encrypted_key_ids = HashSet::from(["config-existing".to_string()]);
        let result = validate_config_key_state(None, None, &encrypted_key_ids);
        assert_eq!(
            result.expect_err("missing key should fail").code,
            "config_key_missing"
        );
    }

    #[test]
    fn mismatched_key_is_rejected_without_overwriting_stored_key() {
        let stored = config_key("config-stored");
        let config = embedded_config("config-other");
        let result = validate_config_key_state(Some(stored), Some(&config), &HashSet::new());
        assert_eq!(
            result.expect_err("mismatched key should fail").code,
            "config_key_mismatch"
        );
    }

    #[test]
    fn unrelated_provider_ciphertext_does_not_block_config_key_creation() {
        let config = embedded_config("retired-provider-key");
        let encrypted_key_ids = HashSet::from(["retired-provider-key".to_string()]);
        let result = validate_config_key_state(None, Some(&config), &encrypted_key_ids)
            .expect("unrelated provider data should not block key creation");
        assert!(result.is_none());
    }
}
