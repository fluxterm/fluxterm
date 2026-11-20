//! 配置备份领域：归档、WebDAV 上传与启动前恢复。
pub mod archive;
pub mod restore;
mod webdav;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::security::CryptoService;
use crate::state::SecurityState;

const BACKUP_PASSWORD_UPDATE_FAILED_CODE: &str = "backup_password_update_failed";

/// 备份领域统一结果类型。
pub type Result<T> = std::result::Result<T, BackupError>;

/// 可安全跨命令边界传递的错误，不包含认证信息和配置内容。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupError {
    code: String,
    message: String,
    message_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_vars: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Box<str>>,
}
impl BackupError {
    /// 创建具有稳定错误码的备份错误。
    pub fn new(code: &str, message: &str) -> Self {
        let mut message_key = String::from("backup.error.");
        for (index, part) in code
            .strip_prefix("backup_")
            .unwrap_or(code)
            .split('_')
            .enumerate()
        {
            if index == 0 {
                message_key.push_str(part);
            } else if let Some(first) = part.chars().next() {
                message_key.push(first.to_ascii_uppercase());
                message_key.push_str(&part[first.len_utf8()..]);
            }
        }
        Self {
            code: code.into(),
            message: message.into(),
            message_key,
            message_vars: None,
            details: None,
        }
    }
    /// 创建归档或输入验证错误。
    pub fn invalid(message: &str) -> Self {
        Self::new("backup_invalid", message)
    }

    /// 附加白名单文档与固定结构字段位置，不包含用户输入或密钥材料。
    pub fn with_location(mut self, document: &str, field: &str) -> Self {
        self.details = Some(format!("{document}:{field}").into_boxed_str());
        self.message_vars = Some(BTreeMap::from([
            ("file".into(), document.into()),
            ("field".into(), field.into()),
        ]));
        self
    }
}
impl From<std::io::Error> for BackupError {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            "backup_io_failed",
            "File access failed; check permissions and available space",
        )
    }
}
impl From<serde_json::Error> for BackupError {
    fn from(_: serde_json::Error) -> Self {
        Self::invalid("Invalid configuration or backup manifest format")
    }
}
impl From<zip::result::ZipError> for BackupError {
    fn from(_: zip::result::ZipError) -> Self {
        Self::invalid("The archive is invalid or unsupported")
    }
}
impl From<fluxterm_engine::EngineError> for BackupError {
    fn from(_: fluxterm_engine::EngineError) -> Self {
        Self::new(
            "backup_security_unavailable",
            "Security storage is unavailable; unlock before using the saved WebDAV password",
        )
    }
}
impl From<reqwest::Error> for BackupError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::new("backup_timeout", "The WebDAV request timed out")
        } else {
            Self::new("backup_network_failed", "The WebDAV network request failed")
        }
    }
}

/// WebDAV 设置；归档仅保留连接信息，移除密码。
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub url: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password_ref: Option<String>,
}

/// 前端设置视图只暴露是否保存密码。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    url: String,
    username: String,
    has_password: bool,
    pending_restore: bool,
    restore_notice: Option<String>,
}

/// 保存设置时密码可保持、替换或显式清除。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub url: String,
    pub username: String,
    pub password: Option<String>,
    pub forget_password: bool,
    #[serde(default)]
    pub clear: bool,
}

/// 当前请求的 WebDAV 设置，临时密码不会保存。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavInput {
    pub url: String,
    pub username: String,
    pub password: Option<String>,
    pub use_saved_password: bool,
}

/// 后台任务的取消信号。
#[derive(Default)]
struct Task {
    cancelled: AtomicBool,
    notify: Notify,
}
impl Task {
    /// 在压缩、解压和提交边界响应取消。
    fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(BackupError::new(
                "backup_cancelled",
                "The operation was cancelled",
            ))
        } else {
            Ok(())
        }
    }
    /// 可用于 select 的取消等待，不阻塞运行时线程。
    async fn cancelled(&self) {
        if self.cancelled.load(Ordering::SeqCst) {
            return;
        }
        self.notify.notified().await;
    }
}

type Tasks = Arc<Mutex<HashMap<String, Arc<Task>>>>;

/// 备份任务与后端拥有的检查结果。
#[derive(Default)]
pub struct BackupState {
    tasks: Tasks,
    inspected: Mutex<HashMap<String, archive::VerifiedArchive>>,
}

