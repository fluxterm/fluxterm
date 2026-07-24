//! OpenSSH config 导入能力。
//!
//! 导入范围：
//! - 固定读取 `<home>/.ssh/config`。
//! - 所有导入会话统一写入固定分组 `OpenSSH`。
//! - 导入目标来自 `Host` 规则中的具体 alias。
//!
//! 导入目标识别规则：
//! - `Host alpha` 会生成一个导入目标 `alpha`。
//! - `Host alpha beta` 会生成两个导入目标 `alpha` 与 `beta`。
//! - `Host *` 只作为默认规则参与后续解析，不会生成会话，也不会计入 `unsupported_count`。
//! - 含通配符或否定 pattern 的规则不会直接展开为导入目标。
//! - 若同一条 `Host` 规则同时包含具体 alias 与不支持 pattern，则具体 alias 仍可导入，
//!   但该规则额外计入一次 `unsupported_count`。
//!
//! 最终配置解析：
//! - 每个 alias 的最终生效配置由统一解析规则计算，包含默认值继承与字段覆盖。
//! - 若配置文件在首个 `Host` 之前存在全局参数，导入阶段会按等价语义将其视作默认规则。
//!
//! 当前会写入 `HostProfile` 的关键字段：
//! - `host` / `port` / `username`
//! - `private_key_path` 与 `identity_files`
//! - `proxy_jump` / `proxy_command`
//! - `add_keys_to_agent`
//! - `user_known_hosts_file`
//! - `strict_host_key_checking`
//!
//! 注意：
//! - 某些 OpenSSH 字段虽然已被导入并保存，但不代表 FluxTerm 当前连接链路已经消费这些字段。
//! - 导入采用默认不覆盖策略，判重依据为 `name + host + port + username`。
use engine::{AuthType, EngineError, HostProfile};
use russh_config::AddKeysToAgent;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::commands::profile::{validate_and_dedupe_groups, validate_profile_name};
use crate::ssh_profile_store::{
    SshProfileStore, read_ssh_groups, read_ssh_profiles, write_ssh_groups, write_ssh_profiles,
};

const IMPORT_GROUP_NAME: &str = "OpenSSH";
/// 导入会话名称沿用前端 ProfileModal 的 14 字符显示约束，避免导入结果与手工编辑规则不一致。
const IMPORT_PROFILE_NAME_MAX_CHARS: usize = 14;

/// 可作为导入目标的 OpenSSH Host 别名。
#[derive(Debug, Clone, PartialEq, Eq)]
struct OpensshImportTarget {
    alias: String,
}

/// OpenSSH config 的导入计划。
/// `unsupported_count` 记录无法稳定枚举成导入目标的 Host 规则数量。
#[derive(Debug, Default)]
struct ParsedOpensshConfig {
    targets: Vec<OpensshImportTarget>,
    unsupported_count: usize,
}

/// 前端用于展示的导入摘要。
/// 各字段直接对应导入流程中的结果分类，不包含逐项明细。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpensshImportSummary {
    pub added_count: usize,
    pub skipped_count: usize,
    pub conflict_count: usize,
    pub unsupported_count: usize,
    pub error_count: usize,
}

/// 读取默认 OpenSSH config 并导入为 FluxTerm SSH 配置。
/// 导入只处理固定路径 `<home>/.ssh/config`，成功后直接写回现有 SSH 配置存储。
pub fn import_openssh_config(app: &AppHandle) -> Result<OpensshImportSummary, EngineError> {
    let home = app.path().home_dir().map_err(|err| {
        EngineError::with_detail(
            "local_home_failed",
            "Failed to resolve local home directory",
            err.to_string(),
        )
    })?;
    let path = home.join(".ssh").join("config");
    if !path.exists() {
        return Err(EngineError::new(
            "ssh_config_not_found",
            "SSH config file was not found",
        ));
    }
    let content = fs::read_to_string(&path).map_err(|err| {
        EngineError::with_detail(
            "ssh_config_unreadable",
            "Failed to read SSH config file",
            err.to_string(),
        )
    })?;
    let normalized = normalize_config_for_russh(&content);
    let parsed = parse_openssh_config(&content)?;
    let mut store = read_ssh_profiles(app)?;
    let mut groups = read_ssh_groups(app)?;
    let summary = apply_import(&mut store, &mut groups, &normalized, parsed)?;
    if summary.added_count == 0
        && summary.skipped_count == 0
        && summary.conflict_count == 0
        && summary.error_count == 0
    {
        return Err(EngineError::new(
            "ssh_config_import_empty",
            "No importable SSH host configuration found",
        ));
    }
    write_ssh_profiles(app, &store)?;
    write_ssh_groups(app, &groups)?;
    Ok(summary)
}

