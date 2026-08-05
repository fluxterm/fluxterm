//! 应用配置目录路径解析与位置管理。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use engine::EngineError;
use fluxterm_logging::{LogLevel, log_event};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::utils::write_atomic;

const CONFIG_DIR_ENV_KEY: &str = "FLUXTERM_CONFIG_DIR";
const DEFAULT_CONFIG_DIR_NAME: &str = ".vust/fluxterm";
const CUSTOM_CONFIG_DIR_NAME: &str = "fluxterm";
const BOOTSTRAP_FILE_NAME: &str = "bootstrap.json";

/// 配置目录来源。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConfigDirectorySource {
    /// 环境变量覆盖。
    Environment,
    /// 用户通过设置页选择。
    User,
    /// 应用默认目录。
    Default,
}

/// 提供给前端的配置目录状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDirectoryStatus {
    /// 当前进程固定使用的配置根目录。
    pub active_dir: String,
    /// 当前目录来源。
    pub source: ConfigDirectorySource,
    /// 当前目录是否通过启动校验。
    pub ready: bool,
    /// 启动校验失败原因。
    pub error: Option<String>,
    /// 已保存、将在下次启动生效的配置根目录。
    pub pending_dir: Option<String>,
    /// 是否由环境变量锁定。
    pub env_override: bool,
    /// 最近一次由用户确认的应用语言。
    pub locale: Option<String>,
}

/// 正常配置加载前所需的最小启动信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapFile {
    version: u32,
    #[serde(default)]
    config_dir: Option<PathBuf>,
    #[serde(default)]
    locale: Option<String>,
}

#[derive(Debug)]
struct ConfigDirectorySnapshot {
    active_root: PathBuf,
    source: ConfigDirectorySource,
    ready: bool,
    error: Option<String>,
    pending_root: Option<PathBuf>,
    bootstrap_config_root: Option<PathBuf>,
    locale: Option<String>,
}

/// 进程级配置目录状态。
///
/// `active_root` 在进程生命周期内保持不变；设置页只更新 `pending_root`，
/// 从而避免切换目录时不同窗口或防抖写入发生跨目录混写。
#[derive(Debug)]
pub struct ConfigDirectoryState {
    snapshot: RwLock<ConfigDirectorySnapshot>,
    bootstrap_path: PathBuf,
    default_root: PathBuf,
}

impl ConfigDirectoryState {
    /// 返回当前状态快照。
    pub fn status(&self) -> ConfigDirectoryStatus {
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(|error| error.into_inner());
        ConfigDirectoryStatus {
            active_dir: snapshot.active_root.to_string_lossy().into_owned(),
            source: snapshot.source,
            ready: snapshot.ready,
            error: snapshot.error.clone(),
            pending_dir: snapshot
                .pending_root
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            env_override: snapshot.source == ConfigDirectorySource::Environment,
            locale: snapshot.locale.clone(),
        }
    }

    /// 返回当前进程固定使用的有效配置根目录。
    fn active_root(&self) -> Result<PathBuf, EngineError> {
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(|error| error.into_inner());
        if snapshot.ready {
            return Ok(snapshot.active_root.clone());
        }
        Err(EngineError::with_detail(
            "config_directory_unavailable",
            "The configured directory is unavailable",
            snapshot
                .error
                .clone()
                .unwrap_or_else(|| "Unknown configuration directory error".to_string()),
        ))
    }

    /// 保存用户选择的父目录，实际配置根固定为其下的 `fluxterm`。
    pub fn select_parent(&self, parent: &Path) -> Result<ConfigDirectoryStatus, EngineError> {
        self.ensure_not_environment_locked()?;
        if !parent.is_absolute() {
            return Err(EngineError::new(
                "config_parent_invalid",
                "The selected configuration parent directory must be absolute",
            ));
        }
        if !parent.is_dir() {
            return Err(EngineError::new(
                "config_parent_invalid",
                "The selected configuration parent directory does not exist",
            ));
        }

        let selected_parent = parent.to_path_buf();
        let target = selected_parent.join(CUSTOM_CONFIG_DIR_NAME);
        validate_directory(&target, true)?;

        let mut snapshot = self
            .snapshot
            .write()
            .unwrap_or_else(|error| error.into_inner());
        self.write_bootstrap(Some(target.clone()), snapshot.locale.clone())?;
        snapshot.pending_root = resolve_pending_root(
            &snapshot.active_root,
            snapshot.source,
            target.clone(),
            ConfigDirectorySource::User,
        );
        snapshot.bootstrap_config_root = Some(target);
        drop(snapshot);
        Ok(self.status())
    }

