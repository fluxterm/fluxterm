//! 应用私有 known_hosts 管理。
//!
//! 本模块维护 FluxTerm 自己的 Host Key 记录，不与系统 `~/.ssh/known_hosts` 互相读写。
//! 当前规则如下：
//!
//! - 存储路径位于应用配置目录下的 `connections/ssh/known_hosts`
//! - 存储格式兼容 OpenSSH 文本行：
//!   - `host key-type base64-key`
//!   - `[host]:port key-type base64-key`
//!   - 空行与 `#` 注释行
//! - 当前不支持 hashed host、marker、多 host 合并记录以及复杂模式匹配
//! - 匹配维度为 `host + port + keyAlgorithm`
//!
//! 主 SSH 会话与资源监控连接都依赖本模块的受信任记录来决定是否允许继续握手。

use std::fs;
use std::path::Path;

use engine::EngineError;
use russh::keys::{self, HashAlg};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config_paths::resolve_known_hosts_path;

/// Host Key 校验结果状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyMatchStatus {
    Trusted,
    Unknown,
    Mismatch,
}

/// Host Key 校验详情。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyMatch {
    pub status: HostKeyMatchStatus,
    pub previous_fingerprint_sha256: Option<String>,
}

/// 生成 OpenSSH 风格主机模式。
/// 默认端口写裸 host，非默认端口写成 `[host]:port`。
fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

fn parse_known_hosts_line(line: &str) -> Option<(&str, &str, &str)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let mut parts = trimmed.split_whitespace();
    Some((parts.next()?, parts.next()?, parts.next()?))
}

fn trust_host_key_path(
    path: &Path,
    host: &str,
    port: u16,
    key_algorithm: &str,
    public_key_base64: &str,
) -> Result<(), EngineError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            EngineError::with_detail(
                "known_hosts_write_failed",
                "Failed to create the known_hosts directory",
                err.to_string(),
            )
        })?;
    }

    let pattern = host_pattern(host, port);
    let mut preserved = Vec::new();
    if path.exists() {
        let content = fs::read_to_string(path).map_err(|err| {
            EngineError::with_detail(
                "known_hosts_read_failed",
                "Failed to read the known_hosts file",
                err.to_string(),
            )
        })?;
        for line in content.lines() {
            let Some((line_host, line_algorithm, _)) = parse_known_hosts_line(line) else {
                preserved.push(line.to_string());
                continue;
            };
            // 按 `host + port + keyAlgorithm` 替换单条记录。
            // 同 host 下的其他算法记录会被保留。
            if line_host == pattern && line_algorithm == key_algorithm {
                continue;
            }
            preserved.push(line.to_string());
        }
    }

    preserved.push(format!("{pattern} {key_algorithm} {public_key_base64}"));
    fs::write(path, preserved.join("\n") + "\n").map_err(|err| {
        EngineError::with_detail(
            "known_hosts_write_failed",
            "Failed to write the known_hosts file",
            err.to_string(),
        )
    })
}

fn match_host_key_path(
    path: &Path,
    host: &str,
    port: u16,
    key_algorithm: &str,
    public_key_base64: &str,
) -> Result<HostKeyMatch, EngineError> {
    let pattern = host_pattern(host, port);
    let content = if path.exists() {
        fs::read_to_string(path).map_err(|err| {
            EngineError::with_detail(
                "known_hosts_read_failed",
                "Failed to read the known_hosts file",
                err.to_string(),
            )
        })?
    } else {
        String::new()
    };

    for line in content.lines() {
        let Some((line_host, line_algorithm, line_key)) = parse_known_hosts_line(line) else {
            continue;
        };
        if line_host != pattern || line_algorithm != key_algorithm {
            continue;
        }
        if line_key == public_key_base64 {
            return Ok(HostKeyMatch {
                status: HostKeyMatchStatus::Trusted,
                previous_fingerprint_sha256: None,
            });
        }
        // 命中同一 host/port/algorithm 但公钥不一致时，返回旧指纹供前端展示变更确认。
        let previous_key = keys::parse_public_key_base64(line_key).map_err(|err| {
            EngineError::with_detail(
                "known_hosts_parse_failed",
                "Invalid known_hosts file format",
                err.to_string(),
            )
        })?;
        return Ok(HostKeyMatch {
            status: HostKeyMatchStatus::Mismatch,
            previous_fingerprint_sha256: Some(
                previous_key.fingerprint(HashAlg::Sha256).to_string(),
            ),
        });
    }

    Ok(HostKeyMatch {
        status: HostKeyMatchStatus::Unknown,
        previous_fingerprint_sha256: None,
    })
}

