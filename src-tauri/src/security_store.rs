//! 安全配置存储。

use std::fs;
use std::path::PathBuf;

use fluxterm_engine::EngineError;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config_paths::resolve_security_config_path;
use crate::utils::write_atomic;

/// 敏感数据保护配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretConfig {
    pub version: u32,
    pub provider: String,
    #[serde(default)]
    pub active_key_id: Option<String>,
    #[serde(default)]
    pub kdf_salt: Option<String>,
    #[serde(default)]
    pub verify_hash: Option<String>,
}

/// 读取安全配置。
pub fn read_security_config(app: &AppHandle) -> Result<Option<SecretConfig>, EngineError> {
    let path = security_config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|err| {
        EngineError::with_detail(
            "security_config_read_failed",
            "Failed to read the security settings file",
            err.to_string(),
        )
    })?;
    let config = serde_json::from_str(&content).map_err(|err| {
        EngineError::with_detail(
            "security_config_parse_failed",
            "Failed to parse the security settings file",
            err.to_string(),
        )
    })?;
    Ok(Some(config))
}

/// 写入安全配置。
pub fn write_security_config(app: &AppHandle, config: &SecretConfig) -> Result<(), EngineError> {
    let path = security_config_path(app)?;
    let content = serde_json::to_string_pretty(config).map_err(|err| {
        EngineError::with_detail(
            "security_config_write_failed",
            "Failed to serialize the security settings file",
            err.to_string(),
        )
    })?;
    write_atomic(path, &content)
}

fn security_config_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    resolve_security_config_path(app)
}
