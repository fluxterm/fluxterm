//! 远端文件编辑工作副本管理。
//!
//! 本模块负责：
//! - 远端文件工作副本缓存目录与集中索引
//! - 本地工作副本快照与变更检测
//! - 远端编辑运行时状态与事件广播
//! - 后台轮询任务生命周期
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use engine::{Engine, EngineError, SftpEntry};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use time::{OffsetDateTime, format_description::BorrowedFormatItem, macros::format_description};
use tokio::sync::{Mutex, RwLock, watch};

use crate::config_paths::resolve_data_root_dir;
use crate::telemetry::{TelemetryLevel, log_telemetry};

const REMOTE_FILE_CACHE_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const REMOTE_FILE_CACHE_CLEANUP_MARKER: &str = ".cleanup-meta.json";
const REMOTE_FILE_INDEX_FILE: &str = "index.json";
const REMOTE_FILE_INDEX_FILE_TMP: &str = "index.json.tmp";
const REMOTE_FILE_INSTANCE_META: &str = ".fluxterm-remote.json";
const REMOTE_TEXT_EDIT_MAX_BYTES: u64 = 2 * 1024 * 1024;
const REMOTE_EDIT_POLL_INTERVAL_MS: u64 = 2000;
const REMOTE_EDIT_QUIET_WINDOW_MS: u64 = 1200;
static CLEANUP_DATE_FORMAT: &[BorrowedFormatItem<'static>] =
    format_description!("[year]-[month repr:numerical padding:zero]-[day padding:zero]");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteEditStatus {
    Synced,
    PendingConfirm,
    Uploading,
    SyncFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// 本地工作副本的内容快照。
pub struct RemoteFileSnapshot {
    pub mtime_ms: u64,
    pub size: u64,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// 发给前端的远端编辑运行时快照。
pub struct RemoteEditSnapshot {
    pub instance_id: String,
    pub session_id: String,
    pub remote_path: String,
    pub local_path: String,
    pub file_name: String,
    pub downloaded_at: u64,
    pub remote_mtime: Option<u64>,
    pub remote_size: Option<u64>,
    pub track_changes: bool,
    pub status: RemoteEditStatus,
    pub last_synced_at: u64,
    pub last_error_code: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// 用于生成稳定工作副本键和路径的远端目标标识。
pub struct RemoteEditTarget {
    pub session_host: String,
    pub session_username: String,
    pub session_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// 远端编辑集中索引中的单条记录。
struct RemoteEditIndexEntry {
    instance_id: String,
    session_id: String,
    session_host: String,
    session_username: String,
    session_port: u16,
    remote_path: String,
    file_name: String,
    downloaded_at: u64,
    remote_mtime: Option<u64>,
    remote_size: Option<u64>,
    track_changes: bool,
    baseline: RemoteFileSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
/// 远端编辑集中索引。
struct RemoteEditIndexStore {
    version: u8,
    entries: HashMap<String, RemoteEditIndexEntry>,
}

pub(crate) struct RemoteEditInstance {
    pub(crate) snapshot: RemoteEditSnapshot,
    pub(crate) baseline: RemoteFileSnapshot,
    pub(crate) pending_snapshot: Option<RemoteFileSnapshot>,
    pub(crate) ignored_content_hash: Option<String>,
    pub(crate) stop_tx: watch::Sender<bool>,
    pub(crate) session_host: String,
    pub(crate) session_username: String,
    pub(crate) session_port: u16,
}

#[derive(Default)]
/// 远端编辑运行时真相源。
pub struct RemoteEditState {
    instances: RwLock<HashMap<String, Arc<Mutex<RemoteEditInstance>>>>,
}

impl RemoteEditState {
    pub(crate) async fn upsert(
        &self,
        instance: RemoteEditInstance,
    ) -> Arc<Mutex<RemoteEditInstance>> {
        let instance_id = instance.snapshot.instance_id.clone();
        let next = Arc::new(Mutex::new(instance));
        let replaced = {
            let mut items = self.instances.write().await;
            items.insert(instance_id, Arc::clone(&next))
        };
        if let Some(previous) = replaced {
            let guard = previous.lock().await;
            let _ = guard.stop_tx.send(true);
        }
        next
    }

    pub(crate) async fn get(&self, instance_id: &str) -> Option<Arc<Mutex<RemoteEditInstance>>> {
        self.instances.read().await.get(instance_id).cloned()
    }

    pub async fn list(&self) -> Vec<RemoteEditSnapshot> {
        let items = self.instances.read().await;
        let instances = items.values().cloned().collect::<Vec<_>>();
        drop(items);
        let mut results = Vec::with_capacity(instances.len());
        for instance in instances {
            let guard = instance.lock().await;
            results.push(guard.snapshot.clone());
        }
        results
    }

    pub(crate) async fn remove_by_session(&self, session_id: &str) {
        let items = self.instances.read().await;
        let instance_ids = items
            .iter()
            .map(|(instance_id, instance)| (instance_id.clone(), Arc::clone(instance)))
            .collect::<Vec<_>>();
        drop(items);

        let mut removed_ids = Vec::new();
        for (instance_id, instance) in instance_ids {
            let guard = instance.lock().await;
            if guard.snapshot.session_id != session_id {
                continue;
            }
            let _ = guard.stop_tx.send(true);
            removed_ids.push(instance_id);
        }

        if removed_ids.is_empty() {
            return;
        }

        let mut items = self.instances.write().await;
        for instance_id in removed_ids {
            items.remove(&instance_id);
        }
    }
}

pub(crate) fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_path_segment(value: &str, fallback: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            control if control.is_control() => '_',
            value => value,
        })
        .collect::<String>()
        .trim_matches([' ', '.'])
        .trim()
        .to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn sanitize_file_name(name: &str) -> String {
    sanitize_path_segment(name, "file")
}

fn sha256_hex(input: &str) -> String {
    format!("{:x}", Sha256::digest(input.as_bytes()))
}

fn short_hash(input: &str) -> String {
    sha256_hex(input).chars().take(10).collect()
}

fn build_remote_edit_instance_id(target: &RemoteEditTarget, remote_path: &str) -> String {
    sha256_hex(
        format!(
            "{}\n{}\n{}\n{}",
            target.session_host, target.session_username, target.session_port, remote_path
        )
        .as_str(),
    )
}

fn get_remote_files_cache_root_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(resolve_data_root_dir(app)?
        .join("cache")
        .join("remote-files"))
}

fn get_cleanup_marker_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(get_remote_files_cache_root_dir(app)?.join(REMOTE_FILE_CACHE_CLEANUP_MARKER))
}

fn get_index_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(get_remote_files_cache_root_dir(app)?.join(REMOTE_FILE_INDEX_FILE))
}

fn get_index_tmp_path(app: &AppHandle) -> Result<PathBuf, EngineError> {
    Ok(get_remote_files_cache_root_dir(app)?.join(REMOTE_FILE_INDEX_FILE_TMP))
}

fn get_cleanup_day_stamp() -> String {
    OffsetDateTime::now_utc()
        .format(CLEANUP_DATE_FORMAT)
        .unwrap_or_else(|_| "1970-01-01".to_string())
}

fn legacy_cleanup_day_to_date(days_since_unix_epoch: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp(days_since_unix_epoch * 24 * 60 * 60)
        .ok()
        .and_then(|value| value.format(CLEANUP_DATE_FORMAT).ok())
}

fn log_remote_edit_event(level: TelemetryLevel, event: &str, fields: serde_json::Value) {
    log_telemetry(level, event, None, fields);
}

fn is_cleanup_marker_current(raw: &str, current_day: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<HashMap<String, String>>(raw) else {
        return false;
    };
    if parsed
        .get("lastCleanupDate")
        .is_some_and(|value| value == current_day)
    {
        return true;
    }
    let Some(legacy_day) = parsed.get("lastCleanupDay") else {
        return false;
    };
    let Ok(legacy_days_since_epoch) = legacy_day.parse::<i64>() else {
        return false;
    };
    legacy_cleanup_day_to_date(legacy_days_since_epoch).is_some_and(|value| value == current_day)
}

fn collect_expired_cache_paths(
    path: &Path,
    expired_before_ms: u64,
    results: &mut Vec<PathBuf>,
) -> Result<(), EngineError> {
    let entries = fs::read_dir(path).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_cleanup_failed",
            "无法遍历缓存目录",
            err.to_string(),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|err| {
            EngineError::with_detail(
                "remote_edit_cleanup_failed",
                "无法读取缓存目录项",
                err.to_string(),
            )
        })?;
        let entry_path = entry.path();
        if entry_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                value == REMOTE_FILE_CACHE_CLEANUP_MARKER
                    || value == REMOTE_FILE_INDEX_FILE
                    || value == REMOTE_FILE_INDEX_FILE_TMP
            })
        {
            continue;
        }
        let metadata = fs::metadata(&entry_path).map_err(|err| {
            EngineError::with_detail(
                "remote_edit_cleanup_failed",
                "无法读取缓存元数据",
                err.to_string(),
            )
        })?;
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64);
        if metadata.is_dir() {
            if modified_ms.is_some_and(|value| value < expired_before_ms) {
                results.push(entry_path);
                continue;
            }
            collect_expired_cache_paths(&entry_path, expired_before_ms, results)?;
            continue;
        }
        if modified_ms.is_some_and(|value| value < expired_before_ms) {
            results.push(entry_path);
        }
    }
    Ok(())
}

