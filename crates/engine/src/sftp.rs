//! SFTP 操作实现。
//!
//! 本模块同时承载单文件与批量目录传输。
//! 目录批量传输采用“扫描-调度-执行-聚合”流水线模型：
//! - 扫描器流式产出任务
//! - worker 池并发处理 mkdir/文件传输
//! - 聚合器统一汇报 job 级进度与最终状态
//!
//! 本模块同时定义 SFTP 传输日志事件约定，作为实现侧唯一说明来源。
//! 当前约定如下：
//!
//! - 开始事件：
//!   - `sftp_upload_start`
//!   - `sftp_download_start`
//! - 成功事件：
//!   - `sftp_upload_success`
//!   - `sftp_download_success`
//!   - 批量任务会使用独立的 `*_batch_*` / `*_dir_*` 事件名
//! - 失败事件：
//!   - `sftp_upload_failed`
//!   - `sftp_download_failed`
//!   - 初始化、目录、重命名等失败会使用对应操作名
//!
//! 上传与下载成功/失败日志统一使用 `source_path` 与 `target_path`，以便跨方向分析；
//! 开始事件保留更直观的原始字段名。通用字段包括 `session_id`、`started_at_ms`、
//! `elapsed_ms`、`transferred_bytes` 与 `total_bytes`。成功事件额外记录平均速率，
//! 失败事件额外记录 `error_code`、`error_message` 与 `error_detail`。
use futures_util::stream::{FuturesUnordered, StreamExt};
use russh::client;
use russh_sftp::client::error::Error as SftpClientError;
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::extensions;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde_json::json;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex as TokioMutex, mpsc};
use tokio::task::JoinSet;
use tokio::time::{Duration, timeout};

use crate::error::EngineError;
use crate::telemetry::{TelemetryLevel, log_telemetry};
use crate::types::{
    EngineEvent, EventCallback, SftpEntry, SftpEntryKind, SftpProgress, SftpProgressOp,
    SftpTransferKind, SftpTransferStatus,
};

/// SFTP 传输过程中附带进度的错误信息。
struct TransferProgressError {
    error: EngineError,
    transferred: u64,
}

/// SFTP 传输日志上下文。
struct TransferLogContext<'a> {
    session_id: &'a str,
    source_path: &'a str,
    target_path: &'a str,
    started_at_ms: u128,
    elapsed_ms: u128,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
}

/// SFTP 传输进度回调上下文。
#[derive(Clone, Copy)]
struct TransferProgressContext<'a> {
    session_id: &'a str,
    transfer_id: &'a str,
    op: SftpProgressOp,
    kind: SftpTransferKind,
    path: &'a str,
    display_name: &'a str,
    item_label: &'a str,
    target_name: Option<&'a str>,
    current_item_name: Option<&'a str>,
    total: Option<u64>,
    completed_items: u64,
    total_items: Option<u64>,
    failed_items: u64,
    status: SftpTransferStatus,
    on_event: &'a EventCallback,
}

/// SFTP 原始会话能力限制。
#[derive(Clone, Copy, Default)]
struct RawSftpLimits {
    read_limit: Option<u64>,
    write_limit: Option<u64>,
}

/// 批量上传流水线任务。
enum UploadPipelineTask {
    CreateRemoteDir {
        remote_dir: String,
        display_name: String,
    },
    UploadFile {
        local_path: PathBuf,
        remote_path: String,
        display_name: String,
    },
}

/// 目录下载流水线任务。
enum DownloadPipelineTask {
    CreateLocalDir {
        local_path: PathBuf,
        display_name: String,
    },
    DownloadFile {
        remote_path: String,
        local_path: PathBuf,
        display_name: String,
    },
}

/// 批量传输进度聚合状态。
#[derive(Clone)]
struct PipelineProgressState {
    transferred: u64,
    total_bytes: Option<u64>,
    completed_items: u64,
    total_items: u64,
    failed_items: u64,
    status: SftpTransferStatus,
}

/// 批量传输进度发射上下文。
#[derive(Clone)]
struct PipelineEmitContext {
    session_id: String,
    transfer_id: String,
    op: SftpProgressOp,
    kind: SftpTransferKind,
    path: String,
    display_name: String,
    target_name: Option<String>,
    on_event: EventCallback,
}

/// 批量任务 worker 并发数。
const BATCH_WORKER_COUNT: usize = 8;
/// SFTP 初始化单阶段超时，避免不支持服务端长时间阻塞会话命令分发。
const SFTP_INIT_STAGE_TIMEOUT_MS: u64 = 1200;
/// 单文件上传分块并发写窗口。
const UPLOAD_WRITE_WINDOW: usize = 8;
/// 单文件下载分块并发读窗口。
const DOWNLOAD_READ_WINDOW: usize = 8;

/// 下载 pipeline 文件级性能指标。
struct DownloadPipelinePerf {
    transferred_bytes: u64,
    read_requests: u64,
    eof_responses: u64,
    max_in_flight: usize,
    max_pending_chunks: usize,
}

/// 远端扫描下载任务的上下文。
struct DownloadScanContext<'a> {
    sftp: &'a SftpSession,
    remote_root: &'a str,
    local_root: &'a Path,
    tx: &'a mpsc::UnboundedSender<DownloadPipelineTask>,
    state: &'a Arc<Mutex<PipelineProgressState>>,
    emit_context: &'a PipelineEmitContext,
    cancel_flag: &'a AtomicBool,
}

/// SFTP 性能埋点统计维度。
struct SftpPerfStats<'a> {
    stage: &'a str,
    session_id: &'a str,
    op: SftpProgressOp,
    kind: SftpTransferKind,
    mode: &'a str,
    elapsed_ms: u128,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
    completed_items: u64,
    failed_items: u64,
    total_items: Option<u64>,
    worker_count: Option<usize>,
    scan_elapsed_ms: Option<u128>,
    write_window: Option<usize>,
    read_window: Option<usize>,
}

/// 生成 SFTP 传输任务标识。
///
/// 该标识会跨 session 主循环与具体传输任务共享，用于进度归集和取消定位。
pub(crate) fn next_transfer_id() -> String {
    format!("sftp-{}", now_epoch_millis())
}

/// 构造统一的“用户主动取消”错误。
fn transfer_cancelled_error() -> EngineError {
    EngineError::new("sftp_transfer_cancelled", "传输已取消")
}

/// 读取传输取消标记。
fn is_transfer_cancelled(cancel_flag: &AtomicBool) -> bool {
    cancel_flag.load(Ordering::Relaxed)
}

/// 根据项目总数生成任务展示标签。
fn items_label(total_items: Option<u64>) -> String {
    match total_items {
        Some(count) => format!("{count} items"),
        None => "items".to_string(),
    }
}

/// 发出任务取消的最终状态事件。
fn emit_cancelled_progress(
    on_event: &EventCallback,
    context: TransferProgressContext<'_>,
    transferred: u64,
) {
    emit_transfer_progress(
        on_event,
        TransferProgressContext {
            status: SftpTransferStatus::Cancelled,
            ..context
        },
        transferred,
    );
}

/// 读取远端目录条目列表。
pub async fn sftp_list(
    session: &client::Handle<super::session::ClientHandler>,
    path: &str,
) -> Result<Vec<SftpEntry>, EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.list.start",
        None,
        json!({
            "path": path,
            "startedAtMs": started_at,
        }),
    );
    let sftp = open_sftp(session).await?;
    let entries = sftp.read_dir(path.to_string()).await.map_err(|err| {
        let err = EngineError::with_detail("sftp_list_failed", "无法读取目录", err.to_string());
        log_sftp_path_failure(
            "sftp_list_failed",
            path,
            started_at,
            started.elapsed().as_millis(),
            &err,
        );
        err
    })?;
    let mut results = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let hidden = name.starts_with('.');
        let base = path.trim_end_matches('/');
        let full_path = if base.is_empty() {
            format!("/{}", name)
        } else {
            format!("{}/{}", base, name)
        };
        let metadata = entry.metadata();
        let kind = match entry.file_type() {
            russh_sftp::protocol::FileType::Dir => SftpEntryKind::Dir,
            russh_sftp::protocol::FileType::Symlink => SftpEntryKind::Link,
            _ => SftpEntryKind::File,
        };
        let owner = metadata
            .user
            .clone()
            .or_else(|| metadata.uid.map(|value| value.to_string()));
        let group = metadata
            .group
            .clone()
            .or_else(|| metadata.gid.map(|value| value.to_string()));
        results.push(SftpEntry {
            path: full_path,
            name,
            kind,
            // 远端第一版仅按类 Unix 约定以 `.` 前缀识别隐藏文件，
            // 不承诺支持 Windows 远端的隐藏属性语义。
            hidden: Some(hidden),
            size: metadata.size,
            mtime: metadata.mtime.map(|t| t as u64),
            permissions: metadata.permissions.map(format_permissions),
            owner,
            group,
        });
    }
    results.sort_by(|a, b| a.name.cmp(&b.name));
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.list.success",
        None,
        json!({
            "path": path,
            "startedAtMs": started_at,
            "elapsedMs": started.elapsed().as_millis(),
            "entryCount": results.len(),
        }),
    );
    Ok(results)
}

/// 获取远端单个文件或目录信息。
pub async fn sftp_stat(
    session: &client::Handle<super::session::ClientHandler>,
    path: &str,
) -> Result<SftpEntry, EngineError> {
    let normalized = path.trim_end_matches('/');
    let parent = if normalized.is_empty() || normalized == "/" {
        "/".to_string()
    } else {
        normalized
            .rsplit_once('/')
            .map(|(dir, _)| {
                if dir.is_empty() {
                    "/".to_string()
                } else {
                    dir.to_string()
                }
            })
            .unwrap_or_else(|| "/".to_string())
    };
    let file_name = normalized
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| EngineError::new("sftp_stat_failed", "无法识别远端路径名称"))?;
    let entries = sftp_list(session, &parent).await?;
    entries
        .into_iter()
        .find(|entry| entry.path == normalized || entry.name == file_name)
        .ok_or_else(|| EngineError::new("sftp_stat_failed", "远端文件不存在或不可访问"))
}