/// 命令结束时自动回收任务，避免取消标识泄漏。
struct TaskGuard {
    tasks: Tasks,
    id: String,
}
impl Drop for TaskGuard {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(&self.id);
        }
    }
}

impl BackupState {
    /// 第一版串行执行备份任务，避免资源竞争。
    fn begin(&self, id: &str) -> Result<(Arc<Task>, TaskGuard)> {
        Uuid::parse_str(id).map_err(|_| BackupError::invalid("Invalid task identifier"))?;
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| BackupError::invalid("Task state is unavailable"))?;
        if !tasks.is_empty() {
            return Err(BackupError::new(
                "backup_busy",
                "Another backup task is running",
            ));
        }
        let task = Arc::new(Task::default());
        tasks.insert(id.into(), task.clone());
        Ok((
            task,
            TaskGuard {
                tasks: self.tasks.clone(),
                id: id.into(),
            },
        ))
    }
}

/// 原子写入后端固定路径的 JSON。
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| BackupError::invalid("Invalid destination path"))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec_pretty(value)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|e| BackupError::from(e.error))?;
    Ok(())
}

/// 读取安装本地 WebDAV 设置。
fn read_settings(root: &Path) -> Result<Settings> {
    match fs::read(root.join("global/backup.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(error.into()),
    }
}

/// 恢复安全配置后清除目标设备原来的 WebDAV 密码。
pub fn clear_saved_password(root: &Path) -> Result<()> {
    let mut settings = read_settings(root)?;
    settings.password_ref = None;
    write_json(&root.join("global/backup.json"), &settings)
}

/// 在修改其他安全文件之前准备 WebDAV 密码，解密失败时不开始提交。
pub fn prepare_password_update(
    app: &AppHandle,
    current: &CryptoService,
    next: &CryptoService,
) -> std::result::Result<Option<Settings>, fluxterm_engine::EngineError> {
    let root = crate::config_paths::resolve_config_root_dir(app)?;
    let result = (|| -> Result<Option<Settings>> {
        let mut settings = read_settings(&root)?;
        if let Some(secret) = &settings.password_ref {
            settings.password_ref = Some(next.encrypt_string(&current.decrypt_string(secret)?)?);
            return Ok(Some(settings));
        }
        Ok(None)
    })();
    result.map_err(|_| {
        fluxterm_engine::EngineError::new(
            BACKUP_PASSWORD_UPDATE_FAILED_CODE,
            "The saved WebDAV password could not be re-encrypted",
        )
    })
}

/// 与其他安全配置在同一个事务范围内提交已准备的 WebDAV 密码。
pub fn apply_password_update(
    app: &AppHandle,
    settings: Option<Settings>,
) -> std::result::Result<(), fluxterm_engine::EngineError> {
    if let Some(settings) = settings {
        let root = crate::config_paths::resolve_config_root_dir(app)?;
        write_json(&root.join("global/backup.json"), &settings).map_err(|_| {
            fluxterm_engine::EngineError::new(
                BACKUP_PASSWORD_UPDATE_FAILED_CODE,
                "The saved WebDAV password could not be written",
            )
        })?;
    }
    Ok(())
}

/// 读取 WebDAV 设置与恢复状态。
#[tauri::command]
pub fn backup_settings_get(app: AppHandle) -> Result<SettingsView> {
    let _transaction = crate::config_transaction::lock();
    let root = crate::config_paths::resolve_config_root_dir(&app)?;
    let settings = read_settings(&root)?;
    let notice = root.join(".backup-restore/notice.json");
    let restore_notice = if notice.exists() {
        Some(serde_json::from_slice::<String>(&fs::read(notice)?)?)
    } else {
        None
    };
    Ok(SettingsView {
        url: settings.url,
        username: settings.username,

        has_password: settings.password_ref.is_some(),
        pending_restore: root.join(".backup-restore/pending.json").exists(),
        restore_notice,
    })
}

/// 保存非敏感设置，并按现有 Provider 保护可选密码。
#[tauri::command]
pub fn backup_settings_save(app: AppHandle, input: SettingsInput) -> Result<SettingsView> {
    let _transaction = crate::config_transaction::lock();
    let root = crate::config_paths::resolve_config_root_dir(&app)?;
    if input.clear {
        reset_settings(&root)?;
        return backup_settings_get(app);
    }
    let previous = read_settings(&root)?;
    let mut settings = Settings {
        url: input.url.trim().into(),
        username: input.username,

        password_ref: previous.password_ref,
    };
    webdav::target_directory(&settings)?;
    if input.forget_password {
        settings.password_ref = None;
    }
    if let Some(password) = input.password {
        let config = crate::security_store::read_security_config(&app)?;
        let security = app.state::<SecurityState>();
        let session = security.current_session();
        let crypto = CryptoService::load(&app, config.as_ref(), session.as_ref())?;
        settings.password_ref = Some(crypto.encrypt_string(&password)?);
    }
    write_json(&root.join("global/backup.json"), &settings)?;
    backup_settings_get(app)
}

/// 清空 WebDAV 地址、账号和密码，不要求解锁已保存密码。
fn reset_settings(root: &Path) -> Result<()> {
    write_json(&root.join("global/backup.json"), &Settings::default())
}

/// 解析当前请求的临时密码或已保存密码，不向前端返回明文。
fn connection(app: &AppHandle, input: WebdavInput) -> Result<(Settings, String)> {
    let _transaction = crate::config_transaction::lock();
    let mut settings = Settings {
        url: input.url,
        username: input.username,

        password_ref: None,
    };
    webdav::target_directory(&settings)?;
    let password = if let Some(password) = input.password {
        password
    } else if input.use_saved_password {
        let root = crate::config_paths::resolve_config_root_dir(app)?;
        let saved = read_settings(&root)?;
        if saved.url != settings.url || saved.username != settings.username {
            return Err(BackupError::invalid(
                "The server URL or username changed; enter the password again",
            ));
        }
        let config = crate::security_store::read_security_config(app)?;
        let security = app.state::<SecurityState>();
        let session = security.current_session();
        let crypto = CryptoService::load(app, config.as_ref(), session.as_ref())?;
        crypto.decrypt_string(
            saved
                .password_ref
                .as_deref()
                .ok_or_else(|| BackupError::invalid("No password has been saved"))?,
        )?
    } else {
        String::new()
    };
    settings.password_ref = None;
    Ok((settings, password))
}

/// 只读测试连接，不创建目录或验证 PUT 权限。
#[tauri::command]
pub async fn backup_test_webdav(
    app: AppHandle,
    state: State<'_, BackupState>,
    task_id: String,
    input: WebdavInput,
) -> Result<()> {
    let (task, _guard) = state.begin(&task_id)?;
    let (settings, password) = connection(&app, input)?;
    let client = webdav::client()?;
    tokio::select! {
        result = webdav::test_connection(&client, &settings, &password) => result,
        () = task.cancelled() => Err(BackupError::new("backup_cancelled", "The operation was cancelled")),
    }
}

/// 使用紧凑 UTC 时间（含毫秒）命名备份，不附加随机标识。
fn filename() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "fluxterm-backup-{:04}{:02}{:02}-{:02}{:02}{:02}{:03}.zip",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

/// 本地导出：先在目标目录写临时文件，再提交完整 ZIP。
#[tauri::command]
pub async fn backup_export_local(
    app: AppHandle,
    state: State<'_, BackupState>,
    task_id: String,
    path: String,
) -> Result<()> {
    let (task, _guard) = state.begin(&task_id)?;
    let root = crate::config_paths::resolve_config_root_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        task.check()?;
        let destination = PathBuf::from(path);
        if !destination.is_absolute()
            || destination.extension().and_then(|s| s.to_str()) != Some("zip")
        {
            return Err(BackupError::invalid(
                "Choose an absolute destination path with the .zip extension",
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| BackupError::invalid("Invalid destination directory"))?;
        let snapshot = archive::snapshot(&root, || task.check())?;
        let mut output = tempfile::NamedTempFile::new_in(parent)?;
        archive::pack(snapshot.path(), output.as_file_mut(), || task.check())?;
        output.as_file().sync_all()?;
        task.check()?;
        output
            .persist(destination)
            .map_err(|e| BackupError::from(e.error))?;
        Ok(())
    })
    .await
    .map_err(|_| BackupError::new("backup_task_failed", "The backup task ended unexpectedly"))?
}

/// WebDAV 上传共用归档实现，取消时丢弃请求与本地临时文件。
#[tauri::command]
pub async fn backup_upload_webdav(
    app: AppHandle,
    state: State<'_, BackupState>,
    task_id: String,
    input: WebdavInput,
) -> Result<String> {
    let (task, _guard) = state.begin(&task_id)?;
    let (settings, password) = connection(&app, input)?;
    let root = crate::config_paths::resolve_config_root_dir(&app)?;
    let copy_task = task.clone();
    let output = tokio::task::spawn_blocking(move || -> Result<_> {
        copy_task.check()?;
        let snapshot = archive::snapshot(&root, || copy_task.check())?;
        let mut output = tempfile::NamedTempFile::new()?;
        archive::pack(snapshot.path(), output.as_file_mut(), || copy_task.check())?;
        output.as_file().sync_all()?;
        Ok(output)
    })
    .await
    .map_err(|_| BackupError::new("backup_task_failed", "The backup task ended unexpectedly"))??;
    task.check()?;
    let client = webdav::client()?;
    let name = filename();
    let upload = webdav::upload(&client, &settings, &password, output.path(), &name);
    tokio::select! {
        result = upload => { result?; Ok(name) },
        () = task.cancelled() => Err(BackupError::new("backup_cancelled", "The operation was cancelled; an incomplete remote file may remain")),
    }
}

/// 已检查的备份摘要及后端暂存标识。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    token: String,
    manifest: archive::Manifest,
}

