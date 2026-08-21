//! SSH 与 RDP 分类型凭据存储。

pub(crate) const CREDENTIAL_PASSWORD_REQUIRED_CODE: &str = "credential_password_required";

use std::fs;
use std::path::PathBuf;

use engine::EngineError;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config_paths::resolve_credentials_path;
use crate::security::SecretStore;
use crate::utils::write_atomic;

/// 凭据所属协议类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CredentialKind {
    Ssh,
    Rdp,
}

/// 持久化凭据；仅密码字段属于密文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub kind: CredentialKind,
    pub name: String,
    pub username: String,
    pub password_ref: String,
    #[serde(default)]
    pub domain: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 凭据文件结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStore {
    pub version: u32,
    pub updated_at: u64,
    #[serde(default)]
    pub credentials: Vec<Credential>,
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: now_epoch(),
            credentials: Vec::new(),
        }
    }
}

/// 读取凭据文件。
pub fn read_credentials(app: &AppHandle) -> Result<CredentialStore, EngineError> {
    let path = credentials_path(app)?;
    if !path.exists() {
        return Ok(CredentialStore::default());
    }
    let content = fs::read_to_string(path).map_err(|error| {
        EngineError::with_detail(
            "credential_read_failed",
            "Failed to read the credential file",
            error.to_string(),
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        EngineError::with_detail(
            "credential_parse_failed",
            "Failed to parse the credential file",
            error.to_string(),
        )
    })
}

/// 原子写入凭据文件。
pub fn write_credentials(app: &AppHandle, store: &CredentialStore) -> Result<(), EngineError> {
    let content = serde_json::to_string_pretty(store).map_err(|error| {
        EngineError::with_detail(
            "credential_write_failed",
            "Failed to serialize the credential file",
            error.to_string(),
        )
    })?;
    write_atomic(credentials_path(app)?, &content)
}

/// 解密单条凭据密码。
pub fn reveal_credential_password(
    credential: &Credential,
    secret_store: &SecretStore<'_>,
) -> Result<String, EngineError> {
    secret_store
        .reveal_optional_string(Some(credential.password_ref.clone()))?
        .ok_or_else(|| {
            EngineError::new(
                "credential_password_missing",
                "Credential password is missing",
            )
        })
}

/// 将凭据列表中的密码统一解密，用于主密码轮换。
pub fn decrypt_credentials(
    credentials: Vec<Credential>,
    secret_store: &SecretStore<'_>,
) -> Result<Vec<Credential>, EngineError> {
    credentials
        .into_iter()
        .map(|mut credential| {
            credential.password_ref = reveal_credential_password(&credential, secret_store)?;
            Ok(credential)
        })
        .collect()
}

/// 将凭据列表中的密码统一加密，用于保存与主密码轮换。
pub fn encrypt_credentials(
    credentials: Vec<Credential>,
    secret_store: &SecretStore<'_>,
) -> Result<Vec<Credential>, EngineError> {
    credentials
        .into_iter()
        .map(|mut credential| {
            credential.password_ref = secret_store
                .protect_optional_string(Some(credential.password_ref))?
                .ok_or_else(|| {
                    EngineError::new(
                        CREDENTIAL_PASSWORD_REQUIRED_CODE,
                        "Credential password is required",
                    )
                })?;
            Ok(credential)
        })
        .collect()
}

fn credentials_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    resolve_credentials_path(app)
}

pub fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{Credential, CredentialKind, decrypt_credentials, encrypt_credentials};
    use crate::security::{CryptoService, SecretStore};

    fn sample_credential(kind: CredentialKind) -> Credential {
        Credential {
            id: "credential-1".to_string(),
            kind,
            name: "Administrator".to_string(),
            username: "admin".to_string(),
            password_ref: "secret".to_string(),
            domain: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn credential_password_round_trips_with_shared_secret_store() {
        let crypto = CryptoService::embedded();
        let secret_store = SecretStore::new(&crypto);
        let encrypted =
            encrypt_credentials(vec![sample_credential(CredentialKind::Ssh)], &secret_store)
                .expect("credential should encrypt");
        assert!(encrypted[0].password_ref.starts_with("enc:v1:"));

        let decrypted =
            decrypt_credentials(encrypted, &secret_store).expect("credential should decrypt");
        assert_eq!(decrypted[0].password_ref, "secret");
        assert_eq!(decrypted[0].kind, CredentialKind::Ssh);
    }

    #[test]
    fn rdp_domain_is_reserved_and_serializes_as_empty() {
        let credential = sample_credential(CredentialKind::Rdp);
        let value = serde_json::to_value(credential).expect("credential should serialize");
        assert_eq!(value["kind"], "rdp");
        assert!(value["domain"].is_null());
    }
}
