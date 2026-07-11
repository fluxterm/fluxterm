//! 终端域 session 配置读取。

use std::fs;

use engine::EngineError;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config_paths::resolve_session_settings_path;

/// SSH Host Key 校验策略。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyPolicy {
    /// 未信任或指纹变更时发出确认事件，由前端显式确认。
    #[default]
    Ask,
    /// 未信任或指纹变更时直接拒绝连接。
    Strict,
    /// 关闭 Host Key 校验。
    Off,
}

/// 终端域设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    pub version: u32,
    #[serde(default)]
    pub host_key_policy: HostKeyPolicy,
}

/// 读取终端域设置。
pub fn read_session_settings(app: &AppHandle) -> Result<SessionSettings, EngineError> {
    let path = resolve_session_settings_path(app)?;
    if !path.exists() {
        return Ok(SessionSettings {
            version: 1,
            host_key_policy: HostKeyPolicy::Ask,
        });
    }
    let content = fs::read_to_string(&path).map_err(|err| {
        EngineError::with_detail(
            "session_settings_read_failed",
            "Failed to read the terminal settings file",
            err.to_string(),
        )
    })?;
    serde_json::from_str(&content).map_err(|err| {
        EngineError::with_detail(
            "session_settings_parse_failed",
            "Failed to parse the terminal settings file",
            err.to_string(),
        )
    })
}
