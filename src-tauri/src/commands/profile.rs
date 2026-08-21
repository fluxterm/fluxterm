//! 主机配置相关命令。
const GROUP_NAME_TOO_LONG_CODE: &str = "group_name_too_long";

use fluxterm_engine::{AuthType, EngineError, HostProfile};
use tauri::AppHandle;
use tauri::State;
use uuid::Uuid;

use crate::commands::credential::resolve_runtime_credential;
use crate::credential_store::CredentialKind;
use crate::credential_store::read_credentials;
use crate::profile_secrets::{decrypt_profile_secrets, encrypt_profile_secrets};
use crate::security::{CryptoService, SecretStore};
use crate::security_store::read_security_config;
use crate::ssh_profile_store::{
    read_ssh_groups, read_ssh_profiles, write_ssh_groups, write_ssh_profiles,
};
use crate::state::SecurityState;

const GROUP_NAME_MAX_LENGTH: usize = 12;
/// 会话名称上限与前端 ProfileModal 保持一致，避免前后端校验结果不同。
const PROFILE_NAME_MAX_LENGTH: usize = 14;
/// 允许的会话图标键集合；修改这里时，需要同步更新前端 `profileIcons.tsx` 中的图标清单。
const ALLOWED_PROFILE_ICON_KEYS: &[&str] = &[
    "linux",
    "ubuntu",
    "debian",
    "centos",
    "almalinux",
    "alpinelinux",
    "archlinux",
    "kali",
    "kubuntu",
    "opensuse",
    "redhat",
    "docker",
    "kubernetes",
    "nginx",
    "apache",
    "cloudflare",
    "mysql",
    "postgresql",
    "mongodb",
    "redis",
    "rabbitmq",
    "elasticsearch",
    "wordpress",
    "truenas",
    "unraid",
    "synology",
    "vmware",
    "laravel",
    "grafana",
    "prometheus",
    "jenkins",
    "gitlab",
    "laragon",
    "mariadb",
    "nodedotjs",
    "ollama",
    "openvpn",
    "steam",
    "proxmox",
    "webmin",
    "1panel",
];

#[tauri::command]
/// 读取主机配置列表。
pub fn profile_list(
    app: AppHandle,
    security: State<'_, SecurityState>,
) -> Result<Vec<HostProfile>, EngineError> {
    let store = read_ssh_profiles(&app)?;
    let credentials = read_credentials(&app)?;
    let security_config = read_security_config(&app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    let secret_store = SecretStore::new(&crypto);
    store
        .profiles
        .into_iter()
        .map(|profile| {
            let credential_username = profile.credential_id.as_deref().and_then(|id| {
                credentials
                    .credentials
                    .iter()
                    .find(|credential| {
                        credential.id == id && credential.kind == CredentialKind::Ssh
                    })
                    .map(|credential| credential.username.clone())
            });
            let result = match decrypt_profile_secrets(profile.clone(), &secret_store) {
                Ok(decrypted) => Ok(decrypted),
                Err(err)
                    if err.code == "security_locked"
                        && crypto.provider_kind()
                            == crate::security::EncryptionProviderKind::UserPassword =>
                {
                    Ok(redact_profile_secrets(profile))
                }
                Err(err) => Err(err),
            };
            result.map(|mut profile| {
                if let Some(username) = credential_username {
                    profile.username = username;
                }
                profile
            })
        })
        .collect()
}

#[tauri::command]
/// 读取 SSH 分组列表。
pub fn profile_groups_list(app: AppHandle) -> Result<Vec<String>, EngineError> {
    Ok(dedupe_groups(read_ssh_groups(&app)?))
}

#[tauri::command]
/// 写入 SSH 分组列表。
pub fn profile_groups_save(
    app: AppHandle,
    groups: Vec<String>,
) -> Result<Vec<String>, EngineError> {
    let next = validate_and_dedupe_groups(groups)?;
    write_ssh_groups(&app, &next)?;
    Ok(next)
}

#[tauri::command]
/// 新增或更新主机配置。
pub fn profile_save(
    app: AppHandle,
    security: State<'_, SecurityState>,
    mut profile: HostProfile,
) -> Result<HostProfile, EngineError> {
    let mut store = read_ssh_profiles(&app)?;
    let security_config = read_security_config(&app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    let secret_store = SecretStore::new(&crypto);
    profile.name = validate_profile_name(profile.name)?;
    profile.icon_key = normalize_profile_icon_key(profile.icon_key)?;
    profile.tags = normalize_profile_tags(profile.tags)?;
    if profile.id.is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }
    if profile.port == 0 {
        profile.port = 22;
    }
    profile.credential_id = profile
        .credential_id
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(credential_id) = profile.credential_id.as_deref() {
        resolve_runtime_credential(&app, &security, credential_id, CredentialKind::Ssh)?;
        profile.auth_type = AuthType::Password;
        profile.username.clear();
        profile.password_ref = None;
    }
    let encrypted_profile = encrypt_profile_secrets(profile.clone(), &secret_store)?;
    let existing = store.profiles.iter_mut().find(|item| item.id == profile.id);
    if let Some(item) = existing {
        *item = encrypted_profile;
    } else {
        store.profiles.push(encrypted_profile);
    }
    store.updated_at = now_epoch();
    write_ssh_profiles(&app, &store)?;
    Ok(profile)
}

#[tauri::command]
/// 删除指定主机配置。
pub fn profile_remove(app: AppHandle, profile_id: String) -> Result<bool, EngineError> {
    let mut store = read_ssh_profiles(&app)?;
    let before = store.profiles.len();
    store.profiles.retain(|item| item.id != profile_id);
    store.updated_at = now_epoch();
    write_ssh_profiles(&app, &store)?;
    Ok(before != store.profiles.len())
}

#[tauri::command]
/// 从默认 OpenSSH config 导入主机配置。
pub fn ssh_import_openssh_config(
    app: AppHandle,
) -> Result<crate::ssh_config_import::OpensshImportSummary, EngineError> {
    crate::ssh_config_import::import_openssh_config(&app)
}

pub(crate) fn dedupe_groups(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::new();
    for value in values {
        let normalized = value.trim();
        if normalized.is_empty() {
            continue;
        }
        let key = normalized.to_lowercase();
        if seen.insert(key) {
            list.push(normalized.to_string());
        }
    }
    list.sort_by_key(|a| a.to_lowercase());
    list
}

/// 校验并规范化会话名称：不能为空，且长度不能超过上限。
pub(crate) fn validate_profile_name(value: String) -> Result<String, EngineError> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(EngineError::new(
            "profile_name_required",
            "Profile name cannot be empty",
        ));
    }
    if normalized.chars().count() > PROFILE_NAME_MAX_LENGTH {
        return Err(EngineError::new(
            "profile_name_too_long",
            "Profile name cannot exceed 14 characters",
        ));
    }
    Ok(normalized.to_string())
}