fn ensure_remote_file_cache_cleanup(app: &AppHandle) -> Result<(), EngineError> {
    let root_dir = get_remote_files_cache_root_dir(app)?;
    let marker_path = get_cleanup_marker_path(app)?;
    fs::create_dir_all(&root_dir).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_cache_failed",
            "无法创建远端编辑缓存目录",
            err.to_string(),
        )
    })?;
    let current_day = get_cleanup_day_stamp();

    if let Ok(raw) = fs::read_to_string(&marker_path)
        && is_cleanup_marker_current(&raw, &current_day)
    {
        return Ok(());
    }

    let expired_before = now_epoch_millis().saturating_sub(REMOTE_FILE_CACHE_RETENTION_MS);
    let mut expired_paths = Vec::new();
    collect_expired_cache_paths(&root_dir, expired_before, &mut expired_paths)?;
    let removed_count = expired_paths.len();
    for expired_path in expired_paths {
        if expired_path.is_dir() {
            let _ = fs::remove_dir_all(&expired_path);
        } else {
            let _ = fs::remove_file(&expired_path);
        }
    }
    let pruned_index_entries = prune_stale_remote_edit_index_entries(app)?;
    let payload = serde_json::json!({ "lastCleanupDate": current_day });
    fs::write(
        &marker_path,
        serde_json::to_vec_pretty(&payload).map_err(|err| {
            EngineError::with_detail(
                "remote_edit_cache_failed",
                "无法写入缓存清理标记",
                err.to_string(),
            )
        })?,
    )
    .map_err(|err| {
        EngineError::with_detail(
            "remote_edit_cache_failed",
            "无法写入缓存清理标记",
            err.to_string(),
        )
    })?;
    log_remote_edit_event(
        TelemetryLevel::Info,
        "remote.edit.cache.cleanup",
        json!({
            "removedPaths": removed_count,
            "prunedIndexEntries": pruned_index_entries,
            "retentionMs": REMOTE_FILE_CACHE_RETENTION_MS,
        }),
    );
    Ok(())
}