    /// 清除用户目录定位，下一次启动恢复默认配置目录。
    pub fn reset_to_default(&self) -> Result<ConfigDirectoryStatus, EngineError> {
        self.ensure_not_environment_locked()?;
        validate_directory(&self.default_root, true)?;
        let mut snapshot = self
            .snapshot
            .write()
            .unwrap_or_else(|error| error.into_inner());
        self.write_bootstrap(None, snapshot.locale.clone())?;
        snapshot.pending_root = resolve_pending_root(
            &snapshot.active_root,
            snapshot.source,
            self.default_root.clone(),
            ConfigDirectorySource::Default,
        );
        snapshot.bootstrap_config_root = None;
        drop(snapshot);
        Ok(self.status())
    }

    /// 保存恢复界面可用的应用语言，不改变配置目录选择。
    pub fn set_locale(&self, locale: &str) -> Result<ConfigDirectoryStatus, EngineError> {
        let locale = normalize_bootstrap_locale(Some(locale)).ok_or_else(|| {
            EngineError::new(
                "bootstrap_locale_invalid",
                "The bootstrap locale is unsupported",
            )
        })?;
        let mut snapshot = self
            .snapshot
            .write()
            .unwrap_or_else(|error| error.into_inner());
        self.write_bootstrap(
            snapshot.bootstrap_config_root.clone(),
            Some(locale.to_string()),
        )?;
        snapshot.locale = Some(locale.to_string());
        drop(snapshot);
        Ok(self.status())
    }

    fn write_bootstrap(
        &self,
        config_dir: Option<PathBuf>,
        locale: Option<String>,
    ) -> Result<(), EngineError> {
        let bootstrap = BootstrapFile {
            version: 1,
            config_dir,
            locale,
        };
        let raw = serde_json::to_string_pretty(&bootstrap).map_err(|error| {
            EngineError::with_detail(
                "bootstrap_serialize_failed",
                "Failed to serialize the bootstrap configuration",
                error.to_string(),
            )
        })?;
        write_atomic(&self.bootstrap_path, &raw)
    }

    fn ensure_not_environment_locked(&self) -> Result<(), EngineError> {
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(|error| error.into_inner());
        if snapshot.source == ConfigDirectorySource::Environment {
            return Err(EngineError::new(
                "config_directory_environment_locked",
                "The configuration directory is controlled by FLUXTERM_CONFIG_DIR",
            ));
        }
        Ok(())
    }
}

/// 根据目标路径与目标来源判断下一次启动是否会产生实际状态变化。
fn resolve_pending_root(
    active_root: &Path,
    active_source: ConfigDirectorySource,
    target_root: PathBuf,
    target_source: ConfigDirectorySource,
) -> Option<PathBuf> {
    if active_root == target_root && active_source == target_source {
        None
    } else {
        Some(target_root)
    }
}

/// 严格加载 dotenv 文件（仅 debug 构建启用）。
#[cfg(debug_assertions)]
pub fn load_dotenv_strict() -> Result<(), String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let tauri_env_path = manifest_dir.join(".env");
    if tauri_env_path.exists() {
        return dotenvy::from_path(&tauri_env_path).map_err(|error| {
            format!(
                "[fluxterm] failed to load dotenv from {}: {}",
                tauri_env_path.display(),
                error
            )
        });
    }
    Ok(())
}

/// release 构建不加载 dotenv，避免本地开发文件影响生产行为。
#[cfg(not(debug_assertions))]
pub fn load_dotenv_strict() -> Result<(), String> {
    Ok(())
}