/// 从 OpenSSH config 文本中收集可稳定导入的 Host 别名。
/// 解析仍按产品语义筛选导入目标，而具体字段合并与默认值解析交由 `russh-config` 完成。
fn parse_openssh_config(content: &str) -> Result<ParsedOpensshConfig, EngineError> {
    let mut parsed = ParsedOpensshConfig::default();
    let mut seen = HashSet::new();

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = split_config_line(line) else {
            return Err(EngineError::new(
                "ssh_config_parse_failed",
                "Failed to parse SSH config",
            ));
        };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }

        let patterns = split_host_patterns(value);
        if patterns.is_empty() {
            parsed.unsupported_count += 1;
            continue;
        }
        if patterns.len() == 1 && patterns[0] == "*" {
            continue;
        }
        if patterns.iter().any(|pattern| pattern.starts_with('!')) {
            parsed.unsupported_count += 1;
            continue;
        }

        let aliases: Vec<&str> = patterns
            .iter()
            .copied()
            .filter(|pattern| is_exact_host_alias(pattern))
            .collect();
        if aliases.is_empty() {
            parsed.unsupported_count += 1;
            continue;
        }
        if aliases.len() != patterns.len() {
            parsed.unsupported_count += 1;
        }

        for alias in aliases {
            if seen.insert(alias.to_string()) {
                parsed.targets.push(OpensshImportTarget {
                    alias: alias.to_string(),
                });
            }
        }
    }

    Ok(parsed)
}

/// 将解析后的 Host 别名解析为完整配置并写入现有 SSH 配置存储。
/// 判重使用 `name + host + port + username`，同名但目标不同记为冲突而不是覆盖。
fn apply_import(
    store: &mut SshProfileStore,
    groups: &mut Vec<String>,
    content: &str,
    parsed: ParsedOpensshConfig,
) -> Result<OpensshImportSummary, EngineError> {
    ensure_import_group(groups)?;
    let mut summary = OpensshImportSummary {
        added_count: 0,
        skipped_count: 0,
        conflict_count: 0,
        unsupported_count: parsed.unsupported_count,
        error_count: 0,
    };

    for target in parsed.targets {
        let mapped = match map_host_target_to_profile(content, &target) {
            Ok(profile) => profile,
            Err(_) => {
                summary.error_count += 1;
                continue;
            }
        };

        // 仅在 OpenSSH 导入分组内进行判重。
        // 若其他分组存在同名会话，不应影响 OpenSSH 配置文件中该 alias 的正常导入。
        let existing_in_group = store.profiles.iter().find(|item| {
            let is_in_import_group = item
                .tags
                .as_ref()
                .is_some_and(|tags| tags.iter().any(|t| t == IMPORT_GROUP_NAME));
            item.name == mapped.name && is_in_import_group
        });

        if let Some(item) = existing_in_group {
            let is_duplicate = item.host == mapped.host
                && item.port == mapped.port
                && item.username == mapped.username;

            if is_duplicate {
                summary.skipped_count += 1;
            } else {
                summary.conflict_count += 1;
            }
            continue;
        }

        store.profiles.push(mapped);
        summary.added_count += 1;
    }

    resolve_imported_proxy_jump_ids(store);
    store.updated_at = now_epoch();
    Ok(summary)
}

