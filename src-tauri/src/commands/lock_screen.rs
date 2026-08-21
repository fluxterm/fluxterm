//! 应用锁屏命令与进程内状态。

const LOCK_SCREEN_CONFIG_PARSE_FAILED_CODE: &str = "lock_screen_config_parse_failed";
const LOCK_SCREEN_PASSWORD_HASH_FAILED_CODE: &str = "lock_screen_password_hash_failed";
const LOCK_SCREEN_PASSWORD_INVALID_CODE: &str = "lock_screen_password_invalid";
const LOCK_SCREEN_STATE_UNAVAILABLE_CODE: &str = "lock_screen_state_unavailable";

use std::fs;
use std::sync::Mutex;

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use engine::EngineError;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use uuid::Uuid;

use crate::config_paths::resolve_lock_screen_config_path;
use crate::utils::write_atomic;

const LOCK_SCREEN_CHANGED_EVENT: &str = "lock-screen://changed";

/// 应用锁屏的进程内状态；进程重启后始终恢复为未锁定。
#[derive(Default)]
pub struct LockScreenState {
    runtime: Mutex<LockScreenRuntime>,
}

#[derive(Default)]
struct LockScreenRuntime {
    locked: bool,
    revision: u64,
}

impl LockScreenState {
    fn status(&self) -> Result<LockScreenStatus, EngineError> {
        self.runtime
            .lock()
            .map(|runtime| runtime.status())
            .map_err(|_| {
                EngineError::new(
                    LOCK_SCREEN_STATE_UNAVAILABLE_CODE,
                    "Lock screen state is unavailable",
                )
            })
    }

    fn set_locked(&self, locked: bool) -> Result<LockScreenStatus, EngineError> {
        let mut runtime = self.runtime.lock().map_err(|_| {
            EngineError::new(
                LOCK_SCREEN_STATE_UNAVAILABLE_CODE,
                "Lock screen state is unavailable",
            )
        })?;
        if runtime.locked != locked {
            runtime.locked = locked;
            runtime.revision = runtime.revision.saturating_add(1);
        }
        Ok(runtime.status())
    }
}

impl LockScreenRuntime {
    fn status(&self) -> LockScreenStatus {
        LockScreenStatus {
            locked: self.locked,
            revision: self.revision,
        }
    }
}

/// 应用锁屏状态视图。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockScreenStatus {
    pub locked: bool,
    pub revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockScreenPasswordInput {
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LockScreenConfig {
    version: u32,
    #[serde(default)]
    password_hash: Option<String>,
}

fn require_main_window(window: &WebviewWindow) -> Result<(), EngineError> {
    if window.label() == "main" {
        return Ok(());
    }
    Err(EngineError::new(
        "lock_screen_main_window_required",
        "The lock screen can only be changed from the main window",
    ))
}

fn read_config(app: &AppHandle) -> Result<LockScreenConfig, EngineError> {
    let path = resolve_lock_screen_config_path(app)?;
    if !path.exists() {
        return Ok(LockScreenConfig {
            version: 1,
            password_hash: None,
        });
    }
    let content = fs::read_to_string(path).map_err(|err| {
        EngineError::with_detail(
            "lock_screen_config_read_failed",
            "Failed to read the lock screen settings",
            err.to_string(),
        )
    })?;
    serde_json::from_str(&content).map_err(|err| {
        EngineError::with_detail(
            LOCK_SCREEN_CONFIG_PARSE_FAILED_CODE,
            "Failed to parse the lock screen settings",
            err.to_string(),
        )
    })
}

fn write_config(app: &AppHandle, password: &str) -> Result<(), EngineError> {
    let password_hash = hash_password(password)?;
    let config = LockScreenConfig {
        version: 1,
        password_hash,
    };
    let content = serde_json::to_string_pretty(&config).map_err(|err| {
        EngineError::with_detail(
            "lock_screen_config_write_failed",
            "Failed to serialize the lock screen settings",
            err.to_string(),
        )
    })?;
    write_atomic(resolve_lock_screen_config_path(app)?, &content)
}

fn hash_password(password: &str) -> Result<Option<String>, EngineError> {
    if password.is_empty() {
        return Ok(None);
    }
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|err| {
        EngineError::with_detail(
            LOCK_SCREEN_PASSWORD_HASH_FAILED_CODE,
            "Failed to generate the lock screen password salt",
            err.to_string(),
        )
    })?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| Some(hash.to_string()))
        .map_err(|err| {
            EngineError::with_detail(
                LOCK_SCREEN_PASSWORD_HASH_FAILED_CODE,
                "Failed to hash the lock screen password",
                err.to_string(),
            )
        })
}

