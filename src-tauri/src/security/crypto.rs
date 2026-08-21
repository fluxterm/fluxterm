//! 统一 Crypto 门面。

const CRYPTO_PROVIDER_INVALID_CODE: &str = "crypto_provider_invalid";
const SECRET_FORMAT_INVALID_CODE: &str = "secret_format_invalid";

use std::sync::Arc;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use engine::EngineError;
use rand::random;
use uuid::Uuid;

use crate::security::provider::EncryptionProvider;
use crate::security::providers::{EmbeddedProvider, UserPasswordProvider};
use crate::security::types::{
    EncryptedPayload, EncryptionAlgorithm, EncryptionProviderKind, ProviderCiphertext,
    SecurityStatus,
};
use crate::security_store::SecretConfig;
use crate::state::UnlockedSecretSession;

/// 统一的加密服务入口。
pub struct CryptoService {
    provider_kind: EncryptionProviderKind,
    key_id: String,
    provider: Option<Arc<dyn EncryptionProvider>>,
    locked: bool,
}

const SECRET_TOKEN_PREFIX: &str = "enc:v1:";
const EMBEDDED_KEY_ID: &str = "embedded-v1";
const USER_PASSWORD_SALT_LEN: usize = 16;
const USER_PASSWORD_DERIVED_LEN: usize = 64;