/// 上传本地文件至远端。
pub async fn sftp_upload(
    session: &client::Handle<super::session::ClientHandler>,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
    transfer_id: &str,
    cancel_flag: &AtomicBool,
    on_event: &EventCallback,
) -> Result<(), EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    let display_name = file_name_from_path(local_path);
    let item_label = items_label(Some(1));
    let (sftp, limits) = open_raw_sftp(session).await?;
    let mut local = tokio::fs::File::open(local_path).await.map_err(|err| {
        EngineError::with_detail("sftp_upload_failed", "无法读取本地文件", err.to_string())
    })?;
    let metadata = local.metadata().await.ok();
    let total = metadata.map(|m| m.len());
    let target_name = file_name_from_path(remote_path);
    let progress_context = TransferProgressContext {
        session_id,
        transfer_id,
        op: SftpProgressOp::Upload,
        kind: SftpTransferKind::File,
        path: remote_path,
        display_name: &display_name,
        item_label: &item_label,
        target_name: Some(&target_name),
        current_item_name: Some(&display_name),
        total,
        completed_items: 0,
        total_items: Some(1),
        failed_items: 0,
        status: SftpTransferStatus::Running,
        on_event,
    };
    emit_transfer_progress(on_event, progress_context, 0);
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.upload.start",
        None,
        json!({
            "sessionId": session_id,
            "sourcePath": local_path,
            "targetPath": remote_path,
            "startedAtMs": started_at,
            "totalBytes": total.unwrap_or(0),
        }),
    );
    let handle = sftp
        .open(
            remote_path.to_string(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            FileAttributes::empty(),
        )
        .await
        .map_err(|err| {
            EngineError::with_detail("sftp_upload_failed", "无法创建远端文件", err.to_string())
        })?;
    let handle_id = handle.handle.clone();
    let mut chunk_size = 256 * 1024usize;
    if let Some(limit) = limits.write_limit {
        chunk_size = chunk_size.min(limit as usize);
    }
    if chunk_size == 0 {
        chunk_size = 256 * 1024;
    }
    let mut buf = vec![0u8; chunk_size];
    let mut offset = 0u64;
    let mut transferred = 0u64;
    let mut in_flight: JoinSet<Result<usize, EngineError>> = JoinSet::new();
    let max_in_flight = UPLOAD_WRITE_WINDOW;

    loop {
        if is_transfer_cancelled(cancel_flag) {
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            let _ = sftp.close_session();
            emit_cancelled_progress(on_event, progress_context, transferred);
            return Ok(());
        }
        let n = local.read(&mut buf).await.map_err(|err| {
            EngineError::with_detail("sftp_transfer_failed", "无法读取文件数据", err.to_string())
        })?;
        if n == 0 {
            break;
        }
        while in_flight.len() >= max_in_flight {
            if let Some(result) = in_flight.join_next().await {
                match result {
                    Ok(Ok(len)) => {
                        transferred += len as u64;
                        emit_transfer_progress(on_event, progress_context, transferred);
                    }
                    Ok(Err(err)) => {
                        log_sftp_failure(
                            "sftp_upload_failed",
                            &TransferLogContext {
                                session_id,
                                source_path: local_path,
                                target_path: remote_path,
                                started_at_ms: started_at,
                                elapsed_ms: started.elapsed().as_millis(),
                                transferred_bytes: transferred,
                                total_bytes: total,
                            },
                            &err,
                        );
                        in_flight.abort_all();
                        let _ = sftp.close(handle_id.clone()).await;
                        let _ = sftp.close_session();
                        return Err(err);
                    }
                    Err(err) => {
                        let err = EngineError::with_detail(
                            "sftp_transfer_failed",
                            "无法写入文件数据",
                            err.to_string(),
                        );
                        log_sftp_failure(
                            "sftp_upload_failed",
                            &TransferLogContext {
                                session_id,
                                source_path: local_path,
                                target_path: remote_path,
                                started_at_ms: started_at,
                                elapsed_ms: started.elapsed().as_millis(),
                                transferred_bytes: transferred,
                                total_bytes: total,
                            },
                            &err,
                        );
                        in_flight.abort_all();
                        let _ = sftp.close(handle_id.clone()).await;
                        let _ = sftp.close_session();
                        return Err(err);
                    }
                }
            }
        }
        let data = buf[..n].to_vec();
        let session = sftp.clone();
        let handle = handle_id.clone();
        let write_offset = offset;
        in_flight.spawn(async move {
            session
                .write(handle, write_offset, data)
                .await
                .map(|_| n)
                .map_err(|err| {
                    EngineError::with_detail(
                        "sftp_transfer_failed",
                        "无法写入文件数据",
                        err.to_string(),
                    )
                })
        });
        offset += n as u64;
    }

    while let Some(result) = in_flight.join_next().await {
        if is_transfer_cancelled(cancel_flag) {
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            let _ = sftp.close_session();
            emit_cancelled_progress(on_event, progress_context, transferred);
            return Ok(());
        }
        match result {
            Ok(Ok(len)) => {
                transferred += len as u64;
                emit_transfer_progress(on_event, progress_context, transferred);
            }
            Ok(Err(err)) => {
                log_sftp_failure(
                    "sftp_upload_failed",
                    &TransferLogContext {
                        session_id,
                        source_path: local_path,
                        target_path: remote_path,
                        started_at_ms: started_at,
                        elapsed_ms: started.elapsed().as_millis(),
                        transferred_bytes: transferred,
                        total_bytes: total,
                    },
                    &err,
                );
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                let _ = sftp.close_session();
                return Err(err);
            }
            Err(err) => {
                let err = EngineError::with_detail(
                    "sftp_transfer_failed",
                    "无法写入文件数据",
                    err.to_string(),
                );
                log_sftp_failure(
                    "sftp_upload_failed",
                    &TransferLogContext {
                        session_id,
                        source_path: local_path,
                        target_path: remote_path,
                        started_at_ms: started_at,
                        elapsed_ms: started.elapsed().as_millis(),
                        transferred_bytes: transferred,
                        total_bytes: total,
                    },
                    &err,
                );
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                let _ = sftp.close_session();
                return Err(err);
            }
        }
    }

    sftp.close(handle_id).await.map_err(|err| {
        EngineError::with_detail("sftp_upload_failed", "无法关闭远端文件", err.to_string())
    })?;
    let _ = sftp.close_session();
    emit_transfer_progress(
        on_event,
        TransferProgressContext {
            completed_items: 1,
            status: SftpTransferStatus::Success,
            ..progress_context
        },
        transferred,
    );
    log_sftp_success(
        "sftp_upload_success",
        &TransferLogContext {
            session_id,
            source_path: local_path,
            target_path: remote_path,
            started_at_ms: started_at,
            elapsed_ms: started.elapsed().as_millis(),
            transferred_bytes: transferred,
            total_bytes: total,
        },
    );
    log_sftp_perf(SftpPerfStats {
        stage: "final",
        session_id,
        op: SftpProgressOp::Upload,
        kind: SftpTransferKind::File,
        mode: "single_file",
        elapsed_ms: started.elapsed().as_millis(),
        transferred_bytes: transferred,
        total_bytes: total,
        completed_items: 1,
        failed_items: 0,
        total_items: Some(1),
        worker_count: None,
        scan_elapsed_ms: None,
        write_window: Some(UPLOAD_WRITE_WINDOW),
        read_window: None,
    });
    Ok(())
}

