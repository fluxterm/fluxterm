//! 分类型密码管理器命令。

const CREDENTIAL_NOT_FOUND_CODE: &str = "credential_not_found";

use fluxterm_engine::EngineError;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::credential_store::{
    Credential, CredentialKind, now_epoch, read_credentials, reveal_credential_password,
    write_credentials,
};
use crate::rdp_profile_store::{read_rdp_profiles, write_rdp_profiles};
use crate::security::{CryptoService, SecretStore};
use crate::security_store::read_security_config;
use crate::ssh_profile_store::{read_ssh_profiles, write_ssh_profiles};
use crate::state::SecurityState;

/// 凭据列表摘要，禁止包含密码。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub kind: CredentialKind,
    pub name: String,
    pub username: String,
    pub domain: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 新建或更新凭据的输入。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSaveInput {
    #[serde(default)]
    pub id: String,
    pub kind: CredentialKind,
    pub name: String,
    pub username: String,
    pub password: Option<String>,
}

/// 显式复制凭据时返回的临时明文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialCopyValue {
    pub username: String,
    pub password: String,
}

/// 删除凭据输入。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialDeleteInput {
    pub credential_id: String,
    #[serde(default)]
    pub detach_references: bool,
}

#[tauri::command]
/// 按协议类型读取不含密码的凭据列表。
pub fn credential_list(
    app: AppHandle,
    kind: CredentialKind,
) -> Result<Vec<CredentialSummary>, EngineError> {
    let store = read_credentials(&app)?;
    Ok(store
        .credentials
        .into_iter()
        .filter(|credential| credential.kind == kind)
        .map(|credential| CredentialSummary {
            id: credential.id,
            kind: credential.kind,
            name: credential.name,
            username: credential.username,
            domain: credential.domain,
            created_at: credential.created_at,
            updated_at: credential.updated_at,
        })
        .collect())
}

#[tauri::command]
/// 新建或更新凭据；类型创建后不可修改。
pub fn credential_save(
    app: AppHandle,
    security: State<'_, SecurityState>,
    input: CredentialSaveInput,
) -> Result<CredentialSummary, EngineError> {
    let mut store = read_credentials(&app)?;
    let name = required_trimmed(
        input.name,
        "credential_name_required",
        "Credential name is required",
    )?;
    let username = required_trimmed(
        input.username,
        "credential_username_required",
        "Credential username is required",
    )?;
    let crypto = crypto_service(&app, &security)?;
    let secret_store = SecretStore::new(&crypto);
    let now = now_epoch();

    let credential = if input.id.trim().is_empty() {
        let password = required_password(input.password)?;
        let password_ref = secret_store
            .protect_optional_string(Some(password))?
            .ok_or_else(|| {
                EngineError::new(
                    crate::credential_store::CREDENTIAL_PASSWORD_REQUIRED_CODE,
                    "Credential password is required",
                )
            })?;
        Credential {
            id: Uuid::new_v4().to_string(),
            kind: input.kind,
            name,
            username,
            password_ref,
            domain: None,
            created_at: now,
            updated_at: now,
        }
    } else {
        let existing = store
            .credentials
            .iter()
            .find(|credential| credential.id == input.id)
            .cloned()
            .ok_or_else(|| EngineError::new(CREDENTIAL_NOT_FOUND_CODE, "Credential not found"))?;
        ensure_kind(existing.kind, input.kind)?;
        let password_ref = match input.password {
            Some(password) => secret_store
                .protect_optional_string(Some(required_password(Some(password))?))?
                .ok_or_else(|| {
                    EngineError::new(
                        crate::credential_store::CREDENTIAL_PASSWORD_REQUIRED_CODE,
                        "Credential password is required",
                    )
                })?,
            None => existing.password_ref,
        };
        Credential {
            name,
            username,
            password_ref,
            updated_at: now,
            ..existing
        }
    };

    if let Some(existing) = store
        .credentials
        .iter_mut()
        .find(|item| item.id == credential.id)
    {
        *existing = credential.clone();
    } else {
        store.credentials.push(credential.clone());
    }
    store.updated_at = now;
    write_credentials(&app, &store)?;
    Ok(summary(credential))
}

#[tauri::command]
/// 将同协议凭据显式解析为可复制到 Profile 的明文。
pub fn credential_resolve_for_copy(
    app: AppHandle,
    security: State<'_, SecurityState>,
    credential_id: String,
    expected_kind: CredentialKind,
) -> Result<CredentialCopyValue, EngineError> {
    let credential = find_credential(&app, &credential_id)?;
    ensure_kind(credential.kind, expected_kind)?;
    let crypto = crypto_service(&app, &security)?;
    let password = reveal_credential_password(&credential, &SecretStore::new(&crypto))?;
    Ok(CredentialCopyValue {
        username: credential.username,
        password,
    })
}