impl CryptoService {
    /// 根据当前 secret 配置选择 provider。
    pub fn new(
        config: Option<&SecretConfig>,
        session: Option<&UnlockedSecretSession>,
    ) -> Result<Self, EngineError> {
        let provider_name = config
            .map(|item| item.provider.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "embedded".to_string());
        match provider_name.as_str() {
            "embedded" | "" => {
                let provider = Arc::new(EmbeddedProvider::new());
                Ok(Self {
                    provider_kind: EncryptionProviderKind::Embedded,
                    key_id: provider.key_id().to_string(),
                    provider: Some(provider),
                    locked: false,
                })
            }
            "user_password" => {
                let key_id = config
                    .and_then(|item| item.active_key_id.clone())
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        EngineError::new(
                            CRYPTO_PROVIDER_INVALID_CODE,
                            "Master password config is missing keyId",
                        )
                    })?;
                let Some(session) = session.filter(|item| item.key_id == key_id) else {
                    return Ok(Self {
                        provider_kind: EncryptionProviderKind::UserPassword,
                        key_id,
                        provider: None,
                        locked: true,
                    });
                };
                Ok(Self {
                    provider_kind: EncryptionProviderKind::UserPassword,
                    key_id: key_id.clone(),
                    provider: Some(Arc::new(UserPasswordProvider::new(
                        key_id,
                        session.encryption_key,
                    ))),
                    locked: false,
                })
            }
            _ => Err(EngineError::new(
                CRYPTO_PROVIDER_INVALID_CODE,
                "Secret config is invalid or from an unsupported legacy version",
            )),
        }
    }

    /// 构造默认弱保护模式服务。
    pub fn embedded() -> Self {
        let provider = Arc::new(EmbeddedProvider::new());
        Self {
            provider_kind: EncryptionProviderKind::Embedded,
            key_id: provider.key_id().to_string(),
            provider: Some(provider),
            locked: false,
        }
    }

    /// 构造默认弱保护模式配置。
    pub fn build_embedded_config() -> SecretConfig {
        SecretConfig {
            version: 1,
            provider: "embedded".to_string(),
            active_key_id: Some(EMBEDDED_KEY_ID.to_string()),
            kdf_salt: None,
            verify_hash: None,
        }
    }

    /// 基于主密码创建新的强保护配置与解锁会话。
    pub fn build_user_password_config(
        password: &str,
    ) -> Result<(SecretConfig, UnlockedSecretSession), EngineError> {
        let normalized = password.trim();
        if normalized.chars().count() < 4 {
            return Err(EngineError::new(
                "security_password_too_short",
                "Security password must be at least 4 characters",
            )
            .with_message_key("error.securityPasswordTooShort"));
        }
        let salt: [u8; USER_PASSWORD_SALT_LEN] = random();
        let key_id = format!("master-{}", Uuid::new_v4());
        let derived = derive_password_material(normalized, &salt)?;
        let mut encryption_key = [0_u8; 32];
        encryption_key.copy_from_slice(&derived[..32]);
        let verify_hash = BASE64.encode(&derived[32..]);
        Ok((
            SecretConfig {
                version: 1,
                provider: "user_password".to_string(),
                active_key_id: Some(key_id.clone()),
                kdf_salt: Some(BASE64.encode(salt)),
                verify_hash: Some(verify_hash),
            },
            UnlockedSecretSession {
                key_id,
                encryption_key,
            },
        ))
    }

    /// 使用用户输入的主密码解锁现有配置。
    pub fn unlock_user_password(
        config: &SecretConfig,
        password: &str,
    ) -> Result<UnlockedSecretSession, EngineError> {
        let key_id = config
            .active_key_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                EngineError::new(
                    CRYPTO_PROVIDER_INVALID_CODE,
                    "Master password config is missing keyId",
                )
            })?;
        let salt_b64 = config.kdf_salt.as_deref().ok_or_else(|| {
            EngineError::new(
                CRYPTO_PROVIDER_INVALID_CODE,
                "Master password config is missing kdfSalt",
            )
        })?;
        let verify_hash = config.verify_hash.as_deref().ok_or_else(|| {
            EngineError::new(
                CRYPTO_PROVIDER_INVALID_CODE,
                "Master password config is missing verifyHash",
            )
        })?;
        let salt = BASE64.decode(salt_b64).map_err(|err| {
            EngineError::with_detail(
                CRYPTO_PROVIDER_INVALID_CODE,
                "Master password config is invalid",
                err.to_string(),
            )
        })?;
        let derived = derive_password_material(password.trim(), &salt)?;
        let expected_verify = BASE64.encode(&derived[32..]);
        if expected_verify != verify_hash {
            return Err(EngineError::new(
                "security_password_invalid",
                "Security password is incorrect",
            )
            .with_message_key("error.securityPasswordInvalid"));
        }
        let mut encryption_key = [0_u8; 32];
        encryption_key.copy_from_slice(&derived[..32]);
        Ok(UnlockedSecretSession {
            key_id,
            encryption_key,
        })
    }

    /// 当前仅支持弱保护和强保护，两者都启用加密。
    pub fn encryption_enabled(&self) -> bool {
        true
    }

    /// 对输入字符串执行加密并返回结构化密文字符串。
    pub fn encrypt_string(&self, plaintext: &str) -> Result<String, EngineError> {
        let provider = self.require_provider_for_encryption()?;
        let payload = provider.encrypt(plaintext.as_bytes())?;
        let serialized = EncryptedPayload {
            provider: provider.kind(),
            algorithm: payload.algorithm,
            key_id: provider.key_id().to_string(),
            nonce: BASE64.encode(payload.nonce),
            ciphertext: BASE64.encode(payload.ciphertext),
        };
        let payload_json = serde_json::to_vec(&serialized).map_err(|err| {
            EngineError::with_detail(
                "secret_serialize_failed",
                "Failed to serialize encrypted payload",
                err.to_string(),
            )
        })?;
        Ok(format!(
            "{}{}",
            SECRET_TOKEN_PREFIX,
            BASE64.encode(payload_json)
        ))
    }

    /// 对结构化密文字符串执行解密。
    pub fn decrypt_string(&self, serialized: &str) -> Result<String, EngineError> {
        let provider = self.require_provider_for_decryption()?;
        let payload_token = serialized
            .strip_prefix(SECRET_TOKEN_PREFIX)
            .ok_or_else(|| {
                EngineError::new(
                    crate::security::SECRET_FORMAT_UNSUPPORTED_CODE,
                    "Unsupported secret format: only enc:v1 payloads are accepted",
                )
            })?;
        let payload_bytes = BASE64.decode(payload_token).map_err(|err| {
            EngineError::with_detail(
                SECRET_FORMAT_INVALID_CODE,
                "Invalid secret format: enc:v1 payload is not valid Base64",
                err.to_string(),
            )
        })?;
        let payload: EncryptedPayload = serde_json::from_slice(&payload_bytes).map_err(|err| {
            EngineError::with_detail(
                SECRET_FORMAT_INVALID_CODE,
                "Invalid secret format: enc:v1 payload is not valid JSON",
                err.to_string(),
            )
        })?;
        if payload.algorithm != EncryptionAlgorithm::Aes256Gcm {
            return Err(EngineError::new(
                "secret_algorithm_unsupported",
                "Unsupported encryption algorithm",
            ));
        }
        if payload.provider != provider.kind() || payload.key_id != provider.key_id() {
            return Err(EngineError::new(
                "secret_provider_mismatch",
                "The current security mode cannot decrypt this secret",
            ));
        }
        let nonce = BASE64.decode(payload.nonce).map_err(|err| {
            EngineError::with_detail(
                SECRET_FORMAT_INVALID_CODE,
                "Invalid secret format",
                err.to_string(),
            )
        })?;
        let ciphertext = BASE64.decode(payload.ciphertext).map_err(|err| {
            EngineError::with_detail(
                SECRET_FORMAT_INVALID_CODE,
                "Invalid secret format",
                err.to_string(),
            )
        })?;
        let plaintext = provider.decrypt(&ProviderCiphertext {
            algorithm: payload.algorithm,
            nonce,
            ciphertext,
        })?;
        String::from_utf8(plaintext).map_err(|err| {
            EngineError::with_detail(
                crate::security::SECRET_DECRYPT_FAILED_CODE,
                "Decrypted secret is not valid UTF-8",
                err.to_string(),
            )
        })
    }

    /// 返回当前安全服务状态。
    pub fn status(&self) -> SecurityStatus {
        if let Some(provider) = &self.provider {
            return provider.status();
        }
        SecurityStatus {
            provider: self.provider_kind.clone(),
            locked: self.locked,
            encryption_enabled: self.encryption_enabled(),
        }
    }

    /// 返回当前 Provider 类型。
    pub fn provider_kind(&self) -> EncryptionProviderKind {
        self.provider_kind.clone()
    }

    /// 返回当前 key 标识。
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    fn require_provider_for_encryption(&self) -> Result<&Arc<dyn EncryptionProvider>, EngineError> {
        self.provider.as_ref().ok_or_else(|| {
            EngineError::new(
                crate::security::SECURITY_LOCKED_CODE,
                "Security data is locked. Unlock it with the security password first.",
            )
            .with_message_key("error.securityLocked")
        })
    }

    fn require_provider_for_decryption(&self) -> Result<&Arc<dyn EncryptionProvider>, EngineError> {
        self.provider.as_ref().ok_or_else(|| {
            EngineError::new(
                crate::security::SECURITY_LOCKED_CODE,
                "Security data is locked. Unlock it with the security password first.",
            )
            .with_message_key("error.securityLocked")
        })
    }
}

