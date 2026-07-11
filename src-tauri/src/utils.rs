//! 通用工具模块。
//!
//! 本模块提供跨业务逻辑复用的底层工具函数，如原子级文件写入等。

use std::fs;
use std::io::Write;
use std::path::Path;

use engine::EngineError;
use serde_json::json;

use crate::telemetry::{TelemetryLevel, log_telemetry};

/// 原子级写入文件。
///
/// 职责：
/// 1. 确保目标目录存在。
/// 2. 先将内容写入同级 `.tmp` 临时文件。
/// 3. 执行 `sync_all` 确保数据真正落盘。
/// 4. 通过 `rename` 覆盖目标文件，确保在磁盘满或进程崩溃时原文件不被损坏。
pub fn write_atomic<P: AsRef<Path>>(path: P, content: &str) -> Result<(), EngineError> {
    let path = path.as_ref();
    let parent = path.parent().ok_or_else(|| {
        EngineError::new(
            "file_write_failed",
            "Failed to resolve the parent directory",
        )
    })?;

    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|err| {
            EngineError::with_detail(
                "file_write_failed",
                "Failed to create the configuration directory",
                err.to_string(),
            )
        })?;
        log_telemetry(
            TelemetryLevel::Debug,
            "file.write.dir.create.success",
            None,
            json!({
                "path": parent.display().to_string(),
            }),
        );
    }

    let temp_path = path.with_extension("tmp");
    let mut temp_file = fs::File::create(&temp_path).map_err(|err| {
        EngineError::with_detail(
            "file_write_failed",
            "Failed to create the temporary file",
            err.to_string(),
        )
    })?;

    temp_file.write_all(content.as_bytes()).map_err(|err| {
        EngineError::with_detail(
            "file_write_failed",
            "Failed to write the temporary file",
            err.to_string(),
        )
    })?;

    // 显式同步以确保数据真正刷入磁盘。
    temp_file.sync_all().map_err(|err| {
        EngineError::with_detail(
            "file_write_failed",
            "Failed to synchronize temporary file data",
            err.to_string(),
        )
    })?;

    // 只有在 sync 成功后才执行覆盖，保证原子性。
    let path_display = path.display().to_string();
    fs::rename(&temp_path, path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        EngineError::with_detail(
            "file_write_failed",
            "Failed to replace the target file",
            err.to_string(),
        )
    })?;

    log_telemetry(
        TelemetryLevel::Debug,
        "file.write.atomic.success",
        None,
        json!({
            "path": path_display,
            "size": content.len(),
        }),
    );

    Ok(())
}