/// 初始化进程级配置目录状态。
pub fn initialize_config_directory_state(
    app: &AppHandle,
) -> Result<ConfigDirectoryState, EngineError> {
    let home = app.path().home_dir().map_err(|error| {
        EngineError::with_detail(
            "config_path_failed",
            "Failed to resolve the user home directory",
            error.to_string(),
        )
    })?;
    let fixed_config_dir = app.path().app_config_dir().map_err(|error| {
        EngineError::with_detail(
            "config_location_path_failed",
            "Failed to resolve the fixed application configuration directory",
            error.to_string(),
        )
    })?;
    let bootstrap_path = fixed_config_dir.join(BOOTSTRAP_FILE_NAME);
    let default_root = home.join(DEFAULT_CONFIG_DIR_NAME);

    let (bootstrap, bootstrap_error) = read_bootstrap(&bootstrap_path);
    let bootstrap_config_root = bootstrap
        .as_ref()
        .and_then(|value| value.config_dir.clone());
    let locale = bootstrap
        .as_ref()
        .and_then(|value| normalize_bootstrap_locale(value.locale.as_deref()))
        .map(str::to_string);
    let environment_value = std::env::var(CONFIG_DIR_ENV_KEY).ok();
    let (active_root, source, resolve_error) = resolve_startup_root(
        &home,
        &default_root,
        environment_value.as_deref(),
        bootstrap.as_ref(),
        bootstrap_error,
    );
    let validation = resolve_error.map_or_else(
        || validate_directory(&active_root, source != ConfigDirectorySource::User),
        Err,
    );
    let (ready, error) = match validation {
        Ok(()) => (true, None),
        Err(error) => (false, Some(error.to_string())),
    };

    Ok(ConfigDirectoryState {
        snapshot: RwLock::new(ConfigDirectorySnapshot {
            active_root,
            source,
            ready,
            error,
            pending_root: None,
            bootstrap_config_root,
            locale,
        }),
        bootstrap_path,
        default_root,
    })
}

fn resolve_startup_root(
    home: &Path,
    default_root: &Path,
    environment_value: Option<&str>,
    bootstrap: Option<&BootstrapFile>,
    bootstrap_error: Option<EngineError>,
) -> (PathBuf, ConfigDirectorySource, Option<EngineError>) {
    if let Some(value) = environment_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            let resolved = if path.is_absolute() {
                path
            } else {
                home.join(path)
            };
            return (resolved, ConfigDirectorySource::Environment, None);
        }
        log_event!(
            LogLevel::Warn,
            "config.path.resolve.failed",
            None,
            json!({
                "sourceType": "env",
                "error": {
                    "code": "config_dir_env_empty",
                    "message": "The configuration directory environment variable is empty and was ignored",
                    "detail": Option::<String>::None,
                }
            }),
        );
    }

    if let Some(error) = bootstrap_error {
        return (
            default_root.to_path_buf(),
            ConfigDirectorySource::User,
            Some(error),
        );
    }
    if let Some(config_dir) = bootstrap.and_then(|value| value.config_dir.clone()) {
        return (config_dir, ConfigDirectorySource::User, None);
    }

    (
        default_root.to_path_buf(),
        ConfigDirectorySource::Default,
        None,
    )
}

fn read_bootstrap(path: &Path) -> (Option<BootstrapFile>, Option<EngineError>) {
    if !path.exists() {
        return (
            Some(BootstrapFile {
                version: 1,
                config_dir: None,
                locale: None,
            }),
            None,
        );
    }
    let result = fs::read_to_string(path)
        .map_err(|error| {
            EngineError::with_detail(
                "bootstrap_read_failed",
                "Failed to read the bootstrap configuration",
                error.to_string(),
            )
        })
        .and_then(|raw| {
            serde_json::from_str::<BootstrapFile>(&raw).map_err(|error| {
                EngineError::with_detail(
                    "bootstrap_invalid",
                    "The bootstrap configuration is invalid",
                    error.to_string(),
                )
            })
        })
        .and_then(|bootstrap| {
            if bootstrap.version != 1
                || bootstrap
                    .config_dir
                    .as_ref()
                    .is_some_and(|path| !path.is_absolute())
            {
                return Err(EngineError::new(
                    "bootstrap_invalid",
                    "The bootstrap configuration is invalid",
                ));
            }
            Ok(bootstrap)
        });
    match result {
        Ok(bootstrap) => (Some(bootstrap), None),
        Err(error) => (None, Some(error)),
    }
}