/// 只检查本地压缩包，检查后不再依赖用户提供的源路径。
#[tauri::command]
pub async fn backup_inspect_local(
    state: State<'_, BackupState>,
    task_id: String,
    path: String,
) -> Result<Inspection> {
    let (task, _guard) = state.begin(&task_id)?;
    let verified =
        tokio::task::spawn_blocking(move || archive::inspect(Path::new(&path), || task.check()))
            .await
            .map_err(|_| {
                BackupError::new(
                    "backup_task_failed",
                    "Archive inspection ended unexpectedly",
                )
            })??;
    let token = Uuid::new_v4().to_string();
    let manifest = verified.manifest.clone();
    let mut inspected = state
        .inspected
        .lock()
        .map_err(|_| BackupError::invalid("Archive staging state is unavailable"))?;
    inspected.clear();
    inspected.insert(token.clone(), verified);
    Ok(Inspection { token, manifest })
}

/// 用户确认后暂存恢复，下次启动才替换当前配置。
#[tauri::command]
pub async fn backup_stage_restore(
    app: AppHandle,
    state: State<'_, BackupState>,
    task_id: String,
    token: String,
) -> Result<()> {
    let (task, _guard) = state.begin(&task_id)?;
    let verified = state
        .inspected
        .lock()
        .map_err(|_| BackupError::invalid("Archive staging state is unavailable"))?
        .remove(&token)
        .ok_or_else(|| {
            BackupError::invalid("The inspected archive is no longer available; select it again")
        })?;
    let root = crate::config_paths::resolve_config_root_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        task.check()?;
        restore::stage(&root, &verified, || task.check())
    })
    .await
    .map_err(|_| BackupError::new("backup_task_failed", "Restore staging ended unexpectedly"))?
}

/// 通知指定任务取消，不产生自动重试。
#[tauri::command]
pub fn backup_cancel(state: State<'_, BackupState>, task_id: String) -> Result<()> {
    if let Some(task) = state
        .tasks
        .lock()
        .map_err(|_| BackupError::invalid("Task state is unavailable"))?
        .get(&task_id)
    {
        task.cancelled.store(true, Ordering::SeqCst);
        task.notify.notify_one();
    }
    Ok(())
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    /// 清空无需读取或解密旧密码，并且不修改其他配置。
    #[test]
    fn clear_webdav_settings_removes_all_saved_fields() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("global/backup.json");
        write_json(
            &path,
            &Settings {
                url: "http://nas/dav/".into(),
                username: "user".into(),
                password_ref: Some("enc:v1:locked-secret".into()),
            },
        )
        .unwrap();
        fs::write(root.path().join("global/settings.json"), "keep").unwrap();
        reset_settings(root.path()).unwrap();
        let settings = read_settings(root.path()).unwrap();
        assert!(settings.url.is_empty() && settings.username.is_empty());
        assert!(settings.password_ref.is_none());
        assert_eq!(
            fs::read_to_string(root.path().join("global/settings.json")).unwrap(),
            "keep"
        );
    }
}
