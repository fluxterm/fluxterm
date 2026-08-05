//! 前端配置文档与背景资源的受限存储命令。

use std::fs;
use std::path::{Component, Path, PathBuf};

use engine::EngineError;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use uuid::Uuid;

use crate::config_paths::{
    resolve_config_root_dir, resolve_global_config_dir, resolve_terminal_config_dir,
};
use crate::utils::write_atomic;

const BACKGROUND_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "mp4", "webm", "ogv", "mov", "m4v",
];

/// 允许前端读写的配置文档。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigDocument {
    /// 应用界面设置。
    AppSettings,
    /// 主窗口布局。
    Layout,
    /// 快捷命令栏。
    Quickbar,
    /// 终端会话设置。
    Session,
    /// 命令历史。
    CommandHistory,
}

fn resolve_document_path(
    app: &AppHandle,
    document: ConfigDocument,
) -> Result<PathBuf, EngineError> {
    match document {
        ConfigDocument::AppSettings => Ok(resolve_global_config_dir(app)?.join("settings.json")),
        ConfigDocument::Layout => Ok(resolve_global_config_dir(app)?.join("layout.json")),
        ConfigDocument::Quickbar => Ok(resolve_global_config_dir(app)?.join("quickbar.json")),
        ConfigDocument::Session => Ok(resolve_global_config_dir(app)?.join("session.json")),
        ConfigDocument::CommandHistory => {
            Ok(resolve_terminal_config_dir(app)?.join("command-history.json"))
        }
    }
}

/// 读取白名单中的配置文档；文件不存在时返回 `None`。
#[tauri::command]
pub fn config_read_text(
    app: AppHandle,
    document: ConfigDocument,
) -> Result<Option<String>, EngineError> {
    let path = resolve_document_path(&app, document)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(EngineError::with_detail(
            "config_document_read_failed",
            "Failed to read the configuration document",
            error.to_string(),
        )),
    }
}

/// 原子写入白名单中的配置文档。
#[tauri::command]
pub fn config_write_text(
    app: AppHandle,
    document: ConfigDocument,
    content: String,
) -> Result<(), EngineError> {
    serde_json::from_str::<serde_json::Value>(&content).map_err(|error| {
        EngineError::with_detail(
            "config_document_invalid",
            "The configuration document must contain valid JSON",
            error.to_string(),
        )
    })?;
    let path = resolve_document_path(&app, document)?;
    write_atomic(path, &content)
}

/// 将用户选择的背景媒体复制到当前配置目录，并返回可持久化的相对资源标识。
#[tauri::command]
pub fn background_import(app: AppHandle, source_path: String) -> Result<String, EngineError> {
    let source = PathBuf::from(source_path);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| BACKGROUND_EXTENSIONS.contains(&value.as_str()))
        .ok_or_else(|| {
            EngineError::new(
                "background_extension_unsupported",
                "The selected background media type is unsupported",
            )
        })?;
    let bytes = fs::read(&source).map_err(|error| {
        EngineError::with_detail(
            "background_source_read_failed",
            "Failed to read the selected background media",
            error.to_string(),
        )
    })?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let file_name = format!("bg-{digest}.{extension}");
    let asset = format!("backgrounds/{file_name}");
    let backgrounds_dir = resolve_global_config_dir(&app)?.join("backgrounds");
    fs::create_dir_all(&backgrounds_dir).map_err(|error| {
        EngineError::with_detail(
            "background_directory_create_failed",
            "Failed to create the background media directory",
            error.to_string(),
        )
    })?;
    let target = backgrounds_dir.join(file_name);
    if !target.exists() {
        write_binary_atomic(&target, &bytes)?;
    }
    Ok(asset)
}

/// 读取配置目录中的背景媒体字节。
#[tauri::command]
pub fn background_read(app: AppHandle, asset: String) -> Result<Vec<u8>, EngineError> {
    let path = resolve_background_asset_path(&app, &asset)?;
    fs::read(path).map_err(|error| {
        EngineError::with_detail(
            "background_read_failed",
            "Failed to read the background media",
            error.to_string(),
        )
    })
}

/// 删除配置目录中的背景媒体；文件不存在时视为成功。
#[tauri::command]
pub fn background_delete(app: AppHandle, asset: String) -> Result<(), EngineError> {
    let path = resolve_background_asset_path(&app, &asset)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(EngineError::with_detail(
            "background_delete_failed",
            "Failed to delete the background media",
            error.to_string(),
        )),
    }
}

fn resolve_background_asset_path(app: &AppHandle, asset: &str) -> Result<PathBuf, EngineError> {
    let relative = Path::new(asset);
    let components = relative.components().collect::<Vec<_>>();
    let valid = matches!(components.as_slice(), [Component::Normal(directory), Component::Normal(file)]
        if directory == &std::ffi::OsStr::new("backgrounds")
            && valid_background_file_name(file));
    if !valid {
        return Err(EngineError::new(
            "background_asset_invalid",
            "The background asset path is invalid",
        ));
    }
    Ok(resolve_config_root_dir(app)?.join("global").join(relative))
}

fn valid_background_file_name(file_name: &std::ffi::OsStr) -> bool {
    let path = Path::new(file_name);
    path.file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.starts_with("bg-") && value.len() > 3)
        && path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .is_some_and(|value| BACKGROUND_EXTENSIONS.contains(&value.as_str()))
}

fn write_binary_atomic(path: &Path, bytes: &[u8]) -> Result<(), EngineError> {
    let parent = path.parent().ok_or_else(|| {
        EngineError::new(
            "background_write_failed",
            "Failed to resolve the background media directory",
        )
    })?;
    let temporary = parent.join(format!(".background-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|error| {
        EngineError::with_detail(
            "background_write_failed",
            "Failed to write the background media",
            error.to_string(),
        )
    })?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        EngineError::with_detail(
            "background_write_failed",
            "Failed to commit the background media",
            error.to_string(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::valid_background_file_name;
    use std::ffi::OsStr;

    #[test]
    fn background_file_name_accepts_generated_assets() {
        assert!(valid_background_file_name(OsStr::new("bg-abc123.png")));
    }

    #[test]
    fn background_file_name_rejects_traversal_and_unknown_extensions() {
        assert!(!valid_background_file_name(OsStr::new("settings.json")));
        assert!(!valid_background_file_name(OsStr::new("bg-abc123.svg")));
    }
}