fn normalize_bootstrap_locale(locale: Option<&str>) -> Option<&'static str> {
    match locale {
        Some("zh-CN") => Some("zh-CN"),
        Some("en-US") => Some("en-US"),
        _ => None,
    }
}

fn validate_directory(path: &Path, create_if_missing: bool) -> Result<(), EngineError> {
    if !path.exists() {
        if !create_if_missing {
            return Err(EngineError::new(
                "config_directory_missing",
                "The configured directory no longer exists",
            ));
        }
        fs::create_dir_all(path).map_err(|error| {
            EngineError::with_detail(
                "config_directory_create_failed",
                "Failed to create the configuration directory",
                error.to_string(),
            )
        })?;
    }
    if !path.is_dir() {
        return Err(EngineError::new(
            "config_directory_invalid",
            "The configured path is not a directory",
        ));
    }

    fs::read_dir(path).map_err(|error| {
        EngineError::with_detail(
            "config_directory_not_readable",
            "The configured directory is not readable",
            error.to_string(),
        )
    })?;

    let probe = path.join(format!(".fluxterm-write-test-{}", Uuid::new_v4()));
    fs::write(&probe, b"fluxterm").map_err(|error| {
        EngineError::with_detail(
            "config_directory_not_writable",
            "The configured directory is not writable",
            error.to_string(),
        )
    })?;
    fs::remove_file(&probe).map_err(|error| {
        EngineError::with_detail(
            "config_directory_probe_cleanup_failed",
            "Failed to clean up the configuration directory write probe",
            error.to_string(),
        )
    })?;
    Ok(())
}

/// 解析当前进程固定使用的配置根目录。
pub fn resolve_config_root_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    app.try_state::<ConfigDirectoryState>()
        .ok_or_else(|| {
            EngineError::new(
                "config_directory_state_missing",
                "The configuration directory state is unavailable",
            )
        })?
        .active_root()
}

/// 解析应用数据根目录。
pub fn resolve_data_root_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    app.path().app_data_dir().map_err(|error| {
        EngineError::with_detail(
            "data_path_failed",
            "Failed to resolve the application data directory",
            error.to_string(),
        )
    })
}

/// 解析性能遥测配置文件路径。
#[cfg(feature = "performance-telemetry")]
pub fn resolve_performance_telemetry_config_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("performance-telemetry.json"))
        .map_err(|error| {
            EngineError::with_detail(
                "performance_telemetry_config_path_failed",
                "Failed to resolve the performance telemetry configuration path",
                error.to_string(),
            )
        })
}

/// 解析性能遥测安装级设备身份文件路径。
#[cfg(feature = "performance-telemetry")]
pub fn resolve_performance_telemetry_device_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("performance-telemetry-device.json"))
        .map_err(|error| {
            EngineError::with_detail(
                "performance_telemetry_device_path_failed",
                "Failed to resolve the performance telemetry device path",
                error.to_string(),
            )
        })
}

/// 解析应用级配置目录。
pub fn resolve_global_config_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_config_root_dir(app)?.join("global"))
}

/// 解析终端域配置目录。
pub fn resolve_terminal_config_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_config_root_dir(app)?.join("terminal"))
}

/// 解析连接配置根目录。
pub fn resolve_connections_config_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_config_root_dir(app)?.join("connections"))
}

/// 解析 SSH 连接配置目录。
pub fn resolve_ssh_connections_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_connections_config_dir(app)?.join("ssh"))
}

/// 解析 RDP 连接配置目录。
pub fn resolve_rdp_connections_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_connections_config_dir(app)?.join("rdp"))
}

/// 解析串口连接配置目录。
pub fn resolve_serial_connections_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_connections_config_dir(app)?.join("serial"))
}

/// 解析应用安全配置文件路径。
pub fn resolve_security_config_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_global_config_dir(app)?.join("security.json"))
}

/// 解析全局 session 配置文件路径。
pub fn resolve_session_settings_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_global_config_dir(app)?.join("session.json"))
}