fn build_remote_edit_local_path(
    app: &AppHandle,
    target: &RemoteEditTarget,
    remote_path: &str,
    file_name: &str,
) -> Result<PathBuf, EngineError> {
    Ok(
        build_remote_edit_workspace_dir(app, target, remote_path, file_name)?
            .join(sanitize_file_name(file_name)),
    )
}

fn get_file_extension(name: &str) -> &str {
    name.rsplit('.')
        .next()
        .filter(|value| *value != name)
        .unwrap_or("")
}

fn is_remote_entry_editable_text(entry: &SftpEntry) -> bool {
    if !matches!(entry.kind, engine::SftpEntryKind::File) {
        return false;
    }
    if entry
        .size
        .is_some_and(|size| size > REMOTE_TEXT_EDIT_MAX_BYTES)
    {
        return false;
    }
    matches!(
        get_file_extension(&entry.name)
            .to_ascii_lowercase()
            .as_str(),
        "bash"
            | "c"
            | "cc"
            | "conf"
            | "config"
            | "cpp"
            | "cs"
            | "css"
            | "csv"
            | "env"
            | "go"
            | "h"
            | "hpp"
            | "html"
            | "ini"
            | "java"
            | "js"
            | "json"
            | "jsx"
            | "kt"
            | "log"
            | "lua"
            | "md"
            | "php"
            | "properties"
            | "py"
            | "rb"
            | "rs"
            | "scss"
            | "sh"
            | "sql"
            | "svg"
            | "swift"
            | "toml"
            | "ts"
            | "tsx"
            | "txt"
            | "vue"
            | "xml"
            | "yaml"
            | "yml"
            | "zsh"
    )
}