/// 递归上传本地文件或目录到远端目录。
pub async fn sftp_upload_batch(
    session: &client::Handle<super::session::ClientHandler>,
    session_id: &str,
    local_paths: &[String],
    remote_dir: &str,
    transfer_id: &str,
    cancel_flag: &AtomicBool,
    on_event: &EventCallback,
) -> Result<(), EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    let local_roots: Vec<PathBuf> = local_paths
        .iter()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    if local_roots.is_empty() {
        return Err(EngineError::new(
            "sftp_upload_failed",
            "没有可上传的本地路径",
        ));
    }

    let state = Arc::new(Mutex::new(PipelineProgressState {
        transferred: 0,
        total_bytes: Some(0),
        completed_items: 0,
        total_items: 0,
        failed_items: 0,
        status: SftpTransferStatus::Running,
    }));
    let emit_context = PipelineEmitContext {
        session_id: session_id.to_string(),
        transfer_id: transfer_id.to_string(),
        op: SftpProgressOp::Upload,
        kind: SftpTransferKind::Batch,
        path: remote_dir.to_string(),
        display_name: items_label(None),
        target_name: None,
        on_event: Arc::clone(on_event),
    };
    emit_pipeline_progress(
        &emit_context,
        &state
            .lock()
            .expect("pipeline progress mutex poisoned")
            .clone(),
        None,
    );
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.upload.batch.start",
        None,
        json!({
            "sessionId": session_id,
            "targetPath": remote_dir,
            "startedAtMs": started_at,
            "mode": "pipeline",
        }),
    );

    let (task_tx, task_rx) = mpsc::unbounded_channel::<UploadPipelineTask>();
    let task_rx = Arc::new(TokioMutex::new(task_rx));
    let remote_dir_cache = Arc::new(TokioMutex::new(HashSet::<String>::from([
        "/".to_string(),
        remote_dir.to_string(),
    ])));

    let mut workers = FuturesUnordered::new();
    for _ in 0..BATCH_WORKER_COUNT {
        workers.push(upload_pipeline_worker(
            session,
            Arc::clone(&task_rx),
            Arc::clone(&remote_dir_cache),
            Arc::clone(&state),
            emit_context.clone(),
            cancel_flag,
        ));
    }

    let scan_started = Instant::now();
    for root in &local_roots {
        if is_transfer_cancelled(cancel_flag) {
            break;
        }
        if let Err(err) = stream_local_upload_tasks(
            root,
            remote_dir,
            &task_tx,
            &state,
            &emit_context,
            cancel_flag,
        ) {
            log_telemetry(
                TelemetryLevel::Warn,
                "sftp.upload.batch.stream.failed",
                None,
                json!({
                    "path": root.to_string_lossy().to_string(),
                    "error": {
                        "code": err.code,
                        "message": err.message,
                        "detail": err.detail,
                    }
                }),
            );
            pipeline_discover_failed_item(&state, &emit_context);
        }
    }
    drop(task_tx);
    let scan_elapsed_ms = scan_started.elapsed().as_millis();

    let mut worker_failed = false;
    while let Some(result) = workers.next().await {
        match result {
            Ok(()) => {}
            Err(err) => {
                worker_failed = true;
                log_telemetry(
                    TelemetryLevel::Warn,
                    "sftp.upload.batch.worker.failed",
                    None,
                    json!({
                        "error": {
                            "code": err.code,
                            "message": err.message,
                            "detail": err.detail,
                        }
                    }),
                );
            }
        }
    }

    if is_transfer_cancelled(cancel_flag) {
        let snapshot =
            finalize_pipeline_state(&state, &emit_context, SftpTransferStatus::Cancelled);
        log_sftp_success(
            "sftp_upload_batch_cancelled",
            &TransferLogContext {
                session_id,
                source_path: "batch",
                target_path: remote_dir,
                started_at_ms: started_at,
                elapsed_ms: started.elapsed().as_millis(),
                transferred_bytes: snapshot.transferred,
                total_bytes: snapshot.total_bytes,
            },
        );
        log_sftp_perf(SftpPerfStats {
            stage: "final",
            session_id,
            op: SftpProgressOp::Upload,
            kind: SftpTransferKind::Batch,
            mode: "pipeline",
            elapsed_ms: started.elapsed().as_millis(),
            transferred_bytes: snapshot.transferred,
            total_bytes: snapshot.total_bytes,
            completed_items: snapshot.completed_items,
            failed_items: snapshot.failed_items,
            total_items: Some(snapshot.total_items),
            worker_count: Some(BATCH_WORKER_COUNT),
            scan_elapsed_ms: Some(scan_elapsed_ms),
            write_window: Some(UPLOAD_WRITE_WINDOW),
            read_window: None,
        });
        return Ok(());
    }

    let current = state
        .lock()
        .expect("pipeline progress mutex poisoned")
        .clone();
    let final_status = if worker_failed {
        if current.completed_items > 0 {
            SftpTransferStatus::PartialSuccess
        } else {
            SftpTransferStatus::Failed
        }
    } else if current.failed_items == 0 {
        SftpTransferStatus::Success
    } else if current.completed_items > 0 {
        SftpTransferStatus::PartialSuccess
    } else {
        SftpTransferStatus::Failed
    };
    let snapshot = finalize_pipeline_state(&state, &emit_context, final_status);

    match final_status {
        SftpTransferStatus::Success | SftpTransferStatus::PartialSuccess => {
            log_sftp_success(
                "sftp_upload_batch_success",
                &TransferLogContext {
                    session_id,
                    source_path: "batch",
                    target_path: remote_dir,
                    started_at_ms: started_at,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: snapshot.transferred,
                    total_bytes: snapshot.total_bytes,
                },
            );
            log_sftp_perf(SftpPerfStats {
                stage: "final",
                session_id,
                op: SftpProgressOp::Upload,
                kind: SftpTransferKind::Batch,
                mode: "pipeline",
                elapsed_ms: started.elapsed().as_millis(),
                transferred_bytes: snapshot.transferred,
                total_bytes: snapshot.total_bytes,
                completed_items: snapshot.completed_items,
                failed_items: snapshot.failed_items,
                total_items: Some(snapshot.total_items),
                worker_count: Some(BATCH_WORKER_COUNT),
                scan_elapsed_ms: Some(scan_elapsed_ms),
                write_window: Some(UPLOAD_WRITE_WINDOW),
                read_window: None,
            });
            Ok(())
        }
        _ => {
            let err = EngineError::new("sftp_upload_failed", "批量上传失败");
            log_sftp_failure(
                "sftp_upload_batch_failed",
                &TransferLogContext {
                    session_id,
                    source_path: "batch",
                    target_path: remote_dir,
                    started_at_ms: started_at,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: snapshot.transferred,
                    total_bytes: snapshot.total_bytes,
                },
                &err,
            );
            log_sftp_perf(SftpPerfStats {
                stage: "final",
                session_id,
                op: SftpProgressOp::Upload,
                kind: SftpTransferKind::Batch,
                mode: "pipeline",
                elapsed_ms: started.elapsed().as_millis(),
                transferred_bytes: snapshot.transferred,
                total_bytes: snapshot.total_bytes,
                completed_items: snapshot.completed_items,
                failed_items: snapshot.failed_items,
                total_items: Some(snapshot.total_items),
                worker_count: Some(BATCH_WORKER_COUNT),
                scan_elapsed_ms: Some(scan_elapsed_ms),
                write_window: Some(UPLOAD_WRITE_WINDOW),
                read_window: None,
            });
            Err(err)
        }
    }
}

/// 将单个本地文件上传到远端，并把文件级进度回调给上层聚合任务。
async fn upload_local_file_to_remote(
    sftp: &Arc<RawSftpSession>,
    write_limit: Option<u64>,
    local_path: &Path,
    remote_path: &str,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(u64),
) -> Result<u64, EngineError> {
    let mut local = tokio::fs::File::open(local_path).await.map_err(|err| {
        EngineError::with_detail("sftp_upload_failed", "无法读取本地文件", err.to_string())
    })?;
    let handle = sftp
        .open(
            remote_path.to_string(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            FileAttributes::empty(),
        )
        .await
        .map_err(|err| {
            EngineError::with_detail("sftp_upload_failed", "无法创建远端文件", err.to_string())
        })?;
    let handle_id = handle.handle.clone();
    let mut chunk_size = 256 * 1024usize;
    if let Some(limit) = write_limit {
        chunk_size = chunk_size.min(limit as usize);
    }
    if chunk_size == 0 {
        chunk_size = 256 * 1024;
    }
    let mut buf = vec![0u8; chunk_size];
    let mut offset = 0u64;
    let mut transferred = 0u64;
    let mut in_flight: JoinSet<Result<usize, EngineError>> = JoinSet::new();
    let max_in_flight = UPLOAD_WRITE_WINDOW;

    loop {
        if is_transfer_cancelled(cancel_flag) {
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            return Err(transfer_cancelled_error());
        }
        let n = local.read(&mut buf).await.map_err(|err| {
            EngineError::with_detail("sftp_transfer_failed", "无法读取文件数据", err.to_string())
        })?;
        if n == 0 {
            break;
        }
        while in_flight.len() >= max_in_flight {
            match in_flight.join_next().await {
                Some(Ok(Ok(len))) => {
                    transferred += len as u64;
                    on_progress(transferred);
                }
                Some(Ok(Err(err))) => {
                    in_flight.abort_all();
                    let _ = sftp.close(handle_id.clone()).await;
                    return Err(err);
                }
                Some(Err(err)) => {
                    in_flight.abort_all();
                    let _ = sftp.close(handle_id.clone()).await;
                    return Err(EngineError::with_detail(
                        "sftp_transfer_failed",
                        "无法写入文件数据",
                        err.to_string(),
                    ));
                }
                None => break,
            }
        }
        let data = buf[..n].to_vec();
        let session = Arc::clone(sftp);
        let handle = handle_id.clone();
        let write_offset = offset;
        in_flight.spawn(async move {
            session
                .write(handle, write_offset, data)
                .await
                .map(|_| n)
                .map_err(|err| {
                    EngineError::with_detail(
                        "sftp_transfer_failed",
                        "无法写入文件数据",
                        err.to_string(),
                    )
                })
        });
        offset += n as u64;
    }

    while let Some(result) = in_flight.join_next().await {
        if is_transfer_cancelled(cancel_flag) {
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            return Err(transfer_cancelled_error());
        }
        match result {
            Ok(Ok(len)) => {
                transferred += len as u64;
                on_progress(transferred);
            }
            Ok(Err(err)) => {
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                return Err(err);
            }
            Err(err) => {
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                return Err(EngineError::with_detail(
                    "sftp_transfer_failed",
                    "无法写入文件数据",
                    err.to_string(),
                ));
            }
        }
    }

    sftp.close(handle_id).await.map_err(|err| {
        EngineError::with_detail("sftp_upload_failed", "无法关闭远端文件", err.to_string())
    })?;
    Ok(transferred)
}

/// 基于 Raw SFTP 会话确保远端目录存在；已存在视为成功。
async fn ensure_remote_dir_exists_raw(
    sftp: &Arc<RawSftpSession>,
    path: &str,
) -> Result<(), EngineError> {
    if path.is_empty() || path == "/" {
        return Ok(());
    }
    match sftp.mkdir(path.to_string(), FileAttributes::empty()).await {
        Ok(_) => Ok(()),
        Err(err) => {
            if sftp.stat(path.to_string()).await.is_ok() {
                Ok(())
            } else {
                Err(EngineError::with_detail(
                    "sftp_mkdir_failed",
                    "无法创建目录",
                    err.to_string(),
                ))
            }
        }
    }
}

/// 解析远端路径的父目录。
fn remote_parent(path: &str) -> Option<String> {
    let normalized = path.trim_end_matches('/');
    if normalized.is_empty() || normalized == "/" {
        return None;
    }
    normalized.rfind('/').map(|index| {
        if index == 0 {
            "/".to_string()
        } else {
            normalized[..index].to_string()
        }
    })
}

/// 按需创建远端父目录链，并写入共享目录缓存。
async fn ensure_remote_parent_dirs_raw(
    sftp: &Arc<RawSftpSession>,
    cache: &TokioMutex<HashSet<String>>,
    dir_path: &str,
) -> Result<(), EngineError> {
    if dir_path.is_empty() || dir_path == "/" {
        return Ok(());
    }
    let mut targets = Vec::new();
    let mut current = if dir_path.starts_with('/') {
        "/".to_string()
    } else {
        String::new()
    };
    for part in dir_path.split('/').filter(|part| !part.is_empty()) {
        current = remote_join(&current, part);
        targets.push(current.clone());
    }
    for dir in targets {
        {
            let guard = cache.lock().await;
            if guard.contains(&dir) {
                continue;
            }
        }
        ensure_remote_dir_exists_raw(sftp, &dir).await?;
        cache.lock().await.insert(dir);
    }
    Ok(())
}

/// 将本地目录树流式转换为上传任务并推送到队列。
fn stream_local_upload_tasks(
    root: &Path,
    remote_dir: &str,
    tx: &mpsc::UnboundedSender<UploadPipelineTask>,
    state: &Arc<Mutex<PipelineProgressState>>,
    emit_context: &PipelineEmitContext,
    cancel_flag: &AtomicBool,
) -> Result<(), EngineError> {
    let metadata = fs::symlink_metadata(root).map_err(|err| {
        EngineError::with_detail(
            "sftp_upload_failed",
            "无法读取本地文件信息",
            err.to_string(),
        )
    })?;
    if metadata.file_type().is_symlink() {
        pipeline_discover_failed_item(state, emit_context);
        return Err(EngineError::new(
            "sftp_upload_failed",
            "暂不支持上传符号链接",
        ));
    }

    let root_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| EngineError::new("sftp_upload_failed", "无法识别上传根目录名称"))?
        .to_string();
    let remote_root = remote_join(remote_dir, &root_name);

    if metadata.is_file() {
        pipeline_discover_item(state, emit_context, Some(metadata.len()));
        tx.send(UploadPipelineTask::UploadFile {
            local_path: root.to_path_buf(),
            remote_path: remote_root,
            display_name: root_name,
        })
        .map_err(|err| {
            EngineError::with_detail("sftp_upload_failed", "无法调度上传任务", err.to_string())
        })?;
        return Ok(());
    }

    if !metadata.is_dir() {
        pipeline_discover_failed_item(state, emit_context);
        return Err(EngineError::new(
            "sftp_upload_failed",
            "暂不支持上传该类型条目",
        ));
    }

    pipeline_discover_item(state, emit_context, Some(0));
    tx.send(UploadPipelineTask::CreateRemoteDir {
        remote_dir: remote_root.clone(),
        display_name: root_name.clone(),
    })
    .map_err(|err| {
        EngineError::with_detail(
            "sftp_upload_failed",
            "无法调度目录创建任务",
            err.to_string(),
        )
    })?;

    let mut stack = vec![root.to_path_buf()];
    while let Some(current_dir) = stack.pop() {
        if is_transfer_cancelled(cancel_flag) {
            return Ok(());
        }
        for entry in fs::read_dir(&current_dir).map_err(|err| {
            EngineError::with_detail("sftp_upload_failed", "无法读取本地目录", err.to_string())
        })? {
            let entry = entry.map_err(|err| {
                EngineError::with_detail(
                    "sftp_upload_failed",
                    "无法读取本地目录条目",
                    err.to_string(),
                )
            })?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|err| {
                EngineError::with_detail(
                    "sftp_upload_failed",
                    "无法读取本地文件信息",
                    err.to_string(),
                )
            })?;
            let relative = path
                .strip_prefix(root)
                .map_err(|err| {
                    EngineError::with_detail(
                        "sftp_upload_failed",
                        "无法计算本地相对路径",
                        err.to_string(),
                    )
                })?
                .to_string_lossy()
                .replace('\\', "/");
            if meta.file_type().is_symlink() {
                pipeline_discover_failed_item(state, emit_context);
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                pipeline_discover_item(state, emit_context, Some(0));
                tx.send(UploadPipelineTask::CreateRemoteDir {
                    remote_dir: remote_join(&remote_root, &relative),
                    display_name: relative,
                })
                .map_err(|err| {
                    EngineError::with_detail(
                        "sftp_upload_failed",
                        "无法调度目录创建任务",
                        err.to_string(),
                    )
                })?;
                continue;
            }
            if meta.is_file() {
                pipeline_discover_item(state, emit_context, Some(meta.len()));
                tx.send(UploadPipelineTask::UploadFile {
                    local_path: path,
                    remote_path: remote_join(&remote_root, &relative),
                    display_name: relative,
                })
                .map_err(|err| {
                    EngineError::with_detail(
                        "sftp_upload_failed",
                        "无法调度上传任务",
                        err.to_string(),
                    )
                })?;
                continue;
            }
            pipeline_discover_failed_item(state, emit_context);
        }
    }
    Ok(())
}

