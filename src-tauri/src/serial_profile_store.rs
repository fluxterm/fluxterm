//! 串口 Profile 独立持久化存储。

use std::fs;

use engine::{EngineError, SerialProfile};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config_paths::{resolve_serial_groups_path, resolve_serial_profiles_path};
use crate::utils::write_atomic;

/// 串口 Profile 配置文件结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialProfileStore {
    pub version: u32,
    pub updated_at: u64,
    #[serde(default)]
    pub profiles: Vec<SerialProfile>,
}

impl Default for SerialProfileStore {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: now_epoch(),
            profiles: Vec::new(),
        }
    }
}

/// 读取串口 Profile 存储；文件不存在时返回空存储。
pub fn read_serial_profiles(app: &AppHandle) -> Result<SerialProfileStore, EngineError> {
    let path = resolve_serial_profiles_path(app)?;
    if !path.exists() {
        return Ok(SerialProfileStore::default());
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        EngineError::with_detail(
            "serial_profile_read_failed",
            "无法读取串口配置文件",
            error.to_string(),
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        EngineError::with_detail(
            "serial_profile_parse_failed",
            "串口配置文件解析失败",
            error.to_string(),
        )
    })
}

/// 原子写入串口 Profile 存储。
pub fn write_serial_profiles(
    app: &AppHandle,
    store: &SerialProfileStore,
) -> Result<(), EngineError> {
    let path = resolve_serial_profiles_path(app)?;
    let content = serde_json::to_string_pretty(store).map_err(|error| {
        EngineError::with_detail(
            "serial_profile_write_failed",
            "无法序列化串口配置文件",
            error.to_string(),
        )
    })?;
    write_atomic(path, &content)
}

/// 读取串口分组；文件不存在时返回空列表。
pub fn read_serial_groups(app: &AppHandle) -> Result<Vec<String>, EngineError> {
    let path = resolve_serial_groups_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        EngineError::with_detail(
            "serial_groups_read_failed",
            "无法读取串口分组文件",
            error.to_string(),
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        EngineError::with_detail(
            "serial_groups_parse_failed",
            "串口分组文件解析失败",
            error.to_string(),
        )
    })
}

/// 规范化并原子写入串口分组。
pub fn write_serial_groups(app: &AppHandle, groups: &[String]) -> Result<Vec<String>, EngineError> {
    let normalized = normalize_serial_groups(groups);
    let content = serde_json::to_string_pretty(&normalized).map_err(|error| {
        EngineError::with_detail(
            "serial_groups_write_failed",
            "无法序列化串口分组文件",
            error.to_string(),
        )
    })?;
    write_atomic(resolve_serial_groups_path(app)?, &content)?;
    Ok(normalized)
}

/// 去除空分组并按不区分大小写的方式去重。
fn normalize_serial_groups(groups: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for group in groups {
        let name = group.trim();
        if name.is_empty()
            || normalized
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(name))
        {
            continue;
        }
        normalized.push(name.to_string());
    }
    normalized
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::normalize_serial_groups;

    #[test]
    fn normalizes_empty_and_duplicate_serial_groups() {
        let groups = vec![
            "  开发板 ".to_string(),
            "".to_string(),
            "开发板".to_string(),
            "DEVICES".to_string(),
            "devices".to_string(),
        ];
        assert_eq!(normalize_serial_groups(&groups), vec!["开发板", "DEVICES"]);
    }
}