/// 校验应用私有 known_hosts 中的 Host Key 状态。
pub fn match_host_key(
    app: &AppHandle,
    host: &str,
    port: u16,
    key_algorithm: &str,
    public_key_base64: &str,
) -> Result<HostKeyMatch, EngineError> {
    let path = resolve_known_hosts_path(app)?;
    match_host_key_path(&path, host, port, key_algorithm, public_key_base64)
}

/// 显式信任或替换一条 Host Key 记录。
pub fn trust_host_key(
    app: &AppHandle,
    host: &str,
    port: u16,
    key_algorithm: &str,
    public_key_base64: &str,
) -> Result<(), EngineError> {
    let path = resolve_known_hosts_path(app)?;
    trust_host_key_path(&path, host, port, key_algorithm, public_key_base64)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{
        HostKeyMatchStatus, match_host_key_path, parse_known_hosts_line, trust_host_key_path,
    };

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";

    fn temp_known_hosts_path(name: &str) -> PathBuf {
        let unique = format!(
            "fluxterm-known-hosts-test-{}-{}",
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        );
        std::env::temp_dir().join(unique).join("known_hosts")
    }

    #[test]
    fn parse_known_hosts_line_ignores_comments_and_blank_lines() {
        assert!(parse_known_hosts_line("").is_none());
        assert!(parse_known_hosts_line("   ").is_none());
        assert!(parse_known_hosts_line("# comment").is_none());
        let parsed =
            parse_known_hosts_line("example.com ssh-ed25519 AAAA").expect("parsed known host");
        assert_eq!(parsed.0, "example.com");
        assert_eq!(parsed.1, "ssh-ed25519");
        assert_eq!(parsed.2, "AAAA");
    }

    #[test]
    fn trust_host_key_writes_default_and_non_default_port_patterns() {
        let path = temp_known_hosts_path("write-patterns");
        trust_host_key_path(&path, "example.com", 22, "ssh-ed25519", KEY_A).expect("write 22");
        trust_host_key_path(&path, "example.com", 2222, "ssh-ed25519", KEY_B).expect("write 2222");

        let content = fs::read_to_string(&path).expect("read known_hosts");
        assert!(content.contains("example.com ssh-ed25519"));
        assert!(content.contains("[example.com]:2222 ssh-ed25519"));

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn trust_host_key_replaces_same_host_and_algorithm_only() {
        let path = temp_known_hosts_path("replace-same-host");
        trust_host_key_path(&path, "example.com", 22, "ssh-ed25519", KEY_A).expect("seed a");
        trust_host_key_path(&path, "example.com", 22, "ssh-rsa", KEY_B).expect("seed rsa");
        trust_host_key_path(&path, "example.com", 22, "ssh-ed25519", KEY_B).expect("replace");

        let content = fs::read_to_string(&path).expect("read known_hosts");
        assert!(!content.contains(KEY_A));
        assert!(content.contains(&format!("example.com ssh-rsa {KEY_B}")));
        assert!(content.contains(&format!("example.com ssh-ed25519 {KEY_B}")));
        assert_eq!(content.lines().count(), 2);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn match_host_key_detects_unknown_trusted_and_mismatch() {
        let path = temp_known_hosts_path("match-status");
        trust_host_key_path(&path, "example.com", 22, "ssh-ed25519", KEY_A).expect("seed");

        let trusted =
            match_host_key_path(&path, "example.com", 22, "ssh-ed25519", KEY_A).expect("trusted");
        assert!(matches!(trusted.status, HostKeyMatchStatus::Trusted));

        let unknown = match_host_key_path(&path, "other.example.com", 22, "ssh-ed25519", KEY_A)
            .expect("unknown");
        assert!(matches!(unknown.status, HostKeyMatchStatus::Unknown));

        let mismatch =
            match_host_key_path(&path, "example.com", 22, "ssh-ed25519", KEY_B).expect("mismatch");
        assert!(matches!(mismatch.status, HostKeyMatchStatus::Mismatch));
        assert!(mismatch.previous_fingerprint_sha256.is_some());

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }
}
