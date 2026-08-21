//! 配置目录级弱保护密钥存储。

use std::fs;
use std::io::Write;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use fluxterm_engine::EngineError;
use rand::random;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::config_paths::resolve_config_key_path;

const CONFIG_KEY_VERSION: u32 = 1;
const CONFIG_KEY_PREFIX: &str = "config-";
const CONFIG_KEY_LENGTH: usize = 32;
const CONFIG_KEY_INVALID_CODE: &str = "config_key_invalid";
const CONFIG_KEY_WRITE_FAILED_CODE: &str = "config_key_write_failed";
pub(crate) const CONFIG_KEY_MISSING_CODE: &str = "config_key_missing";
pub(crate) const CONFIG_KEY_MISMATCH_CODE: &str = "config_key_mismatch";

/// 配置目录级弱保护密钥。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigKey {
    pub key_id: String,
    pub key_material: [u8; CONFIG_KEY_LENGTH],
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigKeyFile {
    version: u32,
    key_id: String,
    key_material: String,
}

/// 读取当前配置目录中的弱保护密钥。
pub fn read_config_key(app: &AppHandle) -> Result<Option<ConfigKey>, EngineError> {
    read_config_key_from_path(&resolve_config_key_path(app)?)
}

/// 创建并持久化新的配置目录弱保护密钥。
pub fn create_config_key(app: &AppHandle) -> Result<ConfigKey, EngineError> {
    create_config_key_at_path(&resolve_config_key_path(app)?)
}

fn read_config_key_from_path(path: &Path) -> Result<Option<ConfigKey>, EngineError> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|error| {
        EngineError::with_detail(
            "config_key_read_failed",
            "Failed to read the configuration key",
            error.to_string(),
        )
    })?;
    let stored: ConfigKeyFile = serde_json::from_str(&raw).map_err(|error| {
        EngineError::with_detail(
            CONFIG_KEY_INVALID_CODE,
            "The configuration key file is invalid",
            error.to_string(),
        )
    })?;
    decode_config_key(stored).map(Some)
}

fn create_config_key_at_path(path: &Path) -> Result<ConfigKey, EngineError> {
    if path.exists() {
        return read_config_key_from_path(path)?.ok_or_else(|| {
            EngineError::new(
                CONFIG_KEY_INVALID_CODE,
                "The configuration key file is invalid",
            )
        });
    }
    let config_key = ConfigKey {
        key_id: format!("{CONFIG_KEY_PREFIX}{}", Uuid::new_v4()),
        key_material: random(),
    };
    let stored = ConfigKeyFile {
        version: CONFIG_KEY_VERSION,
        key_id: config_key.key_id.clone(),
        key_material: BASE64.encode(config_key.key_material),
    };
    let raw = serde_json::to_string_pretty(&stored).map_err(|error| {
        EngineError::with_detail(
            CONFIG_KEY_WRITE_FAILED_CODE,
            "Failed to serialize the configuration key",
            error.to_string(),
        )
    })?;
    write_new_config_key(path, &raw)?;
    read_config_key_from_path(path)?.ok_or_else(|| {
        EngineError::new(
            CONFIG_KEY_INVALID_CODE,
            "The configuration key file is invalid",
        )
    })
}

fn write_new_config_key(path: &Path, raw: &str) -> Result<(), EngineError> {
    let parent = path.parent().ok_or_else(|| {
        EngineError::new(
            CONFIG_KEY_WRITE_FAILED_CODE,
            "Failed to resolve the configuration key directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        EngineError::with_detail(
            CONFIG_KEY_WRITE_FAILED_CODE,
            "Failed to create the configuration key directory",
            error.to_string(),
        )
    })?;
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => {
            return Err(EngineError::with_detail(
                CONFIG_KEY_WRITE_FAILED_CODE,
                "Failed to create the configuration key file",
                error.to_string(),
            ));
        }
    };
    if let Err(error) = file.write_all(raw.as_bytes()).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(EngineError::with_detail(
            CONFIG_KEY_WRITE_FAILED_CODE,
            "Failed to write the configuration key",
            error.to_string(),
        ));
    }
    Ok(())
}

fn decode_config_key(stored: ConfigKeyFile) -> Result<ConfigKey, EngineError> {
    if stored.version != CONFIG_KEY_VERSION || !stored.key_id.starts_with(CONFIG_KEY_PREFIX) {
        return Err(EngineError::new(
            CONFIG_KEY_INVALID_CODE,
            "The configuration key file is invalid",
        ));
    }
    let decoded = BASE64.decode(&stored.key_material).map_err(|error| {
        EngineError::with_detail(
            CONFIG_KEY_INVALID_CODE,
            "The configuration key file is invalid",
            error.to_string(),
        )
    })?;
    let key_material: [u8; CONFIG_KEY_LENGTH] = decoded.try_into().map_err(|_| {
        EngineError::new(
            CONFIG_KEY_INVALID_CODE,
            "The configuration key must contain exactly 32 bytes",
        )
    })?;
    Ok(ConfigKey {
        key_id: stored.key_id,
        key_material,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::{create_config_key_at_path, read_config_key_from_path};

    fn temp_key_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "fluxterm-config-key-{name}-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn creates_and_reuses_configuration_key() {
        let path = temp_key_path("reuse");
        let created = create_config_key_at_path(&path).expect("create key");
        let loaded = create_config_key_at_path(&path).expect("reuse key");
        assert_eq!(created, loaded);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn independent_paths_receive_different_keys() {
        let first_path = temp_key_path("first");
        let second_path = temp_key_path("second");
        let first = create_config_key_at_path(&first_path).expect("create first key");
        let second = create_config_key_at_path(&second_path).expect("create second key");
        assert_ne!(first, second);
        let _ = std::fs::remove_file(first_path);
        let _ = std::fs::remove_file(second_path);
    }

    #[test]
    fn copied_key_file_preserves_configuration_key() {
        let source_path = temp_key_path("copy-source");
        let target_path = temp_key_path("copy-target");
        let source = create_config_key_at_path(&source_path).expect("create source key");
        std::fs::copy(&source_path, &target_path).expect("copy key file");
        let target = read_config_key_from_path(&target_path)
            .expect("read copied key")
            .expect("copied key should exist");
        assert_eq!(source, target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn concurrent_creation_reuses_single_configuration_key() {
        let path = temp_key_path("concurrent");
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    create_config_key_at_path(&path)
                })
            })
            .collect::<Vec<_>>();
        let keys = handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .expect("key creation thread should finish")
                    .expect("concurrent key creation should succeed")
            })
            .collect::<Vec<_>>();
        assert!(keys.windows(2).all(|pair| pair[0] == pair[1]));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn invalid_key_file_is_not_overwritten() {
        let path = temp_key_path("invalid");
        std::fs::write(
            &path,
            "{\"version\":1,\"keyId\":\"config-bad\",\"keyMaterial\":\"AA==\"}",
        )
        .expect("write invalid key");
        assert!(create_config_key_at_path(&path).is_err());
        assert!(read_config_key_from_path(&path).is_err());
        let raw = std::fs::read_to_string(&path).expect("read invalid key");
        assert!(raw.contains("config-bad"));
        let _ = std::fs::remove_file(path);
    }
}