/// 递归扫描远端目录并流式推送下载任务。
async fn stream_remote_download_tasks(
    ctx: &DownloadScanContext<'_>,
    relative_dir: &str,
) -> Result<(), EngineError> {
    if is_transfer_cancelled(ctx.cancel_flag) {
        return Ok(());
    }
    let current_remote = if relative_dir.is_empty() {
        ctx.remote_root.to_string()
    } else {
        format!("{}/{}", ctx.remote_root, relative_dir)
    };
    let entries = ctx
        .sftp
        .read_dir(current_remote.clone())
        .await
        .map_err(|err| {
            EngineError::with_detail("sftp_list_failed", "无法读取目录", err.to_string())
        })?;
    for entry in entries {
        if is_transfer_cancelled(ctx.cancel_flag) {
            return Ok(());
        }
        let name = entry.file_name();
        let next_relative = if relative_dir.is_empty() {
            name.clone()
        } else {
            format!("{relative_dir}/{name}")
        };
        let next_remote = format!("{}/{}", current_remote.trim_end_matches('/'), name);
        let next_local = ctx
            .local_root
            .join(relative_path_to_local_path(&next_relative));
        match entry.file_type() {
            russh_sftp::protocol::FileType::Dir => {
                pipeline_discover_item(ctx.state, ctx.emit_context, Some(0));
                ctx.tx
                    .send(DownloadPipelineTask::CreateLocalDir {
                        local_path: next_local,
                        display_name: next_relative.clone(),
                    })
                    .map_err(|err| {
                        EngineError::with_detail(
                            "sftp_download_failed",
                            "无法调度目录创建任务",
                            err.to_string(),
                        )
                    })?;
                Box::pin(stream_remote_download_tasks(ctx, &next_relative)).await?;
            }
            _ => {
                pipeline_discover_item(ctx.state, ctx.emit_context, entry.metadata().size);
                ctx.tx
                    .send(DownloadPipelineTask::DownloadFile {
                        remote_path: next_remote,
                        local_path: next_local,
                        display_name: next_relative,
                    })
                    .map_err(|err| {
                        EngineError::with_detail(
                            "sftp_download_failed",
                            "无法调度下载任务",
                            err.to_string(),
                        )
                    })?;
            }
        }
    }
    Ok(())
}

/// 批量上传 worker：消费任务队列并执行目录创建/文件上传。
async fn upload_pipeline_worker(
    session: &client::Handle<super::session::ClientHandler>,
    task_rx: Arc<TokioMutex<mpsc::UnboundedReceiver<UploadPipelineTask>>>,
    remote_dir_cache: Arc<TokioMutex<HashSet<String>>>,
    state: Arc<Mutex<PipelineProgressState>>,
    emit_context: PipelineEmitContext,
    cancel_flag: &AtomicBool,
) -> Result<(), EngineError> {
    let (raw_sftp, limits) = open_raw_sftp(session).await?;
    loop {
        if is_transfer_cancelled(cancel_flag) {
            break;
        }
        let task = {
            let mut guard = task_rx.lock().await;
            guard.recv().await
        };
        let Some(task) = task else {
            break;
        };
        match task {
            UploadPipelineTask::CreateRemoteDir {
                remote_dir,
                display_name,
            } => match ensure_remote_dir_exists_raw(&raw_sftp, &remote_dir).await {
                Ok(()) => {
                    remote_dir_cache.lock().await.insert(remote_dir);
                    pipeline_complete_item(&state, &emit_context, &display_name);
                }
                Err(err) => {
                    pipeline_fail_item(&state, &emit_context, &display_name);
                    log_telemetry(
                        TelemetryLevel::Warn,
                        "sftp.upload.batch.dir.failed",
                        None,
                        json!({
                            "path": display_name,
                            "error": {
                                "code": err.code,
                                "message": err.message,
                                "detail": err.detail,
                            }
                        }),
                    );
                }
            },
            UploadPipelineTask::UploadFile {
                local_path,
                remote_path,
                display_name,
            } => {
                if let Some(parent) = remote_parent(&remote_path)
                    && let Err(err) =
                        ensure_remote_parent_dirs_raw(&raw_sftp, &remote_dir_cache, &parent).await
                {
                    pipeline_fail_item(&state, &emit_context, &display_name);
                    log_telemetry(
                        TelemetryLevel::Warn,
                        "sftp.upload.batch.mkdir.parent.failed",
                        None,
                        json!({
                            "path": display_name,
                            "error": {
                                "code": err.code,
                                "message": err.message,
                                "detail": err.detail,
                            }
                        }),
                    );
                    continue;
                }
                let mut last_transferred = 0u64;
                match upload_local_file_to_remote(
                    &raw_sftp,
                    limits.write_limit,
                    &local_path,
                    &remote_path,
                    cancel_flag,
                    |file_transferred| {
                        let delta = file_transferred.saturating_sub(last_transferred);
                        last_transferred = file_transferred;
                        pipeline_add_transferred(&state, &emit_context, &display_name, delta);
                    },
                )
                .await
                {
                    Ok(_) => {
                        pipeline_complete_item(&state, &emit_context, &display_name);
                    }
                    Err(err) if err.code == "sftp_transfer_cancelled" => break,
                    Err(err) => {
                        pipeline_fail_item(&state, &emit_context, &display_name);
                        log_telemetry(
                            TelemetryLevel::Warn,
                            "sftp.upload.batch.file.failed",
                            None,
                            json!({
                                "path": display_name,
                                "error": {
                                    "code": err.code,
                                    "message": err.message,
                                    "detail": err.detail,
                                }
                            }),
                        );
                    }
                }
            }
        }
    }
    let _ = raw_sftp.close_session();
    Ok(())
}

