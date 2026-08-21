//! SFTP 文件操作命令。
use std::sync::Arc;

use fluxterm_engine::{Engine, EngineError, SftpEntry, SftpProgress};
use tauri::State;

use crate::state::EngineState;

#[tauri::command]
/// 获取远端目录列表。
pub async fn sftp_list(
    state: State<'_, EngineState>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let path = path.clone();
        move || engine.sftp_list(&session_id, &path)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to list the SFTP directory",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 获取远端家目录路径。
pub async fn sftp_home(
    state: State<'_, EngineState>,
    session_id: String,
) -> Result<String, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        move || engine.sftp_home(&session_id)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to resolve the SFTP home directory",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 解析远端路径到真实路径。
pub async fn sftp_resolve_path(
    state: State<'_, EngineState>,
    session_id: String,
    path: String,
) -> Result<String, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let path = path.clone();
        move || engine.sftp_resolve_path(&session_id, &path)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to resolve the SFTP path",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 上传本地文件到远端。
pub async fn sftp_upload(
    state: State<'_, EngineState>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<SftpProgress, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let local_path = local_path.clone();
        let remote_path = remote_path.clone();
        move || engine.sftp_upload(&session_id, &local_path, &remote_path)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to upload through SFTP",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 上传一组本地文件或目录到远端目录。
pub async fn sftp_upload_paths(
    state: State<'_, EngineState>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<SftpProgress, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let local_paths = local_paths.clone();
        let remote_dir = remote_dir.clone();
        move || engine.sftp_upload_paths(&session_id, &local_paths, &remote_dir)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to perform the SFTP batch upload",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 下载远端文件到本地。
pub async fn sftp_download(
    state: State<'_, EngineState>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<SftpProgress, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let remote_path = remote_path.clone();
        let local_path = local_path.clone();
        move || engine.sftp_download(&session_id, &remote_path, &local_path)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to download through SFTP",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 下载远端目录到本地目录。
pub async fn sftp_download_dir(
    state: State<'_, EngineState>,
    session_id: String,
    remote_path: String,
    local_dir: String,
) -> Result<SftpProgress, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let remote_path = remote_path.clone();
        let local_dir = local_dir.clone();
        move || engine.sftp_download_dir(&session_id, &remote_path, &local_dir)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to download the SFTP directory",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 取消指定传输任务。
pub async fn sftp_cancel_transfer(
    state: State<'_, EngineState>,
    session_id: String,
    transfer_id: String,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let transfer_id = transfer_id.clone();
        move || engine.sftp_cancel_transfer(&session_id, &transfer_id)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to cancel the SFTP transfer",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 重命名远端文件或目录。
pub async fn sftp_rename(
    state: State<'_, EngineState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let from = from.clone();
        let to = to.clone();
        move || engine.sftp_rename(&session_id, &from, &to)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to rename the SFTP entry",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 删除远端文件。
pub async fn sftp_remove(
    state: State<'_, EngineState>,
    session_id: String,
    path: String,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let path = path.clone();
        move || engine.sftp_remove(&session_id, &path)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to remove the SFTP entry",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 创建远端目录。
pub async fn sftp_mkdir(
    state: State<'_, EngineState>,
    session_id: String,
    path: String,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let path = path.clone();
        move || engine.sftp_mkdir(&session_id, &path)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to create the SFTP directory",
            err.to_string(),
        )
    })?
}