/// 解析终端域 AI 配置文件路径。
pub fn resolve_ai_settings_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_config_root_dir(app)?.join("ai").join("ai.json"))
}

/// 解析应用私有 known_hosts 文件路径。
pub fn resolve_known_hosts_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_ssh_connections_dir(app)?.join("known_hosts"))
}

/// 解析 SSH 主机配置文件路径。
pub fn resolve_ssh_profiles_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_ssh_connections_dir(app)?.join("profiles.json"))
}

/// 解析 SSH 分组配置文件路径。
pub fn resolve_ssh_groups_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_ssh_connections_dir(app)?.join("groups.json"))
}

/// 解析 RDP 配置文件路径。
pub fn resolve_rdp_profiles_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_rdp_connections_dir(app)?.join("profiles.json"))
}

/// 解析 RDP 分组配置文件路径。
pub fn resolve_rdp_groups_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_rdp_connections_dir(app)?.join("groups.json"))
}

/// 解析串口 Profile 配置文件路径。
pub fn resolve_serial_profiles_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_serial_connections_dir(app)?.join("profiles.json"))
}

/// 解析串口分组配置文件路径。
pub fn resolve_serial_groups_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_serial_connections_dir(app)?.join("groups.json"))
}

#[cfg(test)]
mod tests {
    use super::{
        BootstrapFile, CUSTOM_CONFIG_DIR_NAME, ConfigDirectorySnapshot, ConfigDirectorySource,
        ConfigDirectoryState, normalize_bootstrap_locale, read_bootstrap, resolve_startup_root,
        validate_directory,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::RwLock;
    use uuid::Uuid;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("fluxterm-config-path-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn bootstrap_stores_final_config_root_and_locale() {
        let bootstrap = BootstrapFile {
            version: 1,
            config_dir: Some(PathBuf::from("/tmp/custom-parent/fluxterm")),
            locale: Some("zh-CN".to_string()),
        };
        assert_eq!(
            bootstrap.config_dir,
            Some(PathBuf::from("/tmp/custom-parent/fluxterm"))
        );
        assert_eq!(bootstrap.locale.as_deref(), Some("zh-CN"));
    }

    #[test]
    fn bootstrap_uses_public_camel_case_keys() {
        let raw = serde_json::to_string(&BootstrapFile {
            version: 1,
            config_dir: Some(PathBuf::from("/tmp/custom-parent/fluxterm")),
            locale: Some("en-US".to_string()),
        })
        .expect("serialize bootstrap");
        assert!(raw.contains("configDir"));
        assert!(raw.contains("locale"));
        assert!(!raw.contains("parentDir"));
    }

    #[test]
    fn environment_directory_has_priority_over_bootstrap() {
        let root = test_root();
        let home = root.join("home");
        let user_parent = root.join("user-parent");
        let environment_root = root.join("environment-root");
        let bootstrap = BootstrapFile {
            version: 1,
            config_dir: Some(user_parent.join(CUSTOM_CONFIG_DIR_NAME)),
            locale: Some("zh-CN".to_string()),
        };

        let (resolved, source, error) = resolve_startup_root(
            &home,
            &home.join(".vust/fluxterm"),
            Some(environment_root.to_string_lossy().as_ref()),
            Some(&bootstrap),
            None,
        );

        assert_eq!(resolved, environment_root);
        assert_eq!(source, ConfigDirectorySource::Environment);
        assert!(error.is_none());
    }

    #[test]
    fn bootstrap_directory_is_used_without_environment_override() {
        let root = test_root();
        let home = root.join("home");
        let user_parent = root.join("用户 配置");
        let bootstrap = BootstrapFile {
            version: 1,
            config_dir: Some(user_parent.join(CUSTOM_CONFIG_DIR_NAME)),
            locale: Some("zh-CN".to_string()),
        };

        let (resolved, source, error) = resolve_startup_root(
            &home,
            &home.join(".vust/fluxterm"),
            None,
            Some(&bootstrap),
            None,
        );

        assert_eq!(resolved, user_parent.join(CUSTOM_CONFIG_DIR_NAME));
        assert_eq!(source, ConfigDirectorySource::User);
        assert!(error.is_none());
    }

    #[test]
    fn unknown_bootstrap_locale_is_ignored() {
        assert_eq!(normalize_bootstrap_locale(Some("fr-FR")), None);
        assert_eq!(normalize_bootstrap_locale(Some("en-US")), Some("en-US"));
    }

    #[test]
    fn missing_saved_user_directory_is_not_recreated() {
        let missing = test_root().join("missing");
        assert!(validate_directory(&missing, false).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn selecting_parent_only_changes_pending_root() {
        let root = test_root();
        let active = root.join("active");
        let selected_parent = root.join("selected-parent");
        fs::create_dir_all(&active).expect("create active");
        fs::create_dir_all(&selected_parent).expect("create selected parent");
        let state = ConfigDirectoryState {
            snapshot: RwLock::new(ConfigDirectorySnapshot {
                active_root: active.clone(),
                source: ConfigDirectorySource::Default,
                ready: true,
                error: None,
                pending_root: None,
                bootstrap_config_root: None,
                locale: Some("zh-CN".to_string()),
            }),
            bootstrap_path: root.join("fixed/bootstrap.json"),
            default_root: active.clone(),
        };

        let status = state
            .select_parent(&selected_parent)
            .expect("select parent");
        let expected_pending = selected_parent
            .join(CUSTOM_CONFIG_DIR_NAME)
            .to_string_lossy()
            .into_owned();

        assert_eq!(status.active_dir, active.to_string_lossy());
        assert_eq!(
            status.pending_dir.as_deref(),
            Some(expected_pending.as_str())
        );
        let (bootstrap, error) = read_bootstrap(&root.join("fixed/bootstrap.json"));
        assert!(error.is_none());
        let bootstrap = bootstrap.expect("bootstrap");
        assert_eq!(bootstrap.locale.as_deref(), Some("zh-CN"));
        assert_eq!(
            bootstrap.config_dir,
            Some(selected_parent.join(CUSTOM_CONFIG_DIR_NAME))
        );

        state.reset_to_default().expect("reset to default");
        assert_eq!(state.status().pending_dir, None);
        let (bootstrap, error) = read_bootstrap(&root.join("fixed/bootstrap.json"));
        assert!(error.is_none());
        let bootstrap = bootstrap.expect("bootstrap after reset");
        assert_eq!(bootstrap.config_dir, None);
        assert_eq!(bootstrap.locale.as_deref(), Some("zh-CN"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn resetting_active_user_directory_requires_restart() {
        let root = test_root();
        let active = root.join("custom/fluxterm");
        let default_root = root.join("default/fluxterm");
        fs::create_dir_all(&active).expect("create active");
        let state = ConfigDirectoryState {
            snapshot: RwLock::new(ConfigDirectorySnapshot {
                active_root: active,
                source: ConfigDirectorySource::User,
                ready: true,
                error: None,
                pending_root: None,
                bootstrap_config_root: Some(root.join("custom/fluxterm")),
                locale: None,
            }),
            bootstrap_path: root.join("fixed/bootstrap.json"),
            default_root: default_root.clone(),
        };

        let status = state.reset_to_default().expect("reset to default");
        assert_eq!(
            status.pending_dir.as_deref(),
            Some(default_root.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn selecting_same_path_with_different_source_requires_restart() {
        let root = test_root();
        let selected_parent = root.join("selected-parent");
        let active = selected_parent.join(CUSTOM_CONFIG_DIR_NAME);
        fs::create_dir_all(&active).expect("create active");
        let state = ConfigDirectoryState {
            snapshot: RwLock::new(ConfigDirectorySnapshot {
                active_root: active.clone(),
                source: ConfigDirectorySource::Default,
                ready: true,
                error: None,
                pending_root: None,
                bootstrap_config_root: None,
                locale: None,
            }),
            bootstrap_path: root.join("fixed/bootstrap.json"),
            default_root: active.clone(),
        };

        let status = state
            .select_parent(&selected_parent)
            .expect("select parent");
        assert_eq!(
            status.pending_dir.as_deref(),
            Some(active.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