/// 目录下载 worker：消费任务队列并执行本地目录创建/文件下载。
async fn download_pipeline_worker(
    session: &client::Handle<super::session::ClientHandler>,
    task_rx: Arc<TokioMutex<mpsc::UnboundedReceiver<DownloadPipelineTask>>>,
    state: Arc<Mutex<PipelineProgressState>>,
    emit_context: PipelineEmitContext,
    cancel_flag: &AtomicBool,
) -> Result<(), EngineError> {
    let (raw_sftp, limits) = open_raw_sftp(session).await?;
    loop {
        if is_transfer_cancelled(cancel_flag) {
            break;
        }
        let task = {
            let mut guard = task_rx.lock().await;
            guard.recv().await
        };
        let Some(task) = task else {
            break;
        };
        match task {
            DownloadPipelineTask::CreateLocalDir {
                local_path,
                display_name,
            } => match tokio::fs::create_dir_all(&local_path).await {
                Ok(()) => {
                    pipeline_complete_item(&state, &emit_context, &display_name);
                }
                Err(err) => {
                    pipeline_fail_item(&state, &emit_context, &display_name);
                    log_telemetry(
                        TelemetryLevel::Warn,
                        "sftp.download.dir.mkdir.failed",
                        None,
                        json!({
                            "path": display_name,
                            "error": {
                                "code": "sftp_download_dir_mkdir_failed",
                                "message": "本地目录创建失败",
                                "detail": err.to_string(),
                            }
                        }),
                    );
                }
            },
            DownloadPipelineTask::DownloadFile {
                remote_path,
                local_path,
                display_name,
            } => {
                if let Some(parent) = local_path.parent()
                    && tokio::fs::create_dir_all(parent).await.is_err()
                {
                    pipeline_fail_item(&state, &emit_context, &display_name);
                    continue;
                }
                let mut last_transferred = 0u64;
                match download_remote_file_to_local_pipelined(
                    &raw_sftp,
                    limits.read_limit,
                    &remote_path,
                    &local_path,
                    cancel_flag,
                    |file_transferred| {
                        let delta = file_transferred.saturating_sub(last_transferred);
                        last_transferred = file_transferred;
                        pipeline_add_transferred(&state, &emit_context, &display_name, delta);
                    },
                )
                .await
                {
                    Ok(perf) => {
                        log_telemetry(
                            TelemetryLevel::Debug,
                            "sftp.download.pipeline.file.summary",
                            None,
                            json!({
                                "path": display_name,
                                "transferredBytes": perf.transferred_bytes,
                                "readRequests": perf.read_requests,
                                "eofResponses": perf.eof_responses,
                                "maxInFlight": perf.max_in_flight,
                                "maxPendingChunks": perf.max_pending_chunks,
                            }),
                        );
                        pipeline_complete_item(&state, &emit_context, &display_name);
                    }
                    Err(err) if err.code == "sftp_transfer_cancelled" => break,
                    Err(err) => {
                        pipeline_fail_item(&state, &emit_context, &display_name);
                        log_telemetry(
                            TelemetryLevel::Warn,
                            "sftp.download.dir.file.failed",
                            None,
                            json!({
                                "path": display_name,
                                "error": {
                                    "code": err.code,
                                    "message": err.message,
                                    "detail": err.detail,
                                }
                            }),
                        );
                    }
                }
            }
        }
    }
    let _ = raw_sftp.close_session();
    Ok(())
}

async fn remove_remote_path_recursive(sftp: &SftpSession, path: &str) -> Result<(), EngineError> {
    if sftp.remove_file(path.to_string()).await.is_ok() {
        return Ok(());
    }
    let entries = sftp.read_dir(path.to_string()).await.map_err(|err| {
        EngineError::with_detail("sftp_remove_failed", "无法删除", err.to_string())
    })?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child_path = remote_join(path, &name);
        match entry.file_type() {
            russh_sftp::protocol::FileType::Dir => {
                Box::pin(remove_remote_path_recursive(sftp, &child_path)).await?;
            }
            _ => {
                sftp.remove_file(child_path).await.map_err(|err| {
                    EngineError::with_detail("sftp_remove_failed", "无法删除", err.to_string())
                })?;
            }
        }
    }
    sftp.remove_dir(path.to_string()).await.map_err(|err| {
        EngineError::with_detail("sftp_remove_failed", "无法删除", err.to_string())
    })?;
    Ok(())
}

fn remote_join(base: &str, child: &str) -> String {
    let normalized_base = if base == "/" {
        "/".to_string()
    } else {
        base.trim_end_matches('/').to_string()
    };
    let normalized_child = child.trim_matches('/');
    if normalized_child.is_empty() {
        return normalized_base;
    }
    if normalized_base.is_empty() || normalized_base == "/" {
        return format!("/{}", normalized_child);
    }
    format!("{normalized_base}/{normalized_child}")
}

/// 下载远端文件至本地。
pub async fn sftp_download(
    session: &client::Handle<super::session::ClientHandler>,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
    transfer_id: &str,
    cancel_flag: &AtomicBool,
    on_event: &EventCallback,
) -> Result<(), EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    let display_name = file_name_from_path(remote_path);
    let item_label = items_label(Some(1));
    let sftp = open_sftp(session).await?;
    let mut remote = sftp.open(remote_path.to_string()).await.map_err(|err| {
        EngineError::with_detail("sftp_download_failed", "无法打开远端文件", err.to_string())
    })?;
    let total = remote.metadata().await.ok().and_then(|m| m.size);
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.download.start",
        None,
        json!({
            "sessionId": session_id,
            "sourcePath": remote_path,
            "targetPath": local_path,
            "startedAtMs": started_at,
            "totalBytes": total.unwrap_or(0),
        }),
    );
    let resolved_local_path = resolve_available_local_path(Path::new(local_path)).await?;
    let resolved_target_name = resolved_local_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(display_name.as_str())
        .to_string();
    let progress_context = TransferProgressContext {
        session_id,
        transfer_id,
        op: SftpProgressOp::Download,
        kind: SftpTransferKind::File,
        path: remote_path,
        display_name: &display_name,
        item_label: &item_label,
        target_name: Some(&resolved_target_name),
        current_item_name: Some(&display_name),
        total,
        completed_items: 0,
        total_items: Some(1),
        failed_items: 0,
        status: SftpTransferStatus::Running,
        on_event,
    };
    emit_transfer_progress(on_event, progress_context, 0);
    let mut local = tokio::fs::File::create(&resolved_local_path)
        .await
        .map_err(|err| {
            EngineError::with_detail("sftp_download_failed", "无法创建本地文件", err.to_string())
        })?;
    let result = transfer_with_progress(
        TransferProgressContext { ..progress_context },
        &mut remote,
        &mut local,
        cancel_flag,
    )
    .await;
    match result {
        Ok(transferred) => {
            emit_transfer_progress(
                on_event,
                TransferProgressContext {
                    completed_items: 1,
                    status: SftpTransferStatus::Success,
                    ..progress_context
                },
                transferred,
            );
            log_sftp_success(
                "sftp_download_success",
                &TransferLogContext {
                    session_id,
                    source_path: remote_path,
                    target_path: resolved_local_path.to_string_lossy().as_ref(),
                    started_at_ms: started_at,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: transferred,
                    total_bytes: total,
                },
            );
            log_sftp_perf(SftpPerfStats {
                stage: "final",
                session_id,
                op: SftpProgressOp::Download,
                kind: SftpTransferKind::File,
                mode: "single_file",
                elapsed_ms: started.elapsed().as_millis(),
                transferred_bytes: transferred,
                total_bytes: total,
                completed_items: 1,
                failed_items: 0,
                total_items: Some(1),
                worker_count: None,
                scan_elapsed_ms: None,
                write_window: None,
                read_window: None,
            });
            Ok(())
        }
        Err(err) => {
            if err.error.code == "sftp_transfer_cancelled" {
                let _ = tokio::fs::remove_file(&resolved_local_path).await;
                emit_cancelled_progress(on_event, progress_context, err.transferred);
                return Ok(());
            }
            emit_transfer_progress(
                on_event,
                TransferProgressContext {
                    failed_items: 1,
                    status: SftpTransferStatus::Failed,
                    ..progress_context
                },
                err.transferred,
            );
            log_sftp_failure(
                "sftp_download_failed",
                &TransferLogContext {
                    session_id,
                    source_path: remote_path,
                    target_path: resolved_local_path.to_string_lossy().as_ref(),
                    started_at_ms: started_at,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: err.transferred,
                    total_bytes: total,
                },
                &err.error,
            );
            Err(err.error)
        }
    }
}

