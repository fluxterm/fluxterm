//! HostProfile 敏感字段编解码。

use fluxterm_engine::{EngineError, HostProfile};

use crate::rdp::RdpProfile;
use crate::security::SecretStore;

/// 对 HostProfile 中的敏感字段执行统一加密。
pub fn encrypt_profile_secrets(
    mut profile: HostProfile,
    secret_store: &SecretStore<'_>,
) -> Result<HostProfile, EngineError> {
    profile.password_ref = secret_store.protect_optional_string(profile.password_ref)?;
    profile.private_key_passphrase_ref =
        secret_store.protect_optional_string(profile.private_key_passphrase_ref)?;
    if let Some(proxy_config) = profile.proxy_config.as_mut() {
        proxy_config.password_ref =
            secret_store.protect_optional_string(proxy_config.password_ref.take())?;
    }
    Ok(profile)
}

/// 对 HostProfile 中的敏感字段执行统一解密。
pub fn decrypt_profile_secrets(
    mut profile: HostProfile,
    secret_store: &SecretStore<'_>,
) -> Result<HostProfile, EngineError> {
    profile.password_ref = secret_store.reveal_optional_string(profile.password_ref)?;
    profile.private_key_passphrase_ref =
        secret_store.reveal_optional_string(profile.private_key_passphrase_ref)?;
    if let Some(proxy_config) = profile.proxy_config.as_mut() {
        proxy_config.password_ref =
            secret_store.reveal_optional_string(proxy_config.password_ref.take())?;
    }
    Ok(profile)
}

/// 对 RdpProfile 中的敏感字段执行统一加密。
pub fn encrypt_rdp_profile_secrets(
    mut profile: RdpProfile,
    secret_store: &SecretStore<'_>,
) -> Result<RdpProfile, EngineError> {
    profile.password_ref = secret_store.protect_optional_string(profile.password_ref)?;
    Ok(profile)
}

/// 对 RdpProfile 中的敏感字段执行统一解密。
pub fn decrypt_rdp_profile_secrets(
    mut profile: RdpProfile,
    secret_store: &SecretStore<'_>,
) -> Result<RdpProfile, EngineError> {
    profile.password_ref = secret_store.reveal_optional_string(profile.password_ref)?;
    Ok(profile)
}
