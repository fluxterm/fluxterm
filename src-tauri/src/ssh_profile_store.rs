//! SSH 主机配置存储。

use std::fs;
use std::path::PathBuf;

use engine::{EngineError, HostProfile};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config_paths::{resolve_ssh_groups_path, resolve_ssh_profiles_path};
use crate::utils::write_atomic;

/// SSH 主机配置文件结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshProfileStore {
    pub version: u32,
    pub updated_at: u64,
    #[serde(default)]
    pub profiles: Vec<HostProfile>,
}

impl Default for SshProfileStore {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: now_epoch(),
            profiles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GroupStore {
    version: u32,
    updated_at: u64,
    #[serde(default)]
    groups: Vec<String>,
}

impl Default for GroupStore {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: now_epoch(),
            groups: Vec::new(),
        }
    }
}

pub fn read_ssh_profiles(app: &AppHandle) -> Result<SshProfileStore, EngineError> {
    let path = profiles_path(app)?;
    if !path.exists() {
        return Ok(SshProfileStore::default());
    }
    let content = fs::read_to_string(&path).map_err(|err| {
        EngineError::with_detail(
            "ssh_profile_read_failed",
            "Failed to read the SSH profile file",
            err.to_string(),
        )
    })?;
    serde_json::from_str(&content).map_err(|err| {
        EngineError::with_detail(
            "ssh_profile_parse_failed",
            "Failed to parse the SSH profile file",
            err.to_string(),
        )
    })
}

pub fn write_ssh_profiles(app: &AppHandle, store: &SshProfileStore) -> Result<(), EngineError> {
    let path = profiles_path(app)?;
    let content = serde_json::to_string_pretty(store).map_err(|err| {
        EngineError::with_detail(
            "ssh_profile_write_failed",
            "Failed to serialize the SSH profile file",
            err.to_string(),
        )
    })?;
    write_atomic(path, &content)
}

pub fn read_ssh_groups(app: &AppHandle) -> Result<Vec<String>, EngineError> {
    let path = groups_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|err| {
        EngineError::with_detail(
            "ssh_group_read_failed",
            "Failed to read the SSH group file",
            err.to_string(),
        )
    })?;
    let store: GroupStore = serde_json::from_str(&content).map_err(|err| {
        EngineError::with_detail(
            "ssh_group_parse_failed",
            "Failed to parse the SSH group file",
            err.to_string(),
        )
    })?;
    Ok(store.groups)
}

pub fn write_ssh_groups(app: &AppHandle, groups: &[String]) -> Result<(), EngineError> {
    let path = groups_path(app)?;
    let content = serde_json::to_string_pretty(&GroupStore {
        version: 1,
        updated_at: now_epoch(),
        groups: groups.to_vec(),
    })
    .map_err(|err| {
        EngineError::with_detail(
            "ssh_group_write_failed",
            "Failed to serialize the SSH group file",
            err.to_string(),
        )
    })?;
    write_atomic(path, &content)
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    resolve_ssh_profiles_path(app)
}

fn groups_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    resolve_ssh_groups_path(app)
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