#[tauri::command]
/// 删除凭据；有引用时必须显式确认解绑。
pub fn credential_delete(
    app: AppHandle,
    security: State<'_, SecurityState>,
    input: CredentialDeleteInput,
) -> Result<bool, EngineError> {
    // 即使删除无需解密，也要求强保护已解锁，避免锁定状态下破坏敏感数据。
    let _crypto = crypto_service(&app, &security)?;
    let mut credential_store = read_credentials(&app)?;
    let credential = credential_store
        .credentials
        .iter()
        .find(|credential| credential.id == input.credential_id)
        .cloned()
        .ok_or_else(|| EngineError::new(CREDENTIAL_NOT_FOUND_CODE, "Credential not found"))?;
    match credential.kind {
        CredentialKind::Ssh => {
            let mut profiles = read_ssh_profiles(&app)?;
            let referenced = profiles
                .profiles
                .iter()
                .any(|profile| profile.credential_id.as_deref() == Some(credential.id.as_str()));
            ensure_detach_allowed(referenced, input.detach_references)?;
            if referenced {
                for profile in &mut profiles.profiles {
                    if profile.credential_id.as_deref() == Some(credential.id.as_str()) {
                        profile.credential_id = None;
                        profile.username.clear();
                        profile.password_ref = None;
                    }
                }
                profiles.updated_at = now_epoch();
                write_ssh_profiles(&app, &profiles)?;
            }
        }
        CredentialKind::Rdp => {
            let mut profiles = read_rdp_profiles(&app)?;
            let referenced = profiles
                .profiles
                .iter()
                .any(|profile| profile.credential_id.as_deref() == Some(credential.id.as_str()));
            ensure_detach_allowed(referenced, input.detach_references)?;
            if referenced {
                for profile in &mut profiles.profiles {
                    if profile.credential_id.as_deref() == Some(credential.id.as_str()) {
                        profile.credential_id = None;
                        profile.username.clear();
                        profile.password_ref = None;
                    }
                }
                profiles.updated_at = now_epoch();
                write_rdp_profiles(&app, &profiles)?;
            }
        }
    }

    credential_store
        .credentials
        .retain(|item| item.id != credential.id);
    credential_store.updated_at = now_epoch();
    write_credentials(&app, &credential_store)?;
    Ok(true)
}

/// 按类型查找并解析运行时凭据。
pub fn resolve_runtime_credential(
    app: &AppHandle,
    security: &State<'_, SecurityState>,
    credential_id: &str,
    expected_kind: CredentialKind,
) -> Result<CredentialCopyValue, EngineError> {
    let credential = find_credential(app, credential_id)?;
    ensure_kind(credential.kind, expected_kind)?;
    let crypto = crypto_service(app, security)?;
    let password = reveal_credential_password(&credential, &SecretStore::new(&crypto))?;
    Ok(CredentialCopyValue {
        username: credential.username,
        password,
    })
}

fn summary(credential: Credential) -> CredentialSummary {
    CredentialSummary {
        id: credential.id,
        kind: credential.kind,
        name: credential.name,
        username: credential.username,
        domain: credential.domain,
        created_at: credential.created_at,
        updated_at: credential.updated_at,
    }
}

fn ensure_detach_allowed(referenced: bool, detach_references: bool) -> Result<(), EngineError> {
    if referenced && !detach_references {
        return Err(EngineError::new(
            "credential_in_use",
            "Credential is referenced by connection profiles",
        ));
    }
    Ok(())
}

fn find_credential(app: &AppHandle, credential_id: &str) -> Result<Credential, EngineError> {
    read_credentials(app)?
        .credentials
        .into_iter()
        .find(|credential| credential.id == credential_id)
        .ok_or_else(|| EngineError::new(CREDENTIAL_NOT_FOUND_CODE, "Credential not found"))
}

fn crypto_service(
    app: &AppHandle,
    security: &State<'_, SecurityState>,
) -> Result<CryptoService, EngineError> {
    let config = read_security_config(app)?;
    let session = security.current_session();
    CryptoService::load(app, config.as_ref(), session.as_ref())
}

fn required_trimmed(value: String, code: &str, message: &str) -> Result<String, EngineError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(EngineError::new(code, message));
    }
    Ok(value.to_string())
}

fn required_password(value: Option<String>) -> Result<String, EngineError> {
    value
        .filter(|password| !password.is_empty())
        .ok_or_else(|| {
            EngineError::new(
                crate::credential_store::CREDENTIAL_PASSWORD_REQUIRED_CODE,
                "Credential password is required",
            )
        })
}

fn kind_mismatch_error() -> EngineError {
    EngineError::new(
        "credential_kind_mismatch",
        "Credential type does not match the connection protocol",
    )
}

fn ensure_kind(actual: CredentialKind, expected: CredentialKind) -> Result<(), EngineError> {
    if actual != expected {
        return Err(kind_mismatch_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ensure_detach_allowed, ensure_kind};
    use crate::credential_store::CredentialKind;

    #[test]
    fn credential_kind_cannot_cross_protocols() {
        assert!(ensure_kind(CredentialKind::Ssh, CredentialKind::Ssh).is_ok());
        let error = ensure_kind(CredentialKind::Ssh, CredentialKind::Rdp)
            .expect_err("SSH credential must not resolve as RDP");
        assert_eq!(error.code, "credential_kind_mismatch");
    }

    #[test]
    fn referenced_credential_requires_explicit_detach() {
        assert!(ensure_detach_allowed(false, false).is_ok());
        assert!(ensure_detach_allowed(true, true).is_ok());
        let error = ensure_detach_allowed(true, false)
            .expect_err("referenced credential must require explicit detach");
        assert_eq!(error.code, "credential_in_use");
    }
}