/// 递归下载远端目录到本地目录。
///
/// 流程分为两阶段：
/// 1. 预扫描远端目录树，统计目录/文件项与总字节数。
/// 2. 在本地创建同名根目录后，顺序创建子目录并顺序下载文件。
///
/// 第一版默认允许部分成功：
/// - 某个目录或文件失败时继续后续项
/// - 最终状态由 completed_items 与 failed_items 聚合判定
pub async fn sftp_download_dir(
    session: &client::Handle<super::session::ClientHandler>,
    session_id: &str,
    remote_path: &str,
    local_dir: &str,
    transfer_id: &str,
    cancel_flag: &AtomicBool,
    on_event: &EventCallback,
) -> Result<(), EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    let sftp = open_sftp(session).await?;
    let root_name = file_name_from_path(remote_path);
    let root_path = resolve_available_local_path(&Path::new(local_dir).join(&root_name)).await?;
    let state = Arc::new(Mutex::new(PipelineProgressState {
        transferred: 0,
        total_bytes: Some(0),
        completed_items: 0,
        total_items: 0,
        failed_items: 0,
        status: SftpTransferStatus::Running,
    }));
    let emit_context = PipelineEmitContext {
        session_id: session_id.to_string(),
        transfer_id: transfer_id.to_string(),
        op: SftpProgressOp::Download,
        kind: SftpTransferKind::Directory,
        path: remote_path.to_string(),
        display_name: root_name.clone(),
        target_name: root_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string()),
        on_event: Arc::clone(on_event),
    };
    emit_pipeline_progress(
        &emit_context,
        &state
            .lock()
            .expect("pipeline progress mutex poisoned")
            .clone(),
        None,
    );
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.download.dir.start",
        None,
        json!({
            "sessionId": session_id,
            "sourcePath": remote_path,
            "targetPath": local_dir,
            "startedAtMs": started_at,
            "mode": "pipeline",
        }),
    );

    let (task_tx, task_rx) = mpsc::unbounded_channel::<DownloadPipelineTask>();
    let task_rx = Arc::new(TokioMutex::new(task_rx));
    let mut workers = FuturesUnordered::new();
    for _ in 0..BATCH_WORKER_COUNT {
        workers.push(download_pipeline_worker(
            session,
            Arc::clone(&task_rx),
            Arc::clone(&state),
            emit_context.clone(),
            cancel_flag,
        ));
    }

    let root_display_name = root_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(root_name.as_str())
        .to_string();
    pipeline_discover_item(&state, &emit_context, Some(0));
    if let Err(err) = task_tx.send(DownloadPipelineTask::CreateLocalDir {
        local_path: root_path.clone(),
        display_name: root_display_name,
    }) {
        return Err(EngineError::with_detail(
            "sftp_download_failed",
            "无法调度本地目录创建任务",
            err.to_string(),
        ));
    }

    let scan_started = Instant::now();
    let scan_ctx = DownloadScanContext {
        sftp: &sftp,
        remote_root: remote_path.trim_end_matches('/'),
        local_root: &root_path,
        tx: &task_tx,
        state: &state,
        emit_context: &emit_context,
        cancel_flag,
    };
    if let Err(err) = stream_remote_download_tasks(&scan_ctx, "").await {
        log_telemetry(
            TelemetryLevel::Warn,
            "sftp.download.scan.failed",
            None,
            json!({
                "path": remote_path,
                "error": {
                    "code": err.code,
                    "message": err.message,
                    "detail": err.detail,
                }
            }),
        );
        pipeline_discover_failed_item(&state, &emit_context);
    }
    drop(task_tx);
    let scan_elapsed_ms = scan_started.elapsed().as_millis();

    let mut worker_failed = false;
    while let Some(result) = workers.next().await {
        match result {
            Ok(()) => {}
            Err(err) => {
                worker_failed = true;
                log_telemetry(
                    TelemetryLevel::Warn,
                    "sftp.download.worker.failed",
                    None,
                    json!({
                        "error": {
                            "code": err.code,
                            "message": err.message,
                            "detail": err.detail,
                        }
                    }),
                );
            }
        }
    }

    if is_transfer_cancelled(cancel_flag) {
        let snapshot =
            finalize_pipeline_state(&state, &emit_context, SftpTransferStatus::Cancelled);
        log_sftp_perf(SftpPerfStats {
            stage: "final",
            session_id,
            op: SftpProgressOp::Download,
            kind: SftpTransferKind::Directory,
            mode: "pipeline",
            elapsed_ms: started.elapsed().as_millis(),
            transferred_bytes: snapshot.transferred,
            total_bytes: snapshot.total_bytes,
            completed_items: snapshot.completed_items,
            failed_items: snapshot.failed_items,
            total_items: Some(snapshot.total_items),
            worker_count: Some(BATCH_WORKER_COUNT),
            scan_elapsed_ms: Some(scan_elapsed_ms),
            write_window: None,
            read_window: Some(DOWNLOAD_READ_WINDOW),
        });
        return Ok(());
    }

    let current = state
        .lock()
        .expect("pipeline progress mutex poisoned")
        .clone();
    let final_status = if worker_failed {
        if current.completed_items > 0 {
            SftpTransferStatus::PartialSuccess
        } else {
            SftpTransferStatus::Failed
        }
    } else if current.failed_items == 0 {
        SftpTransferStatus::Success
    } else if current.completed_items > 0 {
        SftpTransferStatus::PartialSuccess
    } else {
        SftpTransferStatus::Failed
    };
    let snapshot = finalize_pipeline_state(&state, &emit_context, final_status);
    match final_status {
        SftpTransferStatus::Success | SftpTransferStatus::PartialSuccess => {
            log_sftp_success(
                "sftp_download_dir_success",
                &TransferLogContext {
                    session_id,
                    source_path: remote_path,
                    target_path: local_dir,
                    started_at_ms: started_at,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: snapshot.transferred,
                    total_bytes: snapshot.total_bytes,
                },
            );
            log_sftp_perf(SftpPerfStats {
                stage: "final",
                session_id,
                op: SftpProgressOp::Download,
                kind: SftpTransferKind::Directory,
                mode: "pipeline",
                elapsed_ms: started.elapsed().as_millis(),
                transferred_bytes: snapshot.transferred,
                total_bytes: snapshot.total_bytes,
                completed_items: snapshot.completed_items,
                failed_items: snapshot.failed_items,
                total_items: Some(snapshot.total_items),
                worker_count: Some(BATCH_WORKER_COUNT),
                scan_elapsed_ms: Some(scan_elapsed_ms),
                write_window: None,
                read_window: Some(DOWNLOAD_READ_WINDOW),
            });
            Ok(())
        }
        _ => {
            let err = EngineError::new("sftp_download_failed", "目录下载失败");
            log_sftp_failure(
                "sftp_download_dir_failed",
                &TransferLogContext {
                    session_id,
                    source_path: remote_path,
                    target_path: local_dir,
                    started_at_ms: started_at,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: snapshot.transferred,
                    total_bytes: snapshot.total_bytes,
                },
                &err,
            );
            log_sftp_perf(SftpPerfStats {
                stage: "final",
                session_id,
                op: SftpProgressOp::Download,
                kind: SftpTransferKind::Directory,
                mode: "pipeline",
                elapsed_ms: started.elapsed().as_millis(),
                transferred_bytes: snapshot.transferred,
                total_bytes: snapshot.total_bytes,
                completed_items: snapshot.completed_items,
                failed_items: snapshot.failed_items,
                total_items: Some(snapshot.total_items),
                worker_count: Some(BATCH_WORKER_COUNT),
                scan_elapsed_ms: Some(scan_elapsed_ms),
                write_window: None,
                read_window: Some(DOWNLOAD_READ_WINDOW),
            });
            Err(err)
        }
    }
}

/// 重命名远端文件或目录。
pub async fn sftp_rename(
    session: &client::Handle<super::session::ClientHandler>,
    from: &str,
    to: &str,
) -> Result<(), EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.rename.start",
        None,
        json!({
            "sourcePath": from,
            "targetPath": to,
            "startedAtMs": started_at,
        }),
    );
    let sftp = open_sftp(session).await?;
    sftp.rename(from.to_string(), to.to_string())
        .await
        .map_err(|err| {
            let err = EngineError::with_detail("sftp_rename_failed", "无法重命名", err.to_string());
            log_sftp_pair_failure(
                "sftp_rename_failed",
                from,
                to,
                started_at,
                started.elapsed().as_millis(),
                &err,
            );
            err
        })?;
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.rename.success",
        None,
        json!({
            "sourcePath": from,
            "targetPath": to,
            "startedAtMs": started_at,
            "elapsedMs": started.elapsed().as_millis(),
        }),
    );
    Ok(())
}

/// 删除远端文件。
pub async fn sftp_remove(
    session: &client::Handle<super::session::ClientHandler>,
    path: &str,
) -> Result<(), EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.remove.start",
        None,
        json!({
            "path": path,
            "startedAtMs": started_at,
        }),
    );
    let sftp = open_sftp(session).await?;
    remove_remote_path_recursive(&sftp, path)
        .await
        .inspect_err(|err| {
            log_sftp_path_failure(
                "sftp_remove_failed",
                path,
                started_at,
                started.elapsed().as_millis(),
                err,
            );
        })?;
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.remove.success",
        None,
        json!({
            "path": path,
            "startedAtMs": started_at,
            "elapsedMs": started.elapsed().as_millis(),
        }),
    );
    Ok(())
}

/// 创建远端目录。
pub async fn sftp_mkdir(
    session: &client::Handle<super::session::ClientHandler>,
    path: &str,
) -> Result<(), EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.mkdir.start",
        None,
        json!({
            "path": path,
            "startedAtMs": started_at,
        }),
    );
    let sftp = open_sftp(session).await?;
    sftp.create_dir(path.to_string()).await.map_err(|err| {
        let err = EngineError::with_detail("sftp_mkdir_failed", "无法创建目录", err.to_string());
        log_sftp_path_failure(
            "sftp_mkdir_failed",
            path,
            started_at,
            started.elapsed().as_millis(),
            &err,
        );
        err
    })?;
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.mkdir.success",
        None,
        json!({
            "path": path,
            "startedAtMs": started_at,
            "elapsedMs": started.elapsed().as_millis(),
        }),
    );
    Ok(())
}

/// 获取远端家目录路径。
pub async fn sftp_home(
    session: &client::Handle<super::session::ClientHandler>,
) -> Result<String, EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.home.start",
        None,
        json!({
            "startedAtMs": started_at,
        }),
    );
    let sftp = open_sftp(session).await?;
    let home = sftp.canonicalize(".").await.map_err(|err| {
        let err = EngineError::with_detail("sftp_home_failed", "无法获取家目录", err.to_string());
        log_telemetry(
            TelemetryLevel::Warn,
            "sftp.home.failed",
            None,
            json!({
                "startedAtMs": started_at,
                "elapsedMs": started.elapsed().as_millis(),
                "error": {
                    "code": err.code.clone(),
                    "message": err.message.clone(),
                    "detail": err.detail.clone(),
                }
            }),
        );
        err
    })?;
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.home.success",
        None,
        json!({
            "path": home.clone(),
            "startedAtMs": started_at,
            "elapsedMs": started.elapsed().as_millis(),
        }),
    );
    Ok(home)
}

/// 解析远端路径到真实路径。
pub async fn sftp_resolve_path(
    session: &client::Handle<super::session::ClientHandler>,
    path: &str,
) -> Result<String, EngineError> {
    let started_at = now_epoch_millis();
    let started = Instant::now();
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.resolve.path.start",
        None,
        json!({
            "path": path,
            "startedAtMs": started_at,
        }),
    );
    let sftp = open_sftp(session).await?;
    let resolved = sftp.canonicalize(path).await.map_err(|err| {
        let err = EngineError::with_detail(
            "sftp_resolve_path_failed",
            "无法解析远端路径",
            err.to_string(),
        );
        log_sftp_path_failure(
            "sftp_resolve_path_failed",
            path,
            started_at,
            started.elapsed().as_millis(),
            &err,
        );
        err
    })?;
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.resolve.path.success",
        None,
        json!({
            "path": path,
            "resolvedPath": resolved.clone(),
            "startedAtMs": started_at,
            "elapsedMs": started.elapsed().as_millis(),
        }),
    );
    Ok(resolved)
}