pub(crate) fn read_local_file_snapshot(path: &Path) -> Result<RemoteFileSnapshot, EngineError> {
    let metadata = fs::metadata(path).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_snapshot_failed",
            "无法读取本地文件元数据",
            err.to_string(),
        )
    })?;
    let bytes = fs::read(path).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_snapshot_failed",
            "无法读取本地文件内容",
            err.to_string(),
        )
    })?;
    let content_hash = format!("{:x}", Sha256::digest(&bytes));
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    Ok(RemoteFileSnapshot {
        mtime_ms,
        size: bytes.len() as u64,
        content_hash,
    })
}

fn is_same_snapshot(left: &RemoteFileSnapshot, right: &RemoteFileSnapshot) -> bool {
    left.mtime_ms == right.mtime_ms
        && left.size == right.size
        && left.content_hash == right.content_hash
}

fn load_remote_edit_index(app: &AppHandle) -> Result<RemoteEditIndexStore, EngineError> {
    let path = get_index_path(app)?;
    if !path.is_file() {
        return Ok(RemoteEditIndexStore {
            version: 1,
            entries: HashMap::new(),
        });
    }
    let raw = fs::read(&path).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_index_failed",
            "无法读取远端编辑索引",
            err.to_string(),
        )
    })?;
    let mut store = serde_json::from_slice::<RemoteEditIndexStore>(&raw).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_index_failed",
            "无法解析远端编辑索引",
            err.to_string(),
        )
    })?;
    if store.version == 0 {
        store.version = 1;
    }
    Ok(store)
}

fn write_remote_edit_index(
    app: &AppHandle,
    store: &RemoteEditIndexStore,
) -> Result<(), EngineError> {
    let root_dir = get_remote_files_cache_root_dir(app)?;
    fs::create_dir_all(&root_dir).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_index_failed",
            "无法创建远端编辑索引目录",
            err.to_string(),
        )
    })?;
    let path = get_index_path(app)?;
    let tmp_path = get_index_tmp_path(app)?;
    let bytes = serde_json::to_vec_pretty(store).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_index_failed",
            "无法序列化远端编辑索引",
            err.to_string(),
        )
    })?;
    fs::write(&tmp_path, bytes).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_index_failed",
            "无法写入远端编辑索引临时文件",
            err.to_string(),
        )
    })?;
    fs::rename(&tmp_path, &path).or_else(|rename_err| {
        if path.is_file() {
            fs::remove_file(&path).map_err(|remove_err| {
                EngineError::with_detail(
                    "remote_edit_index_failed",
                    "无法替换远端编辑索引文件",
                    format!("{rename_err}; {remove_err}"),
                )
            })?;
            fs::rename(&tmp_path, &path).map_err(|err| {
                EngineError::with_detail(
                    "remote_edit_index_failed",
                    "无法替换远端编辑索引文件",
                    err.to_string(),
                )
            })?;
            return Ok(());
        }
        Err(EngineError::with_detail(
            "remote_edit_index_failed",
            "无法替换远端编辑索引文件",
            rename_err.to_string(),
        ))
    })
}

fn upsert_remote_edit_index_entry(
    app: &AppHandle,
    entry: RemoteEditIndexEntry,
) -> Result<(), EngineError> {
    let mut store = load_remote_edit_index(app)?;
    store.version = 1;
    store.entries.insert(entry.instance_id.clone(), entry);
    write_remote_edit_index(app, &store)
}

fn remove_remote_edit_index_entry(app: &AppHandle, instance_id: &str) -> Result<(), EngineError> {
    let mut store = load_remote_edit_index(app)?;
    if store.entries.remove(instance_id).is_none() {
        return Ok(());
    }
    write_remote_edit_index(app, &store)
}