fn verify_password(config: &LockScreenConfig, password: &str) -> Result<(), EngineError> {
    let Some(encoded) = config.password_hash.as_deref() else {
        return if password.is_empty() {
            Ok(())
        } else {
            Err(EngineError::new(
                LOCK_SCREEN_PASSWORD_INVALID_CODE,
                "Lock screen password is invalid",
            ))
        };
    };
    let hash = PasswordHash::new(encoded).map_err(|err| {
        EngineError::with_detail(
            LOCK_SCREEN_CONFIG_PARSE_FAILED_CODE,
            "Failed to parse the lock screen password hash",
            err.to_string(),
        )
    })?;
    Argon2::default()
        .verify_password(password.as_bytes(), &hash)
        .map_err(|_| {
            EngineError::new(
                LOCK_SCREEN_PASSWORD_INVALID_CODE,
                "Lock screen password is invalid",
            )
        })
}

fn emit_status(app: &AppHandle, status: LockScreenStatus) -> Result<(), EngineError> {
    app.emit(LOCK_SCREEN_CHANGED_EVENT, status).map_err(|err| {
        EngineError::with_detail(
            "lock_screen_event_failed",
            "Failed to broadcast the lock screen state",
            err.to_string(),
        )
    })
}

/// 读取当前应用锁屏状态。
#[tauri::command]
pub fn lock_screen_status(
    state: State<'_, LockScreenState>,
) -> Result<LockScreenStatus, EngineError> {
    state.status()
}

/// 从主窗口进入锁屏状态。
#[tauri::command]
pub fn lock_screen(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, LockScreenState>,
) -> Result<LockScreenStatus, EngineError> {
    require_main_window(&window)?;
    let status = state.set_locked(true)?;
    emit_status(&app, status)?;
    Ok(status)
}

/// 使用独立锁屏密码从主窗口解锁应用界面。
#[tauri::command]
pub fn unlock_screen(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, LockScreenState>,
    input: LockScreenPasswordInput,
) -> Result<LockScreenStatus, EngineError> {
    require_main_window(&window)?;
    verify_password(&read_config(&app)?, &input.password)?;
    let status = state.set_locked(false)?;
    emit_status(&app, status)?;
    Ok(status)
}

/// 更新独立锁屏密码；空字符串表示使用空密码。
#[tauri::command]
pub fn lock_screen_password_set(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, LockScreenState>,
    input: LockScreenPasswordInput,
) -> Result<LockScreenStatus, EngineError> {
    require_main_window(&window)?;
    let status = state.status()?;
    if status.locked {
        return Err(EngineError::new(
            "lock_screen_password_change_locked",
            "Exit the lock screen before changing its password",
        ));
    }
    write_config(&app, &input.password)?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_state_defaults_to_unlocked() {
        let status = LockScreenState::default().status().expect("state");
        assert!(!status.locked);
        assert_eq!(status.revision, 0);
    }

    #[test]
    fn revision_only_advances_when_lock_state_changes() {
        let state = LockScreenState::default();
        assert_eq!(state.set_locked(true).expect("lock").revision, 1);
        assert_eq!(state.set_locked(true).expect("lock again").revision, 1);
        assert_eq!(state.set_locked(false).expect("unlock").revision, 2);
    }

    #[test]
    fn empty_password_only_accepts_empty_input() {
        let config = LockScreenConfig {
            version: 1,
            password_hash: None,
        };
        assert!(verify_password(&config, "").is_ok());
        assert!(verify_password(&config, "unexpected").is_err());
    }

    #[test]
    fn non_empty_password_roundtrips_and_rejects_invalid_input() {
        let config = LockScreenConfig {
            version: 1,
            password_hash: hash_password("1234").expect("hash"),
        };
        assert!(verify_password(&config, "1234").is_ok());
        assert!(verify_password(&config, "4321").is_err());
        assert!(verify_password(&config, "").is_err());
    }
}