/// 使用窗口化预读的方式下载远端文件。
///
/// 通过同时发起多个 `read(offset)` 请求降低 RTT 带来的等待开销，
/// 并按偏移顺序写入本地文件，确保文件内容一致性。
async fn download_remote_file_to_local_pipelined(
    sftp: &Arc<RawSftpSession>,
    read_limit: Option<u64>,
    remote_path: &str,
    local_path: &Path,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(u64),
) -> Result<DownloadPipelinePerf, EngineError> {
    let started = Instant::now();
    let handle = sftp
        .open(
            remote_path.to_string(),
            OpenFlags::READ,
            FileAttributes::empty(),
        )
        .await
        .map_err(|err| {
            EngineError::with_detail("sftp_download_failed", "无法打开远端文件", err.to_string())
        })?;
    let handle_id = handle.handle.clone();
    let mut local = tokio::fs::File::create(local_path).await.map_err(|err| {
        EngineError::with_detail("sftp_download_failed", "无法创建本地文件", err.to_string())
    })?;
    let mut chunk_size = 256 * 1024usize;
    if let Some(limit) = read_limit {
        chunk_size = chunk_size.min(limit as usize);
    }
    if chunk_size == 0 {
        chunk_size = 64 * 1024;
    }
    let mut next_offset = 0u64;
    let mut expected_write_offset = 0u64;
    let mut transferred = 0u64;
    let mut read_requests = 0u64;
    let mut eof_responses = 0u64;
    let mut max_in_flight_seen = 0usize;
    let mut max_pending_chunks_seen = 0usize;
    let mut eof = false;
    let mut in_flight: JoinSet<Result<(u64, Vec<u8>), EngineError>> = JoinSet::new();
    let mut pending_chunks = BTreeMap::<u64, Vec<u8>>::new();
    let window_size = DOWNLOAD_READ_WINDOW;

    loop {
        if is_transfer_cancelled(cancel_flag) {
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            let _ = tokio::fs::remove_file(local_path).await;
            return Err(transfer_cancelled_error());
        }
        while !eof && in_flight.len() < window_size {
            let session = Arc::clone(sftp);
            let handle = handle_id.clone();
            let read_offset = next_offset;
            let read_len = chunk_size as u32;
            in_flight.spawn(async move {
                match session.read(handle, read_offset, read_len).await {
                    Ok(data) => Ok((read_offset, data.data.to_vec())),
                    Err(SftpClientError::Status(status))
                        if status.status_code == StatusCode::Eof =>
                    {
                        Ok((read_offset, Vec::new()))
                    }
                    Err(err) => Err(EngineError::with_detail(
                        "sftp_transfer_failed",
                        "无法读取文件数据",
                        err.to_string(),
                    )),
                }
            });
            next_offset += chunk_size as u64;
            read_requests += 1;
            max_in_flight_seen = max_in_flight_seen.max(in_flight.len());
        }
        if in_flight.is_empty() {
            break;
        }
        let result = in_flight.join_next().await;
        let Some(result) = result else {
            break;
        };
        let (offset, data) = match result {
            Ok(Ok(value)) => value,
            Ok(Err(err)) => {
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                return Err(err);
            }
            Err(err) => {
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                return Err(EngineError::with_detail(
                    "sftp_transfer_failed",
                    "无法读取文件数据",
                    err.to_string(),
                ));
            }
        };
        if data.is_empty() {
            eof = true;
            eof_responses += 1;
            continue;
        }
        pending_chunks.insert(offset, data);
        max_pending_chunks_seen = max_pending_chunks_seen.max(pending_chunks.len());
        while let Some(chunk) = pending_chunks.remove(&expected_write_offset) {
            local.write_all(&chunk).await.map_err(|err| {
                EngineError::with_detail(
                    "sftp_transfer_failed",
                    "无法写入文件数据",
                    err.to_string(),
                )
            })?;
            expected_write_offset += chunk.len() as u64;
            transferred += chunk.len() as u64;
            on_progress(transferred);
        }
    }

    sftp.close(handle_id).await.map_err(|err| {
        EngineError::with_detail("sftp_download_failed", "无法关闭远端文件", err.to_string())
    })?;
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.download.pipeline.file.perf",
        None,
        json!({
            "sourcePath": remote_path,
            "targetPath": local_path.to_string_lossy().to_string(),
            "elapsedMs": started.elapsed().as_millis(),
            "transferredBytes": transferred,
            "readRequests": read_requests,
            "eofResponses": eof_responses,
            "maxInFlight": max_in_flight_seen,
            "maxPendingChunks": max_pending_chunks_seen,
            "chunkSize": chunk_size,
            "readWindow": DOWNLOAD_READ_WINDOW,
        }),
    );
    Ok(DownloadPipelinePerf {
        transferred_bytes: transferred,
        read_requests,
        eof_responses,
        max_in_flight: max_in_flight_seen,
        max_pending_chunks: max_pending_chunks_seen,
    })
}

/// 发出聚合后的 SFTP 传输进度事件。
///
/// 单文件与目录下载都走同一进度结构，前端只消费 job 级视图，
/// 不需要区分底层是单文件还是批量目录任务。
fn emit_transfer_progress(
    on_event: &EventCallback,
    context: TransferProgressContext<'_>,
    transferred: u64,
) {
    (on_event)(EngineEvent::SftpProgress(SftpProgress {
        session_id: context.session_id.to_string(),
        transfer_id: context.transfer_id.to_string(),
        op: context.op,
        kind: context.kind,
        path: context.path.to_string(),
        display_name: context.display_name.to_string(),
        item_label: context.item_label.to_string(),
        target_name: context.target_name.map(|value| value.to_string()),
        current_item_name: context.current_item_name.map(|value| value.to_string()),
        transferred,
        total: context.total,
        completed_items: context.completed_items,
        total_items: context.total_items,
        status: context.status,
        failed_items: context.failed_items,
    }));
}

/// 发出流水线聚合后的 SFTP 进度事件。
fn emit_pipeline_progress(
    context: &PipelineEmitContext,
    state: &PipelineProgressState,
    current_item_name: Option<&str>,
) {
    (context.on_event)(EngineEvent::SftpProgress(SftpProgress {
        session_id: context.session_id.clone(),
        transfer_id: context.transfer_id.clone(),
        op: context.op,
        kind: context.kind,
        path: context.path.clone(),
        display_name: context.display_name.clone(),
        item_label: items_label(Some(state.total_items.max(1))),
        target_name: context.target_name.clone(),
        current_item_name: current_item_name.map(|value| value.to_string()),
        transferred: state.transferred,
        total: state.total_bytes,
        completed_items: state.completed_items,
        total_items: Some(state.total_items.max(1)),
        status: state.status,
        failed_items: state.failed_items,
    }));
}

/// 更新流水线聚合状态并发出进度事件。
fn update_pipeline_state(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
    current_item_name: Option<&str>,
    updater: impl FnOnce(&mut PipelineProgressState),
) {
    let snapshot = {
        let mut guard = state.lock().expect("pipeline progress mutex poisoned");
        updater(&mut guard);
        guard.clone()
    };
    emit_pipeline_progress(context, &snapshot, current_item_name);
}

/// 记录新发现的传输项（扫描阶段）。
fn pipeline_discover_item(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
    bytes: Option<u64>,
) {
    update_pipeline_state(state, context, None, |inner| {
        inner.total_items += 1;
        if let Some(total) = inner.total_bytes.as_mut() {
            if let Some(value) = bytes {
                *total += value;
            } else {
                inner.total_bytes = None;
            }
        }
    });
}

/// 记录扫描阶段直接失败的条目（如不支持类型/权限不足）。
fn pipeline_discover_failed_item(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
) {
    update_pipeline_state(state, context, None, |inner| {
        inner.total_items += 1;
        inner.failed_items += 1;
    });
}

/// 记录任务完成。
fn pipeline_complete_item(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
    current_item_name: &str,
) {
    update_pipeline_state(state, context, Some(current_item_name), |inner| {
        inner.completed_items += 1;
    });
}

/// 记录任务失败。
fn pipeline_fail_item(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
    current_item_name: &str,
) {
    update_pipeline_state(state, context, Some(current_item_name), |inner| {
        inner.failed_items += 1;
    });
}

/// 累积传输字节。
fn pipeline_add_transferred(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
    current_item_name: &str,
    delta: u64,
) {
    if delta == 0 {
        return;
    }
    update_pipeline_state(state, context, Some(current_item_name), |inner| {
        inner.transferred += delta;
    });
}

/// 以最终状态结束流水线任务并发出终态事件。
fn finalize_pipeline_state(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
    status: SftpTransferStatus,
) -> PipelineProgressState {
    let snapshot = {
        let mut guard = state.lock().expect("pipeline progress mutex poisoned");
        guard.status = status;
        guard.clone()
    };
    emit_pipeline_progress(context, &snapshot, None);
    snapshot
}

fn relative_path_to_local_path(relative_path: &str) -> PathBuf {
    let mut result = PathBuf::new();
    for part in relative_path.split('/').filter(|part| !part.is_empty()) {
        result.push(part);
    }
    result
}

/// 为本地下载目标生成一个不与已有文件/目录冲突的路径。
///
/// 规则与桌面文件管理器一致，优先尝试：
/// - `name`
/// - `name (1)`
/// - `name (2)`
///
/// 这样可以避免单文件下载覆盖已有文件，也避免目录下载把新内容合并进旧目录。
async fn resolve_available_local_path(path: &Path) -> Result<PathBuf, EngineError> {
    if tokio::fs::metadata(path).await.is_err() {
        return Ok(path.to_path_buf());
    }

    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    let file_name_fallback = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("download")
        .to_string();

    for index in 1.. {
        let candidate_name = if let Some(extension) = extension {
            format!("{stem} ({index}).{extension}")
        } else if path.extension().is_none() && path.file_name().is_some() {
            format!("{file_name_fallback} ({index})")
        } else {
            format!("{stem} ({index})")
        };
        let candidate = parent.join(candidate_name);
        if tokio::fs::metadata(&candidate).await.is_err() {
            return Ok(candidate);
        }
    }

    Err(EngineError::new(
        "sftp_download_failed",
        "无法生成可用的本地目标路径",
    ))
}