/// 将单个 OpenSSH Host 别名解析为 FluxTerm SSH 配置。
/// `russh-config` 负责解析匹配规则、默认值和支持字段的最终生效配置。
fn map_host_target_to_profile(
    content: &str,
    target: &OpensshImportTarget,
) -> Result<HostProfile, EngineError> {
    let resolved = russh_config::parse(content, &target.alias).map_err(|err| {
        EngineError::with_detail(
            "ssh_config_parse_failed",
            "Failed to parse SSH config",
            err.to_string(),
        )
    })?;
    let identity_files = collect_identity_files(&resolved.host_config);
    let private_key_path = identity_files
        .as_ref()
        .and_then(|values| values.first().cloned());

    Ok(HostProfile {
        id: Uuid::new_v4().to_string(),
        name: validate_profile_name(truncate_profile_name(&target.alias))?,
        icon_key: None,
        host: resolved.host().to_string(),
        port: resolved.port(),
        username: resolved.host_config.user.clone().unwrap_or_default(),
        auth_type: if private_key_path.is_some() {
            AuthType::PrivateKey
        } else {
            AuthType::Password
        },
        private_key_path,
        identity_files,
        private_key_passphrase_ref: None,
        password_ref: None,
        known_host: None,
        proxy_mode: None,
        proxy_config: None,
        proxy_command: resolved.host_config.proxy_command.clone(),
        proxy_jump: resolved.host_config.proxy_jump.clone(),
        jump_profile_ids: None,
        add_keys_to_agent: resolved
            .host_config
            .add_keys_to_agent
            .as_ref()
            .map(normalize_add_keys_to_agent),
        user_known_hosts_file: resolved
            .host_config
            .user_known_hosts_file
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        strict_host_key_checking: resolved.host_config.strict_host_key_checking,
        tags: Some(vec![IMPORT_GROUP_NAME.to_string()]),
        terminal_type: None,
        target_system: None,
        charset: None,
        word_separators: None,
        bell_mode: None,
        bell_cooldown_ms: None,
        description: None,
    })
}

/// 将已导入的 ProxyJump alias 尽量映射为 FluxTerm 内部 profile id 链。
fn resolve_imported_proxy_jump_ids(store: &mut SshProfileStore) {
    let name_to_id: std::collections::HashMap<String, String> = store
        .profiles
        .iter()
        .map(|profile| (profile.name.to_ascii_lowercase(), profile.id.clone()))
        .collect();
    for profile in &mut store.profiles {
        let Some(proxy_jump) = profile.proxy_jump.as_deref() else {
            continue;
        };
        let ids = proxy_jump
            .split(',')
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
            .map(|item| {
                item.split('@')
                    .next_back()
                    .unwrap_or(item)
                    .split(':')
                    .next()
                    .unwrap_or(item)
                    .to_ascii_lowercase()
            })
            .map(|name| name_to_id.get(&name).cloned())
            .collect::<Option<Vec<_>>>();
        if let Some(ids) = ids.filter(|ids| !ids.is_empty()) {
            profile.jump_profile_ids = Some(ids);
        }
    }
}

/// 将配置前置的全局参数折叠成 `Host *`，规避 `russh-config` 对首个 `Host` 前参数的限制。
fn normalize_config_for_russh(content: &str) -> String {
    let mut leading = Vec::new();
    let mut rest = Vec::new();
    let mut seen_host = false;

    for raw_line in content.lines() {
        let trimmed = raw_line.trim();
        if !seen_host
            && !trimmed.is_empty()
            && !trimmed.starts_with('#')
            && split_config_line(trimmed)
                .map(|(key, _)| key.eq_ignore_ascii_case("host"))
                .unwrap_or(false)
        {
            seen_host = true;
        }

        if seen_host {
            rest.push(raw_line);
        } else {
            leading.push(raw_line);
        }
    }

    let has_leading_directives = leading.iter().any(|line| {
        let trimmed = line.trim();
        !trimmed.is_empty() && !trimmed.starts_with('#')
    });
    if !has_leading_directives {
        return content.to_string();
    }

    let mut normalized = String::from("Host *\n");
    for line in leading {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            normalized.push_str(line);
        } else {
            normalized.push_str("  ");
            normalized.push_str(line.trim_start());
        }
        normalized.push('\n');
    }
    if !rest.is_empty() {
        normalized.push('\n');
        normalized.push_str(&rest.join("\n"));
    }
    normalized
}