fn prune_stale_remote_edit_index_entries(app: &AppHandle) -> Result<usize, EngineError> {
    let mut store = load_remote_edit_index(app)?;
    let stale_ids = store
        .entries
        .iter()
        .filter_map(|(instance_id, entry)| {
            let target = RemoteEditTarget {
                session_host: entry.session_host.clone(),
                session_username: entry.session_username.clone(),
                session_port: entry.session_port,
            };
            let local_path =
                build_remote_edit_local_path(app, &target, &entry.remote_path, &entry.file_name)
                    .ok()?;
            if local_path.is_file() {
                return None;
            }
            Some(instance_id.clone())
        })
        .collect::<Vec<_>>();
    if stale_ids.is_empty() {
        return Ok(0);
    }
    let stale_count = stale_ids.len();
    for instance_id in stale_ids {
        store.entries.remove(&instance_id);
    }
    write_remote_edit_index(app, &store)?;
    Ok(stale_count)
}

/// 生成远端工作副本目录。
///
/// 目录规则强调“人能看懂 + 真相仍由索引和稳定键掌握”：
/// - 顶层使用 `host__p<port>`，避免与远端路径里的用户名重复
/// - 中间保留远端目录层级，方便人工排查
/// - 叶子目录用 `文件名__远端路径短哈希`，避免同名文件冲突
fn build_remote_edit_workspace_dir(
    app: &AppHandle,
    target: &RemoteEditTarget,
    remote_path: &str,
    file_name: &str,
) -> Result<PathBuf, EngineError> {
    let mut path = get_remote_files_cache_root_dir(app)?
        .join("active")
        .join(format!(
            "{}__p{}",
            sanitize_path_segment(&target.session_host, "host"),
            target.session_port
        ));

    let remote_segments = remote_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let directory_segments = if remote_segments.is_empty() {
        &[][..]
    } else {
        &remote_segments[..remote_segments.len().saturating_sub(1)]
    };
    for segment in directory_segments {
        path = path.join(sanitize_path_segment(segment, "dir"));
    }
    let workspace_leaf = format!(
        "{}__{}",
        sanitize_file_name(file_name),
        short_hash(remote_path)
    );
    Ok(path.join(workspace_leaf))
}

pub(crate) fn emit_remote_edit_update(app: &AppHandle, snapshot: &RemoteEditSnapshot) {
    let _ = app.emit("remote-edit:update", snapshot);
}

pub(crate) fn open_local_file(
    app: &AppHandle,
    file_path: &str,
    default_editor_path: Option<&str>,
) -> Result<(), EngineError> {
    if !Path::new(file_path).is_file() {
        return Err(EngineError::new(
            "file_open_failed",
            "目标文件不存在或不可访问",
        ));
    }

    if let Some(editor_path) = default_editor_path
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .filter(|editor_path| Path::new(editor_path).is_file())
        .filter(|editor_path| {
            app.opener()
                .open_path(file_path, Some(*editor_path))
                .is_ok()
        })
    {
        let _ = editor_path;
        return Ok(());
    }

    app.opener()
        .open_path(file_path, None::<&str>)
        .map_err(|error| {
            EngineError::with_detail("file_open_failed", "无法打开文件", error.to_string())
        })
}

fn ensure_remote_workspace_parent(path: &Path) -> Result<(), EngineError> {
    fs::create_dir_all(path).map_err(|err| {
        EngineError::with_detail(
            "remote_edit_cache_failed",
            "无法创建远端编辑工作副本目录",
            err.to_string(),
        )
    })
}

fn cleanup_legacy_remote_edit_meta(workspace_dir: &Path) {
    let legacy_meta_path = workspace_dir.join(REMOTE_FILE_INSTANCE_META);
    if legacy_meta_path.is_file() {
        let _ = fs::remove_file(legacy_meta_path);
    }
}

fn should_reuse_local_workspace(
    local_path: &Path,
    remote_entry: &SftpEntry,
    index_entry: &RemoteEditIndexEntry,
) -> Result<bool, EngineError> {
    let local_snapshot = read_local_file_snapshot(local_path)?;
    if !is_same_snapshot(&local_snapshot, &index_entry.baseline) {
        return Err(EngineError::new(
            "remote_edit_local_dirty",
            "本地工作副本存在未回传修改，不能直接继续打开",
        ));
    }
    Ok(remote_entry.mtime == index_entry.remote_mtime
        && remote_entry.size == index_entry.remote_size)
}

