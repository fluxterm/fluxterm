//! 远端文件编辑命令。
const REMOTE_EDIT_NOT_FOUND_CODE: &str = "remote_edit_not_found";

use std::time::Instant;

use fluxterm_engine::SftpEntry;
use fluxterm_logging::{LogLevel, log_event};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::remote_edit::{
    RemoteEditSnapshot, RemoteEditState, RemoteEditStatus, RemoteEditTarget,
    emit_remote_edit_update, persist_remote_edit_instance, remote_edit_prepare_open,
    spawn_remote_edit_monitor,
};
use crate::state::EngineState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
/// 打开远端编辑会话所需的完整请求。
pub struct RemoteEditOpenRequest {
    session_id: String,
    target: RemoteEditTarget,
    entry: SftpEntry,
    default_editor_path: Option<String>,
    operation_id: String,
}

#[tauri::command]
/// 打开远端文件并登记远端编辑实例。
pub async fn remote_edit_open(
    app: AppHandle,
    state: State<'_, EngineState>,
    remote_edit_state: State<'_, RemoteEditState>,
    request: RemoteEditOpenRequest,
) -> Result<RemoteEditSnapshot, fluxterm_engine::EngineError> {
    let RemoteEditOpenRequest {
        session_id,
        target,
        entry,
        default_editor_path,
        operation_id,
    } = request;
    let started_at = Instant::now();
    let engine = std::sync::Arc::clone(&state.engine);
    let app_handle = app.clone();
    let session_id_for_open = session_id.clone();
    let target_for_open = target.clone();
    let entry_for_open = entry.clone();
    let default_editor_path_for_open = default_editor_path.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        remote_edit_prepare_open(
            &app_handle,
            &engine,
            &session_id_for_open,
            &target_for_open,
            &entry_for_open,
            default_editor_path_for_open.as_deref(),
        )
    })
    .await;
    let prepared = match prepared {
        Ok(result) => result,
        Err(error) => Err(fluxterm_engine::EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to open the remote edit session",
            error.to_string(),
        )),
    };
    let (snapshot, instance) = match prepared {
        Ok(value) => value,
        Err(error) => {
            log_event!(
                LogLevel::Warn,
                "remote.edit.open.failed",
                Some(operation_id.as_str()),
                json!({
                    "sessionId": session_id,
                    "durationMs": started_at.elapsed().as_millis() as u64,
                    "error": {
                        "code": &error.code,
                        "message": "Remote edit session could not be opened",
                        "detail": &error.details,
                    },
                }),
            );
            return Err(error);
        }
    };
    if let Some(instance) = instance {
        let instance = remote_edit_state.upsert(instance).await;
        emit_remote_edit_update(&app, &snapshot);
        spawn_remote_edit_monitor(app.clone(), instance).await;
    }
    log_event!(
        LogLevel::Info,
        "remote.edit.open.succeeded",
        Some(operation_id.as_str()),
        json!({
            "sessionId": snapshot.session_id,
            "instanceId": snapshot.instance_id,
            "trackChanges": snapshot.track_changes,
            "durationMs": started_at.elapsed().as_millis() as u64,
        }),
    );
    Ok(snapshot)
}

#[tauri::command]
/// 列出当前活动的远端编辑实例。
pub async fn remote_edit_list(
    remote_edit_state: State<'_, RemoteEditState>,
) -> Result<Vec<RemoteEditSnapshot>, fluxterm_engine::EngineError> {
    Ok(remote_edit_state.list().await)
}

