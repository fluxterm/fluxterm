//! 本地文件打开命令。
use std::path::Path;
use std::time::Instant;

use fluxterm_engine::EngineError;
use fluxterm_logging::{LogLevel, create_operation_id, log_event};
use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// 使用默认编辑器或系统默认程序打开本地文件。
#[tauri::command]
pub fn file_open(
    app: AppHandle,
    file_path: String,
    default_editor_path: Option<String>,
) -> Result<(), EngineError> {
    let operation_id = create_operation_id();
    let started_at = Instant::now();
    if !Path::new(&file_path).is_file() {
        return Err(EngineError::new(
            crate::utils::FILE_OPEN_FAILED_CODE,
            "The target file does not exist or is inaccessible",
        ));
    }

    if let Some(editor_path) = default_editor_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if Path::new(&editor_path).is_file() {
            match app.opener().open_path(&file_path, Some(&editor_path)) {
                Ok(()) => {
                    log_event!(
                        LogLevel::Info,
                        "file.open.succeeded",
                        Some(operation_id.as_str()),
                        json!({
                            "opener": "configuredEditor",
                            "durationMs": u64::try_from(started_at.elapsed().as_millis())
                                .unwrap_or(u64::MAX),
                        }),
                    );
                    return Ok(());
                }
                Err(error) => {
                    log_event!(
                        LogLevel::Warn,
                        "file.open.fallback",
                        Some(operation_id.as_str()),
                        json!({
                            "error": {
                                "code": "file_open_editor_failed",
                                "message": "The default editor failed; falling back to the system opener",
                                "detail": error.to_string(),
                            }
                        }),
                    );
                }
            }
        } else {
            log_event!(
                LogLevel::Warn,
                "file.open.editor.invalid",
                Some(operation_id.as_str()),
                json!({
                    "error": {
                        "code": "file_open_editor_invalid",
                        "message": "The default editor path is invalid",
                        "detail": Option::<String>::None,
                    }
                }),
            );
        }
    }

    match app.opener().open_path(&file_path, None::<&str>) {
        Ok(()) => {
            log_event!(
                LogLevel::Info,
                "file.open.succeeded",
                Some(operation_id.as_str()),
                json!({
                    "opener": "system",
                    "durationMs": u64::try_from(started_at.elapsed().as_millis())
                        .unwrap_or(u64::MAX),
                }),
            );
            Ok(())
        }
        Err(error) => {
            let error = EngineError::with_detail(
                crate::utils::FILE_OPEN_FAILED_CODE,
                "Failed to open the file",
                error.to_string(),
            );
            log_event!(
                LogLevel::Warn,
                "file.open.failed",
                Some(operation_id.as_str()),
                json!({
                    "durationMs": u64::try_from(started_at.elapsed().as_millis())
                        .unwrap_or(u64::MAX),
                    "error": {
                        "code": &error.code,
                        "message": &error.message,
                        "detail": &error.details,
                    }
                }),
            );
            Err(error)
        }
    }
}