/// 收集 `IdentityFile` 数组，保持导入时的原始优先级顺序。
fn collect_identity_files(config: &russh_config::HostConfig) -> Option<Vec<String>> {
    let values = config
        .identity_file
        .as_ref()?
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

/// 规范化 `AddKeysToAgent`，让持久化值稳定为小写字符串。
fn normalize_add_keys_to_agent(value: &AddKeysToAgent) -> String {
    format!("{value:?}").to_ascii_lowercase()
}

/// 确保固定导入分组存在于现有 SSH 分组集合中。
/// 这里复用现有分组约束和排序逻辑，避免导入链路生成特殊分组格式。
fn ensure_import_group(groups: &mut Vec<String>) -> Result<(), EngineError> {
    let next = validate_and_dedupe_groups(
        groups
            .iter()
            .cloned()
            .chain(std::iter::once(IMPORT_GROUP_NAME.to_string()))
            .collect(),
    )?;
    *groups = next;
    Ok(())
}

/// 判断一个 Host pattern 是否可以直接当成导入别名。
fn is_exact_host_alias(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    !trimmed.contains('*') && !trimmed.contains('?') && !trimmed.contains('!')
}

/// 按 OpenSSH 语义拆分 `Host` 行中的多个 pattern。
fn split_host_patterns(value: &str) -> Vec<&str> {
    value
        .split_whitespace()
        .filter(|item| !item.trim().is_empty())
        .collect()
}

/// 解析 `key value` 形式的配置行。
fn split_config_line(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.splitn(2, char::is_whitespace);
    let key = parts.next()?.trim();
    let value = parts.next()?.trim();
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key, value))
}

