//! 本地文件操作命令。
use std::path::PathBuf;

use engine::EngineError;
use tauri::{AppHandle, Manager};

use crate::local_fs::local_list_entries;

#[tauri::command]
/// 获取本机家目录路径。
pub fn local_home(app: AppHandle) -> Result<String, EngineError> {
    let path = app.path().home_dir().map_err(|err| {
        EngineError::with_detail(
            crate::utils::LOCAL_HOME_FAILED_CODE,
            "Failed to resolve the local home directory",
            err.to_string(),
        )
    })?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
/// 获取本机目录列表。
pub fn local_list(path: String) -> Result<Vec<engine::SftpEntry>, EngineError> {
    local_list_entries(&path)
}

#[tauri::command]
/// 获取本机可用的 SSH 私钥路径列表（按优先级排序）。
pub fn local_ssh_keys(app: AppHandle) -> Result<Vec<String>, EngineError> {
    let home = app.path().home_dir().map_err(|err| {
        EngineError::with_detail(
            crate::utils::LOCAL_HOME_FAILED_CODE,
            "Failed to resolve the local home directory",
            err.to_string(),
        )
    })?;
    let ssh_dir = home.join(".ssh");
    let candidates = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];
    let mut result = Vec::new();
    for name in candidates {
        let path: PathBuf = ssh_dir.join(name);
        if path.is_file() {
            result.push(path.to_string_lossy().to_string());
        }
    }
    Ok(result)
}