/// 打开远端文件前的后端一致性校验入口。
///
/// 规则：
/// - 始终先取远端 `stat`
/// - 若本地工作副本存在未回传修改，则拒绝继续打开
/// - 仅在本地基线与远端版本一致时复用本地工作副本
/// - 其余情况重新下载远端文件覆盖本地工作副本
pub(crate) fn remote_edit_prepare_open(
    app: &AppHandle,
    engine: &Arc<Engine>,
    session_id: &str,
    target: &RemoteEditTarget,
    entry: &SftpEntry,
    default_editor_path: Option<&str>,
) -> Result<(RemoteEditSnapshot, Option<RemoteEditInstance>), EngineError> {
    ensure_remote_file_cache_cleanup(app)?;
    let remote_entry = engine.sftp_stat(session_id, &entry.path)?;
    if !matches!(remote_entry.kind, engine::SftpEntryKind::File) {
        return Err(EngineError::new(
            "remote_edit_not_file",
            "当前条目不是可编辑文件",
        ));
    }

    let instance_id = build_remote_edit_instance_id(target, &remote_entry.path);
    let workspace_dir =
        build_remote_edit_workspace_dir(app, target, &remote_entry.path, &remote_entry.name)?;
    ensure_remote_workspace_parent(&workspace_dir)?;
    cleanup_legacy_remote_edit_meta(&workspace_dir);

    let local_path = workspace_dir.join(sanitize_file_name(&remote_entry.name));
    let local_exists = local_path.is_file();
    let index = load_remote_edit_index(app)?;
    let index_entry = index.entries.get(&instance_id).cloned();

    let (downloaded_at, baseline, open_mode) = if local_exists {
        let existing_index_entry = index_entry.ok_or_else(|| {
            EngineError::new(
                "remote_edit_workspace_invalid",
                "本地工作副本索引缺失或已损坏，无法确认文件基线",
            )
        })?;
        if existing_index_entry.instance_id != instance_id
            || existing_index_entry.remote_path != remote_entry.path
            || existing_index_entry.session_host != target.session_host
            || existing_index_entry.session_username != target.session_username
            || existing_index_entry.session_port != target.session_port
        {
            return Err(EngineError::new(
                "remote_edit_workspace_invalid",
                "本地工作副本索引与目标文件不匹配，无法安全复用",
            ));
        }
        if should_reuse_local_workspace(&local_path, &remote_entry, &existing_index_entry)? {
            (
                existing_index_entry.downloaded_at,
                existing_index_entry.baseline,
                "reused_local_workspace",
            )
        } else {
            engine.sftp_download(
                session_id,
                &remote_entry.path,
                local_path.to_string_lossy().as_ref(),
            )?;
            (
                now_epoch_millis(),
                read_local_file_snapshot(&local_path)?,
                "redownloaded_remote_file",
            )
        }
    } else {
        if index_entry.is_some() {
            remove_remote_edit_index_entry(app, &instance_id)?;
        }
        engine.sftp_download(
            session_id,
            &remote_entry.path,
            local_path.to_string_lossy().as_ref(),
        )?;
        (
            now_epoch_millis(),
            read_local_file_snapshot(&local_path)?,
            "created_local_workspace",
        )
    };

    let track_changes = is_remote_entry_editable_text(&remote_entry);
    let snapshot = RemoteEditSnapshot {
        instance_id: instance_id.clone(),
        session_id: session_id.to_string(),
        remote_path: remote_entry.path.clone(),
        local_path: local_path.to_string_lossy().to_string(),
        file_name: remote_entry.name.clone(),
        downloaded_at,
        remote_mtime: remote_entry.mtime,
        remote_size: remote_entry.size,
        track_changes,
        status: RemoteEditStatus::Synced,
        last_synced_at: now_epoch_millis(),
        last_error_code: None,
        last_error: None,
    };
    open_local_file(
        app,
        local_path.to_string_lossy().as_ref(),
        default_editor_path,
    )?;
    upsert_remote_edit_index_entry(
        app,
        RemoteEditIndexEntry {
            instance_id,
            session_id: session_id.to_string(),
            session_host: target.session_host.clone(),
            session_username: target.session_username.clone(),
            session_port: target.session_port,
            remote_path: remote_entry.path.clone(),
            file_name: remote_entry.name.clone(),
            downloaded_at: snapshot.downloaded_at,
            remote_mtime: remote_entry.mtime,
            remote_size: remote_entry.size,
            track_changes,
            baseline: baseline.clone(),
        },
    )?;
    log_remote_edit_event(
        TelemetryLevel::Info,
        "remote.edit.open.prepared",
        json!({
            "sessionId": session_id,
            "instanceId": snapshot.instance_id,
            "remotePath": snapshot.remote_path,
            "localPath": snapshot.local_path,
            "trackChanges": snapshot.track_changes,
            "mode": open_mode,
        }),
    );
    if !track_changes {
        return Ok((snapshot, None));
    }
    let (stop_tx, _stop_rx) = watch::channel(false);
    Ok((
        snapshot.clone(),
        Some(RemoteEditInstance {
            snapshot,
            baseline,
            pending_snapshot: None,
            ignored_content_hash: None,
            stop_tx,
            session_host: target.session_host.clone(),
            session_username: target.session_username.clone(),
            session_port: target.session_port,
        }),
    ))
}