/// 校验并规范化分组名称列表：忽略空值，拒绝超长名称，再做去重排序。
pub(crate) fn validate_and_dedupe_groups(values: Vec<String>) -> Result<Vec<String>, EngineError> {
    let mut normalized = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > GROUP_NAME_MAX_LENGTH {
            return Err(EngineError::new(
                GROUP_NAME_TOO_LONG_CODE,
                "Group name cannot exceed 12 characters",
            ));
        }
        normalized.push(trimmed.to_string());
    }
    Ok(dedupe_groups(normalized))
}

/// 规范化主机配置中的分组字段：空值移除，非空值要求长度合法。
pub(crate) fn normalize_profile_tags(
    tags: Option<Vec<String>>,
) -> Result<Option<Vec<String>>, EngineError> {
    let Some(values) = tags else {
        return Ok(None);
    };
    let first = values.into_iter().next().unwrap_or_default();
    let normalized = first.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    if normalized.chars().count() > GROUP_NAME_MAX_LENGTH {
        return Err(EngineError::new(
            GROUP_NAME_TOO_LONG_CODE,
            "Group name cannot exceed 12 characters",
        ));
    }
    Ok(Some(vec![normalized.to_string()]))
}

/// 规范化主机配置中的图标键：空值移除，非空值必须命中允许集合。
pub(crate) fn normalize_profile_icon_key(
    icon_key: Option<String>,
) -> Result<Option<String>, EngineError> {
    let Some(value) = icon_key else {
        return Ok(None);
    };
    let normalized = value.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    if ALLOWED_PROFILE_ICON_KEYS.contains(&normalized) {
        return Ok(Some(normalized.to_string()));
    }
    Err(EngineError::new(
        "profile_icon_invalid",
        "Invalid profile icon",
    ))
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn redact_profile_secrets(mut profile: HostProfile) -> HostProfile {
    profile.password_ref = None;
    profile.private_key_passphrase_ref = None;
    if let Some(proxy_config) = profile.proxy_config.as_mut() {
        proxy_config.password_ref = None;
    }
    profile
}

#[cfg(test)]
mod tests {
    use super::{ALLOWED_PROFILE_ICON_KEYS, normalize_profile_icon_key};
    use std::collections::HashSet;

    fn frontend_profile_icon_keys() -> Vec<String> {
        let manifest_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/features/profile/profileIcons.tsx"
        );
        let source = std::fs::read_to_string(manifest_path)
            .expect("should read frontend profile icon manifest");
        source
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim();
                trimmed
                    .strip_prefix("key: \"")
                    .and_then(|rest| rest.split_once('"'))
                    .map(|(key, _)| key.to_string())
            })
            .collect()
    }

    #[test]
    fn normalize_profile_icon_key_accepts_known_value() {
        assert_eq!(
            normalize_profile_icon_key(Some("docker".to_string())).unwrap(),
            Some("docker".to_string())
        );
    }

    #[test]
    fn normalize_profile_icon_key_converts_blank_to_none() {
        assert_eq!(
            normalize_profile_icon_key(Some("  ".to_string())).unwrap(),
            None
        );
    }

    #[test]
    fn normalize_profile_icon_key_rejects_unknown_value() {
        assert!(normalize_profile_icon_key(Some("unknown-app".to_string())).is_err());
    }

    #[test]
    fn backend_icon_keys_match_frontend_manifest() {
        let frontend_keys = frontend_profile_icon_keys();
        let backend_keys = ALLOWED_PROFILE_ICON_KEYS
            .iter()
            .map(|item| item.to_string())
            .collect::<Vec<_>>();
        let frontend_key_set = frontend_keys.iter().collect::<HashSet<_>>();
        let backend_key_set = backend_keys.iter().collect::<HashSet<_>>();

        assert_eq!(
            frontend_keys.len(),
            frontend_key_set.len(),
            "frontend profile icon keys should not contain duplicates"
        );
        assert_eq!(
            backend_keys.len(),
            backend_key_set.len(),
            "backend profile icon keys should not contain duplicates"
        );
        assert_eq!(
            frontend_key_set, backend_key_set,
            "backend profile icon keys should match frontend manifest keys"
        );
    }
}
