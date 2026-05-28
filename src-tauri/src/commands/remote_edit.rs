//! 远端文件编辑命令。
use engine::SftpEntry;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::remote_edit::{
    RemoteEditSnapshot, RemoteEditState, RemoteEditStatus, RemoteEditTarget,
    emit_remote_edit_update, persist_remote_edit_instance, remote_edit_prepare_open,
    spawn_remote_edit_monitor,
};
use crate::state::EngineState;
use crate::telemetry::{TelemetryLevel, log_telemetry};

#[tauri::command]
/// 打开远端文件并登记远端编辑实例。
pub async fn remote_edit_open(
    app: AppHandle,
    state: State<'_, EngineState>,
    remote_edit_state: State<'_, RemoteEditState>,
    session_id: String,
    target: RemoteEditTarget,
    entry: SftpEntry,
    default_editor_path: Option<String>,
) -> Result<RemoteEditSnapshot, engine::EngineError> {
    let engine = std::sync::Arc::clone(&state.engine);
    let app_handle = app.clone();
    let session_id_for_open = session_id.clone();
    let target_for_open = target.clone();
    let entry_for_open = entry.clone();
    let default_editor_path_for_open = default_editor_path.clone();
    let (snapshot, instance) = tauri::async_runtime::spawn_blocking(move || {
        remote_edit_prepare_open(
            &app_handle,
            &engine,
            &session_id_for_open,
            &target_for_open,
            &entry_for_open,
            default_editor_path_for_open.as_deref(),
        )
    })
    .await
    .map_err(|err| {
        engine::EngineError::with_detail(
            "session_command_failed",
            "无法执行远端编辑打开",
            err.to_string(),
        )
    })??;
    if let Some(instance) = instance {
        let instance = remote_edit_state.upsert(instance).await;
        emit_remote_edit_update(&app, &snapshot);
        spawn_remote_edit_monitor(app.clone(), instance).await;
    }
    log_telemetry(
        TelemetryLevel::Info,
        "remote.edit.open.success",
        None,
        json!({
            "sessionId": snapshot.session_id,
            "instanceId": snapshot.instance_id,
            "remotePath": snapshot.remote_path,
            "trackChanges": snapshot.track_changes,
        }),
    );
    Ok(snapshot)
}

#[tauri::command]
/// 列出当前活动的远端编辑实例。
pub async fn remote_edit_list(
    remote_edit_state: State<'_, RemoteEditState>,
) -> Result<Vec<RemoteEditSnapshot>, engine::EngineError> {
    Ok(remote_edit_state.list().await)
}

#[tauri::command]
/// 确认上传远端文件当前修改。
pub async fn remote_edit_confirm_upload(
    app: AppHandle,
    state: State<'_, EngineState>,
    remote_edit_state: State<'_, RemoteEditState>,
    instance_id: String,
) -> Result<RemoteEditSnapshot, engine::EngineError> {
    let Some(instance) = remote_edit_state.get(&instance_id).await else {
        return Err(engine::EngineError::new(
            "remote_edit_not_found",
            "远端编辑实例不存在",
        ));
    };
    {
        let mut guard = instance.lock().await;
        if guard.pending_snapshot.is_none() {
            return Err(engine::EngineError::new(
                "remote_edit_not_pending",
                "当前远端编辑实例没有待确认的修改",
            ));
        }
        guard.snapshot.status = RemoteEditStatus::Uploading;
        guard.snapshot.last_error_code = None;
        guard.snapshot.last_error = None;
        log_telemetry(
            TelemetryLevel::Info,
            "remote.edit.upload.started",
            None,
            json!({
                "sessionId": guard.snapshot.session_id,
                "instanceId": guard.snapshot.instance_id,
                "remotePath": guard.snapshot.remote_path,
            }),
        );
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
            return Err(engine::EngineError::new(
                "remote_edit_conflict",
                "远端文件已发生变化，当前修改未回传",
            ));
        }

        engine.sftp_upload(&session_id, &local_path, &remote_path)?;
        let remote_after_upload = engine.sftp_stat(&session_id, &remote_path)?;
        let local_snapshot =
            crate::remote_edit::read_local_file_snapshot(std::path::Path::new(&local_path))?;
        Ok((remote_after_upload, local_snapshot))
    })
    .await
    .map_err(|err| {
        engine::EngineError::with_detail(
            "session_command_failed",
            "无法执行远端编辑上传",
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
                log_telemetry(
                    TelemetryLevel::Info,
                    "remote.edit.upload.success",
                    None,
                    json!({
                        "sessionId": guard.snapshot.session_id,
                        "instanceId": guard.snapshot.instance_id,
                        "remotePath": guard.snapshot.remote_path,
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
                log_telemetry(
                    TelemetryLevel::Warn,
                    "remote.edit.upload.failed",
                    None,
                    json!({
                        "sessionId": guard.snapshot.session_id,
                        "instanceId": guard.snapshot.instance_id,
                        "remotePath": guard.snapshot.remote_path,
                        "errorCode": error.code,
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
) -> Result<RemoteEditSnapshot, engine::EngineError> {
    let Some(instance) = remote_edit_state.get(&instance_id).await else {
        return Err(engine::EngineError::new(
            "remote_edit_not_found",
            "远端编辑实例不存在",
        ));
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
        log_telemetry(
            TelemetryLevel::Info,
            "remote.edit.upload.dismissed",
            None,
            json!({
                "sessionId": guard.snapshot.session_id,
                "instanceId": guard.snapshot.instance_id,
                "remotePath": guard.snapshot.remote_path,
            }),
        );
        emit_remote_edit_update(&app, &guard.snapshot);
        guard.snapshot.clone()
    };
    Ok(snapshot)
}