pub(crate) fn persist_remote_edit_instance(
    app: &AppHandle,
    instance: &RemoteEditInstance,
) -> Result<(), EngineError> {
    upsert_remote_edit_index_entry(
        app,
        RemoteEditIndexEntry {
            instance_id: instance.snapshot.instance_id.clone(),
            session_id: instance.snapshot.session_id.clone(),
            session_host: instance.session_host.clone(),
            session_username: instance.session_username.clone(),
            session_port: instance.session_port,
            remote_path: instance.snapshot.remote_path.clone(),
            file_name: instance.snapshot.file_name.clone(),
            downloaded_at: instance.snapshot.downloaded_at,
            remote_mtime: instance.snapshot.remote_mtime,
            remote_size: instance.snapshot.remote_size,
            track_changes: instance.snapshot.track_changes,
            baseline: instance.baseline.clone(),
        },
    )
}

pub(crate) async fn spawn_remote_edit_monitor(
    app: AppHandle,
    instance: Arc<Mutex<RemoteEditInstance>>,
) {
    let stop_rx = {
        let guard = instance.lock().await;
        guard.stop_tx.subscribe()
    };
    tokio::spawn(async move {
        let mut stop_rx = stop_rx;
        let mut interval =
            tokio::time::interval(Duration::from_millis(REMOTE_EDIT_POLL_INTERVAL_MS));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let (local_path, baseline, ignored_content_hash, status) = {
                        let guard = instance.lock().await;
                        (
                            guard.snapshot.local_path.clone(),
                            guard.baseline.clone(),
                            guard.ignored_content_hash.clone(),
                            guard.snapshot.status.clone(),
                        )
                    };
                    if matches!(status, RemoteEditStatus::Uploading | RemoteEditStatus::PendingConfirm) {
                        continue;
                    }
                    let current_snapshot = match read_local_file_snapshot(Path::new(&local_path)) {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            let mut guard = instance.lock().await;
                            guard.snapshot.status = RemoteEditStatus::SyncFailed;
                            guard.snapshot.last_error_code = Some(error.code.clone());
                            guard.snapshot.last_error = Some(error.message.clone());
                            emit_remote_edit_update(&app, &guard.snapshot);
                            continue;
                        }
                    };
                    if now_epoch_millis().saturating_sub(current_snapshot.mtime_ms) < REMOTE_EDIT_QUIET_WINDOW_MS {
                        continue;
                    }
                    if is_same_snapshot(&current_snapshot, &baseline) {
                        continue;
                    }
                    if ignored_content_hash.as_deref() == Some(current_snapshot.content_hash.as_str()) {
                        continue;
                    }
                    let mut guard = instance.lock().await;
                    if matches!(guard.snapshot.status, RemoteEditStatus::Uploading | RemoteEditStatus::PendingConfirm) {
                        continue;
                    }
                    guard.snapshot.status = RemoteEditStatus::PendingConfirm;
                    guard.snapshot.last_error_code = None;
                    guard.snapshot.last_error = None;
                    guard.pending_snapshot = Some(current_snapshot);
                    log_remote_edit_event(
                        TelemetryLevel::Info,
                        "remote.edit.local.change.detected",
                        json!({
                            "sessionId": guard.snapshot.session_id,
                            "instanceId": guard.snapshot.instance_id,
                            "remotePath": guard.snapshot.remote_path,
                        }),
                    );
                    emit_remote_edit_update(&app, &guard.snapshot);
                }
                changed = stop_rx.changed() => {
                    if changed.is_ok() && *stop_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });
}