/// 将导入来源的 Host 名裁剪到当前会话名称上限。
/// 裁剪仅发生在导入路径中，手工编辑会话仍由前后端共同执行长度校验。
fn truncate_profile_name(value: &str) -> String {
    value.chars().take(IMPORT_PROFILE_NAME_MAX_CHARS).collect()
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_store_with_profiles(profiles: Vec<HostProfile>) -> SshProfileStore {
        SshProfileStore {
            version: 1,
            updated_at: 0,
            profiles,
        }
    }

    fn sample_profile(name: &str, host: &str, port: u16, username: &str) -> HostProfile {
        HostProfile {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            icon_key: None,
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth_type: AuthType::Password,
            private_key_path: None,
            identity_files: None,
            private_key_passphrase_ref: None,
            password_ref: None,
            known_host: None,
            proxy_mode: None,
            proxy_config: None,
            proxy_command: None,
            proxy_jump: None,
            jump_profile_ids: None,
            add_keys_to_agent: None,
            user_known_hosts_file: None,
            strict_host_key_checking: None,
            tags: None,
            terminal_type: None,
            target_system: None,
            charset: None,
            word_separators: None,
            bell_mode: None,
            bell_cooldown_ms: None,
            description: None,
        }
    }

    #[test]
    fn parse_openssh_config_reads_basic_host_block() {
        let parsed = parse_openssh_config(
            r#"
Host prod
  HostName 10.0.0.10
  User root
  Port 2222
"#,
        )
        .unwrap();

        assert_eq!(parsed.unsupported_count, 0);
        assert_eq!(parsed.targets.len(), 1);
        assert_eq!(parsed.targets[0].alias, "prod");
    }

    #[test]
    fn parse_openssh_config_supports_multiple_concrete_aliases() {
        let parsed = parse_openssh_config(
            r#"
Host prod staging
  User root
"#,
        )
        .unwrap();

        assert_eq!(parsed.unsupported_count, 0);
        assert_eq!(parsed.targets.len(), 2);
        assert_eq!(parsed.targets[0].alias, "prod");
        assert_eq!(parsed.targets[1].alias, "staging");
    }

    #[test]
    fn parse_openssh_config_marks_wildcards_and_negations_as_unsupported() {
        let parsed = parse_openssh_config(
            r#"
Host *
  User root
Host web-* prod
  HostName 10.0.0.3
Host !jump
  HostName 10.0.0.4
"#,
        )
        .unwrap();

        assert_eq!(parsed.targets.len(), 1);
        assert_eq!(parsed.targets[0].alias, "prod");
        assert_eq!(parsed.unsupported_count, 2);
    }

    #[test]
    fn parse_openssh_config_ignores_host_star_in_unsupported_count() {
        let parsed = parse_openssh_config(
            r#"
Host *
  User demo_user

Host alpha-node
  HostName 192.168.56.21

Host beta-panel
  HostName 192.168.56.31

Host gamma-workspace
  HostName 192.168.56.31
  Port 32022
"#,
        )
        .unwrap();

        assert_eq!(parsed.unsupported_count, 0);
        assert_eq!(parsed.targets.len(), 3);
    }

    #[test]
    fn map_host_target_to_profile_uses_russh_config_defaults() {
        let profile = map_host_target_to_profile(
            &normalize_config_for_russh(
                r#"
Host *
  User demo
  Port 2200
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump bastion
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.ssh/known_hosts_work

Host prod
  HostName 10.0.0.9
"#,
            ),
            &OpensshImportTarget {
                alias: "prod".to_string(),
            },
        )
        .unwrap();

        assert_eq!(profile.name, "prod");
        assert_eq!(profile.host, "10.0.0.9");
        assert_eq!(profile.port, 2200);
        assert_eq!(profile.username, "demo");
        assert!(matches!(profile.auth_type, AuthType::PrivateKey));
        assert!(profile.private_key_path.unwrap().contains("id_ed25519"));
        assert_eq!(profile.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(profile.strict_host_key_checking, Some(true));
        assert!(
            profile
                .user_known_hosts_file
                .unwrap()
                .contains("known_hosts_work")
        );
    }

    #[test]
    fn normalize_config_for_russh_wraps_global_directives() {
        let normalized = normalize_config_for_russh(
            r#"
User demo
Port 2200

Host prod
  HostName 10.0.0.9
"#,
        );

        assert!(normalized.contains("Host *"));
        let profile = map_host_target_to_profile(
            &normalized,
            &OpensshImportTarget {
                alias: "prod".to_string(),
            },
        )
        .unwrap();
        assert_eq!(profile.username, "demo");
        assert_eq!(profile.port, 2200);
    }

    #[test]
    fn apply_import_counts_added_skipped_and_conflicts() {
        let mut store = profile_store_with_profiles(vec![
            // 这个 prod 即使同名但不在 OpenSSH 分组中，不应导致冲突
            sample_profile("prod", "10.0.0.1", 22, "root"),
            // 这个 staging 在 OpenSSH 分组中且配置一致，应被跳过 (skipped)
            {
                let mut p = sample_profile("staging", "10.0.0.20", 22, "root");
                p.tags = Some(vec![IMPORT_GROUP_NAME.to_string()]);
                p
            },
            // 这个 qa 在 OpenSSH 分组中但配置不一致，应记为冲突 (conflict)
            {
                let mut p = sample_profile("qa", "10.0.0.4", 22, "root");
                p.tags = Some(vec![IMPORT_GROUP_NAME.to_string()]);
                p
            },
        ]);
        let mut groups = Vec::new();
        let content = normalize_config_for_russh(
            r#"
Host prod
  HostName 10.0.0.1
  User root

Host staging
  HostName 10.0.0.20
  User root

Host qa
  HostName 10.0.0.3
  User deploy
  Port 2200
"#,
        );
        let summary = apply_import(
            &mut store,
            &mut groups,
            &content,
            ParsedOpensshConfig {
                unsupported_count: 1,
                targets: vec![
                    OpensshImportTarget {
                        alias: "prod".to_string(),
                    },
                    OpensshImportTarget {
                        alias: "staging".to_string(),
                    },
                    OpensshImportTarget {
                        alias: "qa".to_string(),
                    },
                ],
            },
        )
        .unwrap();

        assert_eq!(
            summary,
            OpensshImportSummary {
                added_count: 1,    // 只有 prod 被添加了 (因为原有的 prod 没在 OpenSSH 分组中)
                skipped_count: 1,  // staging 配置完全一样且在 OpenSSH 分组中，跳过
                conflict_count: 1, // qa 在 OpenSSH 分组中但配置变了，记为冲突
                unsupported_count: 1,
                error_count: 0,
            }
        );
        assert!(groups.iter().any(|item| item == IMPORT_GROUP_NAME));
        assert_eq!(store.profiles.len(), 4); // 初始 3 个 + 新加的 1 个 prod
    }

    #[test]
    fn map_host_target_to_profile_truncates_long_host_name() {
        let profile = map_host_target_to_profile(
            &normalize_config_for_russh(
                r#"
Host 0123456789abcde
  HostName 10.0.0.9
  User root
"#,
            ),
            &OpensshImportTarget {
                alias: "0123456789abcde".to_string(),
            },
        )
        .unwrap();

        assert_eq!(profile.name, "0123456789abcd");
    }
}