fn derive_password_material(
    password: &str,
    salt: &[u8],
) -> Result<[u8; USER_PASSWORD_DERIVED_LEN], EngineError> {
    if password.is_empty() {
        return Err(EngineError::new(
            "security_password_required",
            "Security password is required",
        ));
    }
    let params = Params::new(64 * 1024, 3, 1, Some(USER_PASSWORD_DERIVED_LEN)).map_err(|err| {
        EngineError::with_detail(
            crate::security::CRYPTO_INIT_FAILED_CODE,
            "Failed to initialize password derivation parameters",
            err.to_string(),
        )
    })?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = [0_u8; USER_PASSWORD_DERIVED_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut output)
        .map_err(|err| {
            EngineError::with_detail(
                crate::security::CRYPTO_INIT_FAILED_CODE,
                "Failed to derive master password key material",
                err.to_string(),
            )
        })?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{CryptoService, SECRET_TOKEN_PREFIX};
    use crate::security_store::SecretConfig;

    #[test]
    fn embedded_mode_encrypts_and_decrypts_roundtrip() {
        let crypto = CryptoService::embedded();
        let encrypted = crypto.encrypt_string("secret-value").expect("encrypt");
        assert_ne!(encrypted, "secret-value");
        let decrypted = crypto.decrypt_string(&encrypted).expect("decrypt");
        assert_eq!(decrypted, "secret-value");
        assert_eq!(
            crypto.provider_kind(),
            crate::security::EncryptionProviderKind::Embedded
        );
    }

    #[test]
    fn user_password_mode_encrypts_and_decrypts_roundtrip() {
        let (config, session) =
            CryptoService::build_user_password_config("security-pass").expect("config");
        let crypto = CryptoService::new(Some(&config), Some(&session)).expect("crypto service");
        let encrypted = crypto.encrypt_string("secret-value").expect("encrypt");
        assert_ne!(encrypted, "secret-value");
        let decrypted = crypto.decrypt_string(&encrypted).expect("decrypt");
        assert_eq!(decrypted, "secret-value");
    }

    #[test]
    fn crypto_service_emits_enc_v1_token() {
        let (config, session) =
            CryptoService::build_user_password_config("security-pass").expect("config");
        let crypto = CryptoService::new(Some(&config), Some(&session)).expect("crypto service");
        let encrypted = crypto.encrypt_string("secret-value").expect("encrypt");
        assert!(encrypted.starts_with(SECRET_TOKEN_PREFIX));
    }

    #[test]
    fn unlock_rejects_invalid_password() {
        let (config, _) =
            CryptoService::build_user_password_config("security-pass").expect("config");
        let result = CryptoService::unlock_user_password(&config, "wrong-pass");
        assert!(result.is_err());
    }

    #[test]
    fn unsupported_provider_is_rejected() {
        let config = SecretConfig {
            version: 1,
            provider: "plaintext".to_string(),
            active_key_id: None,
            kdf_salt: None,
            verify_hash: None,
        };
        let result = CryptoService::new(Some(&config), None);
        assert!(result.is_err());
    }
}