fn file_name_from_path(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// 以固定缓冲区大小复制并回调进度。
async fn transfer_with_progress(
    context: TransferProgressContext<'_>,
    reader: &mut (impl AsyncRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
    cancel_flag: &AtomicBool,
) -> Result<u64, TransferProgressError> {
    let mut buf = vec![0u8; 256 * 1024];
    let mut transferred = 0u64;
    loop {
        if is_transfer_cancelled(cancel_flag) {
            return Err(TransferProgressError {
                error: transfer_cancelled_error(),
                transferred,
            });
        }
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|err| TransferProgressError {
                error: EngineError::with_detail(
                    "sftp_transfer_failed",
                    "无法读取文件数据",
                    err.to_string(),
                ),
                transferred,
            })?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|err| TransferProgressError {
                error: EngineError::with_detail(
                    "sftp_transfer_failed",
                    "无法写入文件数据",
                    err.to_string(),
                ),
                transferred,
            })?;
        transferred += n as u64;
        emit_transfer_progress(
            context.on_event,
            TransferProgressContext {
                session_id: context.session_id,
                transfer_id: context.transfer_id,
                op: context.op,
                kind: context.kind,
                path: context.path,
                display_name: context.display_name,
                item_label: context.item_label,
                target_name: context.target_name,
                current_item_name: context.current_item_name,
                total: context.total,
                completed_items: context.completed_items,
                total_items: context.total_items,
                failed_items: context.failed_items,
                status: context.status,
                on_event: context.on_event,
            },
            transferred,
        );
    }
    Ok(transferred)
}

/// 获取当前 Unix 时间戳（毫秒）。
fn now_epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// 记录 SFTP 传输性能埋点日志，便于横向对比不同实现版本的吞吐表现。
fn log_sftp_perf(stats: SftpPerfStats) {
    let throughput_bps = (stats.transferred_bytes as u128 * 1000)
        .checked_div(stats.elapsed_ms)
        .unwrap_or(stats.transferred_bytes as u128) as u64;
    log_telemetry(
        TelemetryLevel::Debug,
        "sftp.perf.update",
        None,
        json!({
            "stage": stats.stage,
            "sessionId": stats.session_id,
            "op": format!("{:?}", stats.op),
            "kind": format!("{:?}", stats.kind),
            "mode": stats.mode,
            "elapsedMs": stats.elapsed_ms,
            "scanElapsedMs": stats.scan_elapsed_ms.unwrap_or(0),
            "transferredBytes": stats.transferred_bytes,
            "totalBytes": stats.total_bytes.unwrap_or(0),
            "throughputBps": throughput_bps,
            "completedItems": stats.completed_items,
            "failedItems": stats.failed_items,
            "totalItems": stats.total_items.unwrap_or(0),
            "workerCount": stats.worker_count.unwrap_or(0),
            "writeWindow": stats.write_window.unwrap_or(0),
            "readWindow": stats.read_window.unwrap_or(0),
        }),
    );
}

/// 记录 SFTP 传输成功日志。
fn log_sftp_success(action: &str, context: &TransferLogContext<'_>) {
    let speed_bytes_per_sec = (context.transferred_bytes as u128 * 1000)
        .checked_div(context.elapsed_ms)
        .unwrap_or(context.transferred_bytes as u128) as u64;
    log_telemetry(
        TelemetryLevel::Debug,
        &action.replace('_', "."),
        None,
        json!({
            "sessionId": context.session_id,
            "sourcePath": context.source_path,
            "targetPath": context.target_path,
            "startedAtMs": context.started_at_ms,
            "elapsedMs": context.elapsed_ms,
            "transferredBytes": context.transferred_bytes,
            "totalBytes": context.total_bytes.unwrap_or(0),
            "avgBytesPerSec": speed_bytes_per_sec,
        }),
    );
}

/// 记录 SFTP 传输失败日志。
fn log_sftp_failure(action: &str, context: &TransferLogContext<'_>, err: &EngineError) {
    log_telemetry(
        TelemetryLevel::Warn,
        &action.replace('_', "."),
        None,
        json!({
            "sessionId": context.session_id,
            "sourcePath": context.source_path,
            "targetPath": context.target_path,
            "startedAtMs": context.started_at_ms,
            "elapsedMs": context.elapsed_ms,
            "transferredBytes": context.transferred_bytes,
            "totalBytes": context.total_bytes.unwrap_or(0),
            "error": {
                "code": err.code,
                "message": err.message,
                "detail": err.detail,
            }
        }),
    );
}

/// 记录仅包含单一路径的 SFTP 操作失败日志。
fn log_sftp_path_failure(
    action: &str,
    path: &str,
    started_at_ms: u128,
    elapsed_ms: u128,
    err: &EngineError,
) {
    log_telemetry(
        TelemetryLevel::Warn,
        &action.replace('_', "."),
        None,
        json!({
            "path": path,
            "startedAtMs": started_at_ms,
            "elapsedMs": elapsed_ms,
            "error": {
                "code": err.code,
                "message": err.message,
                "detail": err.detail,
            }
        }),
    );
}

/// 记录包含源路径和目标路径的 SFTP 操作失败日志。
fn log_sftp_pair_failure(
    action: &str,
    source_path: &str,
    target_path: &str,
    started_at_ms: u128,
    elapsed_ms: u128,
    err: &EngineError,
) {
    log_telemetry(
        TelemetryLevel::Warn,
        &action.replace('_', "."),
        None,
        json!({
            "sourcePath": source_path,
            "targetPath": target_path,
            "startedAtMs": started_at_ms,
            "elapsedMs": elapsed_ms,
            "error": {
                "code": err.code,
                "message": err.message,
                "detail": err.detail,
            }
        }),
    );
}

/// 记录 SFTP 初始化阶段超时，便于分析服务端兼容性。
fn log_sftp_init_timeout(stage: &str, mode: &str) {
    log_telemetry(
        TelemetryLevel::Info,
        "sftp.init.timeout",
        None,
        json!({
            "stage": stage,
            "mode": mode,
            "timeoutMs": SFTP_INIT_STAGE_TIMEOUT_MS,
        }),
    );
}

/// 打开 SFTP 子系统会话。
async fn open_sftp(
    session: &client::Handle<super::session::ClientHandler>,
) -> Result<SftpSession, EngineError> {
    let channel = timeout(
        Duration::from_millis(SFTP_INIT_STAGE_TIMEOUT_MS),
        session.channel_open_session(),
    )
    .await
    .map_err(|_| {
        log_sftp_init_timeout("channel_open_session", "session");
        EngineError::with_detail(
            "sftp_init_failed",
            "无法打开 SFTP 通道（超时）",
            format!(
                "stage=channel_open_session timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail("sftp_init_failed", "无法打开 SFTP 通道", err.to_string())
    })?;
    timeout(
        Duration::from_millis(SFTP_INIT_STAGE_TIMEOUT_MS),
        channel.request_subsystem(true, "sftp"),
    )
    .await
    .map_err(|_| {
        log_sftp_init_timeout("request_subsystem", "session");
        EngineError::with_detail(
            "sftp_init_failed",
            "无法请求 SFTP 子系统（超时）",
            format!(
                "stage=request_subsystem timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail("sftp_init_failed", "无法请求 SFTP 子系统", err.to_string())
    })?;
    let stream = channel.into_stream();
    timeout(
        Duration::from_millis(SFTP_INIT_STAGE_TIMEOUT_MS),
        SftpSession::new(stream),
    )
    .await
    .map_err(|_| {
        log_sftp_init_timeout("sftp_session_new", "session");
        EngineError::with_detail(
            "sftp_init_failed",
            "无法初始化 SFTP（超时）",
            format!(
                "stage=sftp_session_new timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| EngineError::with_detail("sftp_init_failed", "无法初始化 SFTP", err.to_string()))
}

/// 打开 SFTP 原始会话并返回读写长度限制。
async fn open_raw_sftp(
    session: &client::Handle<super::session::ClientHandler>,
) -> Result<(Arc<RawSftpSession>, RawSftpLimits), EngineError> {
    let channel = timeout(
        Duration::from_millis(SFTP_INIT_STAGE_TIMEOUT_MS),
        session.channel_open_session(),
    )
    .await
    .map_err(|_| {
        log_sftp_init_timeout("channel_open_session", "raw");
        EngineError::with_detail(
            "sftp_init_failed",
            "无法打开 SFTP 通道（超时）",
            format!(
                "stage=channel_open_session timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail("sftp_init_failed", "无法打开 SFTP 通道", err.to_string())
    })?;
    timeout(
        Duration::from_millis(SFTP_INIT_STAGE_TIMEOUT_MS),
        channel.request_subsystem(true, "sftp"),
    )
    .await
    .map_err(|_| {
        log_sftp_init_timeout("request_subsystem", "raw");
        EngineError::with_detail(
            "sftp_init_failed",
            "无法请求 SFTP 子系统（超时）",
            format!(
                "stage=request_subsystem timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail("sftp_init_failed", "无法请求 SFTP 子系统", err.to_string())
    })?;
    let stream = channel.into_stream();
    let mut raw = RawSftpSession::new(stream);
    let version = timeout(
        Duration::from_millis(SFTP_INIT_STAGE_TIMEOUT_MS),
        raw.init(),
    )
    .await
    .map_err(|_| {
        log_sftp_init_timeout("raw_init", "raw");
        EngineError::with_detail(
            "sftp_init_failed",
            "无法初始化 SFTP（超时）",
            format!("stage=raw_init timeout={}ms", SFTP_INIT_STAGE_TIMEOUT_MS),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail("sftp_init_failed", "无法初始化 SFTP", err.to_string())
    })?;
    let mut limits_snapshot = RawSftpLimits::default();
    if version
        .extensions
        .get(extensions::LIMITS)
        .is_some_and(|value| value == "1")
    {
        let limits = raw.limits().await.map_err(|err| {
            EngineError::with_detail("sftp_init_failed", "无法获取 SFTP 限制", err.to_string())
        })?;
        let limits = russh_sftp::client::rawsession::Limits::from(limits);
        limits_snapshot.read_limit = limits.read_len;
        limits_snapshot.write_limit = limits.write_len;
        raw.set_limits(Arc::new(limits));
    }
    Ok((Arc::new(raw), limits_snapshot))
}

/// 将权限位转换为可读字符串。
fn format_permissions(perm: u32) -> String {
    let flags = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    flags
        .iter()
        .map(|(flag, ch)| if perm & *flag != 0 { *ch } else { '-' })
        .collect()
}