#[tauri::command]
/// 确认上传远端文件当前修改。
pub async fn remote_edit_confirm_upload(
    app: AppHandle,
    state: State<'_, EngineState>,
    remote_edit_state: State<'_, RemoteEditState>,
    instance_id: String,
    operation_id: String,
) -> Result<RemoteEditSnapshot, fluxterm_engine::EngineError> {
    let started_at = Instant::now();
    let Some(instance) = remote_edit_state.get(&instance_id).await else {
        return Err(fluxterm_engine::EngineError::new(
            REMOTE_EDIT_NOT_FOUND_CODE,
            "Remote edit session not found",
        )
        .with_message_key("sftp.remoteEdit.instanceMissing"));
    };
    {
        let mut guard = instance.lock().await;
        if guard.pending_snapshot.is_none() {
            return Err(fluxterm_engine::EngineError::new(
                "remote_edit_not_pending",
                "The remote edit session has no pending changes",
            )
            .with_message_key("sftp.remoteEdit.notPending"));
        }
        guard.snapshot.status = RemoteEditStatus::Uploading;
        guard.snapshot.last_error_code = None;
        guard.snapshot.last_error = None;
        emit_remote_edit_update(&app, &guard.snapshot);
    }

    let engine = std::sync::Arc::clone(&state.engine);
    let (session_id, remote_path, local_path, remote_mtime, remote_size) = {
        let guard = instance.lock().await;
        (
            guard.snapshot.session_id.clone(),
            guard.snapshot.remote_path.clone(),
            guard.snapshot.local_path.clone(),
            guard.snapshot.remote_mtime,
            guard.snapshot.remote_size,
        )
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        let remote_before_upload = engine.sftp_stat(&session_id, &remote_path)?;
        if remote_before_upload.mtime != remote_mtime || remote_before_upload.size != remote_size {
            return Err(fluxterm_engine::EngineError::new(
                "remote_edit_conflict",
                "The remote file changed and local modifications were not uploaded",
            )
            .with_message_key("sftp.remoteEdit.remoteChanged"));
        }

        engine.sftp_upload(&session_id, &local_path, &remote_path)?;
        let remote_after_upload = engine.sftp_stat(&session_id, &remote_path)?;
        let local_snapshot =
            crate::remote_edit::read_local_file_snapshot(std::path::Path::new(&local_path))?;
        Ok((remote_after_upload, local_snapshot))
    })
    .await
    .map_err(|err| {
        fluxterm_engine::EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to upload the remote edit working copy",
            err.to_string(),
        )
    })?;

    match result {
        Ok((remote_after_upload, local_snapshot)) => {
            let snapshot = {
                let mut guard = instance.lock().await;
                guard.baseline = local_snapshot;
                guard.pending_snapshot = None;
                guard.ignored_content_hash = None;
                guard.snapshot.remote_mtime = remote_after_upload.mtime;
                guard.snapshot.remote_size = remote_after_upload.size;
                guard.snapshot.status = RemoteEditStatus::Synced;
                guard.snapshot.last_synced_at = crate::remote_edit::now_epoch_millis();
                guard.snapshot.last_error_code = None;
                guard.snapshot.last_error = None;
                persist_remote_edit_instance(&app, &guard)?;
                log_event!(
                    LogLevel::Info,
                    "remote.edit.upload.succeeded",
                    Some(operation_id.as_str()),
                    json!({
                        "sessionId": guard.snapshot.session_id,
                        "instanceId": guard.snapshot.instance_id,
                        "bytes": guard.snapshot.remote_size,
                        "durationMs": started_at.elapsed().as_millis() as u64,
                    }),
                );
                emit_remote_edit_update(&app, &guard.snapshot);
                guard.snapshot.clone()
            };
            Ok(snapshot)
        }
        Err(error) => {
            let snapshot = {
                let mut guard = instance.lock().await;
                guard.ignored_content_hash = guard
                    .pending_snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.content_hash.clone());
                guard.snapshot.status = RemoteEditStatus::SyncFailed;
                guard.snapshot.last_error_code = Some(error.code.clone());
                guard.snapshot.last_error = Some(error.message.clone());
                guard.pending_snapshot = None;
                log_event!(
                    LogLevel::Warn,
                    "remote.edit.upload.failed",
                    Some(operation_id.as_str()),
                    json!({
                        "sessionId": guard.snapshot.session_id,
                        "instanceId": guard.snapshot.instance_id,
                        "durationMs": started_at.elapsed().as_millis() as u64,
                        "error": {
                            "code": error.code,
                            "message": "Remote edit changes could not be uploaded",
                            "detail": error.details,
                        },
                    }),
                );
                emit_remote_edit_update(&app, &guard.snapshot);
                guard.snapshot.clone()
            };
            Ok(snapshot)
        }
    }
}

#[tauri::command]
/// 忽略当前待确认的本地修改。
pub async fn remote_edit_dismiss_pending(
    app: AppHandle,
    remote_edit_state: State<'_, RemoteEditState>,
    instance_id: String,
    operation_id: String,
) -> Result<RemoteEditSnapshot, fluxterm_engine::EngineError> {
    let Some(instance) = remote_edit_state.get(&instance_id).await else {
        return Err(fluxterm_engine::EngineError::new(
            REMOTE_EDIT_NOT_FOUND_CODE,
            "Remote edit session not found",
        )
        .with_message_key("sftp.remoteEdit.instanceMissing"));
    };
    let snapshot = {
        let mut guard = instance.lock().await;
        let ignored_hash = guard
            .pending_snapshot
            .as_ref()
            .map(|snapshot| snapshot.content_hash.clone());
        guard.ignored_content_hash = ignored_hash;
        guard.pending_snapshot = None;
        guard.snapshot.status = if guard.snapshot.last_error.is_some() {
            RemoteEditStatus::SyncFailed
        } else {
            RemoteEditStatus::Synced
        };
        if !matches!(guard.snapshot.status, RemoteEditStatus::SyncFailed) {
            guard.snapshot.last_error_code = None;
        }
        log_event!(
            LogLevel::Info,
            "remote.edit.upload.cancelled",
            Some(operation_id.as_str()),
            json!({
                "sessionId": guard.snapshot.session_id,
                "instanceId": guard.snapshot.instance_id,
            }),
        );
        emit_remote_edit_update(&app, &guard.snapshot);
        guard.snapshot.clone()
    };
    Ok(snapshot)
}
