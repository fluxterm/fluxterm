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
//! 上传与下载日志仅记录会话、耗时和最终字节数，不记录路径或文件名。
//! `elapsed_ms`、`transferred_bytes` 与 `total_bytes`。成功事件额外记录平均速率，
//! 失败事件额外记录 `error_code`、`error_message` 与 `error_detail`。
const SFTP_DOWNLOAD_FAILED_CODE: &str = "sftp_download_failed";
const SFTP_INIT_FAILED_CODE: &str = "sftp_init_failed";
const SFTP_LIST_FAILED_CODE: &str = "sftp_list_failed";
const SFTP_MKDIR_FAILED_CODE: &str = "sftp_mkdir_failed";
const SFTP_REMOVE_FAILED_CODE: &str = "sftp_remove_failed";
const SFTP_STAT_FAILED_CODE: &str = "sftp_stat_failed";
const SFTP_TRANSFER_FAILED_CODE: &str = "sftp_transfer_failed";
const SFTP_UPLOAD_FAILED_CODE: &str = "sftp_upload_failed";

use futures_util::stream::{FuturesUnordered, StreamExt};
use russh::client;
use russh_sftp::client::error::Error as SftpClientError;
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::extensions;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex as TokioMutex, mpsc};
use tokio::task::JoinSet;
use tokio::time::{Duration, timeout};
use uuid::Uuid;

use crate::error::EngineError;
use crate::types::{
    EngineEvent, EventCallback, SftpEntry, SftpEntryKind, SftpProgress, SftpProgressOp,
    SftpTransferKind, SftpTransferStatus,
};
use fluxterm_logging::{LogLevel, log_event};
#[cfg(feature = "performance-telemetry")]
use fluxterm_performance_telemetry::{
    HistogramAccumulator, MetricBatch, MetricUnit, MetricWindow, PerformanceDomain, RecordOutcome,
    StreamCorrelation, StreamDescriptor, StreamKind, StreamOutcome, StreamParameter, StreamTarget,
    close_stream as close_performance_stream, collection_interval_ms, counter_metric,
    create_stream_descriptor, definition as metric_definition, gauge_metric, histogram_metric,
    open_stream as open_performance_stream, record_batch as record_performance_batch, unix_time_ms,
};

/// SFTP 性能流使用的远程连接与业务任务身份。
#[derive(Clone, Copy)]
pub(crate) struct SftpConnectionIdentity<'a> {
    pub(crate) session_id: &'a str,
    #[cfg_attr(not(feature = "performance-telemetry"), allow(dead_code))]
    pub(crate) target_host: &'a str,
    #[cfg_attr(not(feature = "performance-telemetry"), allow(dead_code))]
    pub(crate) target_port: u16,
    pub(crate) transfer_id: &'a str,
}

/// SFTP 传输日志上下文。
struct TransferLogContext<'a> {
    session_id: &'a str,
    elapsed_ms: u128,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
}

/// SFTP 业务日志事件；枚举保证事件名和级别均为编译期固定值。
#[derive(Clone, Copy)]
enum SftpLogEvent {
    UploadSucceeded,
    UploadFailed,
    UploadPathsSucceeded,
    UploadPathsFailed,
    UploadPathsCancelled,
    DownloadSucceeded,
    DownloadFailed,
    DownloadDirectorySucceeded,
    DownloadDirectoryFailed,
    ListFailed,
    RenameFailed,
    RemoveFailed,
    MkdirFailed,
    ResolvePathFailed,
}

impl SftpLogEvent {
    /// 按事件目录约定写入固定事件名和级别。
    fn record(self, fields: Value) {
        match self {
            Self::UploadSucceeded => {
                log_event!(LogLevel::Info, "sftp.upload.succeeded", None, fields)
            }
            Self::UploadFailed => log_event!(LogLevel::Warn, "sftp.upload.failed", None, fields),
            Self::UploadPathsSucceeded => {
                log_event!(LogLevel::Info, "sftp.upload.paths.succeeded", None, fields)
            }
            Self::UploadPathsFailed => {
                log_event!(LogLevel::Warn, "sftp.upload.paths.failed", None, fields)
            }
            Self::UploadPathsCancelled => {
                log_event!(LogLevel::Info, "sftp.upload.paths.cancelled", None, fields)
            }
            Self::DownloadSucceeded => {
                log_event!(LogLevel::Info, "sftp.download.succeeded", None, fields)
            }
            Self::DownloadFailed => {
                log_event!(LogLevel::Warn, "sftp.download.failed", None, fields)
            }
            Self::DownloadDirectorySucceeded => {
                log_event!(LogLevel::Info, "sftp.download.dir.succeeded", None, fields)
            }
            Self::DownloadDirectoryFailed => {
                log_event!(LogLevel::Warn, "sftp.download.dir.failed", None, fields)
            }
            Self::ListFailed => log_event!(LogLevel::Warn, "sftp.list.failed", None, fields),
            Self::RenameFailed => log_event!(LogLevel::Warn, "sftp.rename.failed", None, fields),
            Self::RemoveFailed => log_event!(LogLevel::Warn, "sftp.remove.failed", None, fields),
            Self::MkdirFailed => log_event!(LogLevel::Warn, "sftp.mkdir.failed", None, fields),
            Self::ResolvePathFailed => {
                log_event!(LogLevel::Warn, "sftp.resolve.path.failed", None, fields)
            }
        }
    }
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

/// 一次文件面板上传任务的业务类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadJobKind {
    File,
    Directory,
    Batch,
}

impl UploadJobKind {
    /// 转换为进度事件使用的任务类型。
    const fn transfer_kind(self) -> SftpTransferKind {
        match self {
            Self::File => SftpTransferKind::File,
            Self::Directory => SftpTransferKind::Directory,
            Self::Batch => SftpTransferKind::Batch,
        }
    }

    /// 返回该任务实际启动的文件 worker 数。
    const fn worker_count(self) -> usize {
        match self {
            Self::File => 1,
            Self::Directory | Self::Batch => BATCH_WORKER_COUNT,
        }
    }

    /// 转换为性能遥测使用的流类型。
    #[cfg(feature = "performance-telemetry")]
    const fn stream_kind(self) -> StreamKind {
        match self {
            Self::File => StreamKind::SftpUploadFile,
            Self::Directory => StreamKind::SftpUploadDirectory,
            Self::Batch => StreamKind::SftpUploadBatch,
        }
    }
}

/// 目录下载流水线任务。
enum DownloadPipelineTask {
    CreateLocalDir {
        local_path: PathBuf,
    },
    DownloadFile {
        remote_path: String,
        local_path: PathBuf,
        display_name: String,
    },
}

/// 窗口化下载中的一次远端读结果。
struct DownloadReadChunk {
    offset: u64,
    requested_len: u32,
    data: Vec<u8>,
}

/// 记录短读后需要继续补读的远端区间。
#[derive(Debug, PartialEq, Eq)]
struct DownloadReadFollowUp {
    offset: u64,
    len: u32,
}

/// 文件流水线向任务级进度与遥测聚合器报告的事件。
enum FilePipelineEvent {
    /// 已经成功写入目标的文件级累计字节。
    Progress(u64),
    /// 一个原始 SFTP 请求已进入在途状态。
    #[cfg(feature = "performance-telemetry")]
    RequestStarted,
    /// 一个原始 SFTP 请求完成。
    #[cfg(feature = "performance-telemetry")]
    RequestFinished { duration_ms: f64 },
    /// 一组未正常返回的请求已被终止。
    #[cfg(feature = "performance-telemetry")]
    RequestsDiscarded(usize),
    /// 乱序待写队列新增分块。
    #[cfg(feature = "performance-telemetry")]
    PendingChunksAdded(usize),
    /// 乱序待写队列移除分块。
    #[cfg(feature = "performance-telemetry")]
    PendingChunksRemoved(usize),
}

/// 批量传输进度聚合状态。
struct PipelineProgressState {
    transferred: u64,
    total_bytes: Option<u64>,
    completed_items: u64,
    total_items: u64,
    failed_items: u64,
    status: SftpTransferStatus,
    #[cfg(feature = "performance-telemetry")]
    telemetry: Option<SftpPerformanceStream>,
}

impl Clone for PipelineProgressState {
    fn clone(&self) -> Self {
        Self {
            transferred: self.transferred,
            total_bytes: self.total_bytes,
            completed_items: self.completed_items,
            total_items: self.total_items,
            failed_items: self.failed_items,
            status: self.status,
            #[cfg(feature = "performance-telemetry")]
            telemetry: None,
        }
    }
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
/// 服务端未声明写入限制时使用的兼容分块大小。
///
/// ARM 麒麟系统随附的 OpenSSH（Ubuntu-4kylin3k0.8）未声明
/// `limits@openssh.com`；若直接发送 256 KiB 数据，`SSH_FXP_WRITE`
/// 加上协议字段后会超过服务端 256 KiB 消息上限，导致服务端记录
/// `bad message` 并关闭 SFTP 会话。
const DEFAULT_UPLOAD_CHUNK_SIZE: usize = 128 * 1024;
/// 服务端明确允许时使用的最大上传分块大小。
const MAX_UPLOAD_CHUNK_SIZE: usize = 256 * 1024;
/// 单文件下载分块并发读窗口。
const DOWNLOAD_READ_WINDOW: usize = 8;

/// 单次 SFTP 传输的本地窗口累加器。
///
/// 禁用时不创建该对象；启用后只在现有进度更新点累加数字，每个配置窗口提交一次。
#[cfg(feature = "performance-telemetry")]
struct SftpPerformanceStream {
    descriptor: StreamDescriptor,
    interval: Duration,
    started_at: Instant,
    window_started_at: Instant,
    window_started_unix_ms: u64,
    window_bytes: u64,
    window_requests: u64,
    current_in_flight: u64,
    current_pending_chunks: u64,
    max_in_flight: u64,
    max_pending_chunks: u64,
    request_durations: HistogramAccumulator,
    scan_duration_ms: Option<f64>,
    closed: bool,
}

#[cfg(feature = "performance-telemetry")]
impl SftpPerformanceStream {
    /// 尝试打开匿名 SFTP 性能流。
    fn open(
        kind: StreamKind,
        identity: &SftpConnectionIdentity<'_>,
        chunk_size: u64,
        request_window: u64,
        worker_count: u64,
    ) -> Option<Self> {
        let interval_ms = collection_interval_ms(PerformanceDomain::Sftp)?;
        let descriptor = create_stream_descriptor(
            kind,
            unix_time_ms(),
            BTreeMap::from([
                (
                    "chunkSizeBytes".into(),
                    StreamParameter::Unsigned(chunk_size),
                ),
                (
                    "requestWindow".into(),
                    StreamParameter::Unsigned(request_window),
                ),
                (
                    "workerCount".into(),
                    StreamParameter::Unsigned(worker_count),
                ),
            ]),
            StreamTarget {
                host: identity.target_host.to_string(),
                port: identity.target_port,
            },
            StreamCorrelation {
                session_id: identity.session_id.to_string(),
                transfer_id: Some(identity.transfer_id.to_string()),
            },
        );
        if open_performance_stream(descriptor.clone()) != RecordOutcome::Accepted {
            return None;
        }
        Some(Self {
            descriptor,
            interval: Duration::from_millis(interval_ms),
            started_at: Instant::now(),
            window_started_at: Instant::now(),
            window_started_unix_ms: unix_time_ms(),
            window_bytes: 0,
            window_requests: 0,
            current_in_flight: 0,
            current_pending_chunks: 0,
            max_in_flight: 0,
            max_pending_chunks: 0,
            request_durations: HistogramAccumulator::new(
                metric_definition("fluxterm.sftp.request.duration")
                    .expect("SFTP request duration metric must exist")
                    .histogram_bounds,
            ),
            scan_duration_ms: None,
            closed: false,
        })
    }

    /// 记录批量任务扫描阶段耗时。
    fn record_scan_duration(&mut self, duration: Duration) {
        self.scan_duration_ms = Some(duration.as_secs_f64() * 1000.0);
    }

    /// 累加已经成功写入目标的传输字节。
    fn observe_bytes(&mut self, bytes: u64) {
        self.window_bytes = self.window_bytes.saturating_add(bytes);
        self.flush_window(false);
    }

    /// 记录一个原始 SFTP 请求进入在途状态。
    fn request_started(&mut self) {
        self.current_in_flight = self.current_in_flight.saturating_add(1);
        self.max_in_flight = self.max_in_flight.max(self.current_in_flight);
    }

    /// 记录一个原始 SFTP 请求完成及其真实耗时。
    fn request_finished(&mut self, duration_ms: f64) {
        self.current_in_flight = self.current_in_flight.saturating_sub(1);
        self.window_requests = self.window_requests.saturating_add(1);
        self.request_durations.record(duration_ms);
        self.flush_window(false);
    }

    /// 回收未正常返回的在途请求。
    fn requests_discarded(&mut self, count: usize) {
        self.current_in_flight = self.current_in_flight.saturating_sub(count as u64);
    }

    /// 更新乱序待写分块的任务级当前值与高水位。
    fn pending_chunks_added(&mut self, count: usize) {
        self.current_pending_chunks = self.current_pending_chunks.saturating_add(count as u64);
        self.max_pending_chunks = self.max_pending_chunks.max(self.current_pending_chunks);
    }

    /// 回收已经写入或丢弃的待写分块。
    fn pending_chunks_removed(&mut self, count: usize) {
        self.current_pending_chunks = self.current_pending_chunks.saturating_sub(count as u64);
    }

    /// 发送当前聚合窗口。
    fn flush_window(&mut self, force: bool) {
        let elapsed = self.window_started_at.elapsed();
        if !force && elapsed < self.interval {
            return;
        }
        if self.window_bytes == 0 && self.window_requests == 0 && !force {
            return;
        }
        let duration_ms = u64::try_from(elapsed.as_millis())
            .unwrap_or(u64::MAX)
            .max(1);
        let throughput = self.window_bytes as f64 * 1000.0 / duration_ms as f64;
        let bytes = counter_metric(
            "fluxterm.sftp.transfer.bytes",
            MetricUnit::Byte,
            self.window_bytes as f64,
        );
        let throughput_point = gauge_metric(
            "fluxterm.sftp.transfer.throughput",
            MetricUnit::BytePerSecond,
            throughput,
        );
        let requests = counter_metric(
            "fluxterm.sftp.request.count",
            MetricUnit::Request,
            self.window_requests as f64,
        );
        let in_flight = gauge_metric(
            "fluxterm.sftp.request.in_flight.max",
            MetricUnit::Request,
            self.max_in_flight as f64,
        );
        let mut metrics = vec![bytes, throughput_point, requests, in_flight];
        if let Some(histogram) = self.request_durations.take() {
            metrics.push(histogram_metric(
                "fluxterm.sftp.request.duration",
                MetricUnit::Millisecond,
                histogram,
            ));
        }
        if self.max_pending_chunks > 0 {
            let pending = gauge_metric(
                "fluxterm.sftp.download.pending_chunks.max",
                MetricUnit::Chunk,
                self.max_pending_chunks as f64,
            );
            metrics.push(pending);
        }
        let _ = record_performance_batch(MetricBatch {
            stream_id: self.descriptor.id.clone(),
            window: MetricWindow {
                started_at_unix_ms: self.window_started_unix_ms,
                duration_ms,
            },
            metrics,
        });
        self.window_started_at = Instant::now();
        self.window_started_unix_ms = unix_time_ms();
        self.window_bytes = 0;
        self.window_requests = 0;
        self.max_in_flight = self.current_in_flight;
        self.max_pending_chunks = self.current_pending_chunks;
    }

    /// 提交最终摘要并关闭流。
    fn finish(
        &mut self,
        outcome: StreamOutcome,
        total_bytes: u64,
        completed_items: u64,
        failed_items: u64,
    ) {
        if self.closed {
            return;
        }
        self.flush_window(true);
        let elapsed_ms = self.started_at.elapsed().as_secs_f64() * 1000.0;
        let mut duration_histogram = HistogramAccumulator::new(
            metric_definition("fluxterm.sftp.transfer.duration")
                .expect("registered SFTP duration metric")
                .histogram_bounds,
        );
        duration_histogram.record(elapsed_ms);
        let mut metrics = Vec::new();
        if let Some(value) = duration_histogram.take() {
            metrics.push(histogram_metric(
                "fluxterm.sftp.transfer.duration",
                MetricUnit::Millisecond,
                value,
            ));
        }
        let size = gauge_metric(
            "fluxterm.sftp.transfer.size",
            MetricUnit::Byte,
            total_bytes as f64,
        );
        metrics.push(size);
        let average = if elapsed_ms > 0.0 {
            total_bytes as f64 * 1000.0 / elapsed_ms
        } else {
            0.0
        };
        let average_point = gauge_metric(
            "fluxterm.sftp.transfer.average_throughput",
            MetricUnit::BytePerSecond,
            average,
        );
        metrics.push(average_point);
        if completed_items > 0 {
            let completed = counter_metric(
                "fluxterm.sftp.item.completed",
                MetricUnit::Item,
                completed_items as f64,
            );
            metrics.push(completed);
        }
        if failed_items > 0 {
            let failed = counter_metric(
                "fluxterm.sftp.item.failed",
                MetricUnit::Item,
                failed_items as f64,
            );
            metrics.push(failed);
        }
        if let Some(scan_duration_ms) = self.scan_duration_ms {
            let mut scan_histogram = HistogramAccumulator::new(
                metric_definition("fluxterm.sftp.scan.duration")
                    .expect("registered SFTP scan duration metric")
                    .histogram_bounds,
            );
            scan_histogram.record(scan_duration_ms);
            if let Some(value) = scan_histogram.take() {
                metrics.push(histogram_metric(
                    "fluxterm.sftp.scan.duration",
                    MetricUnit::Millisecond,
                    value,
                ));
            }
        }
        let _ = record_performance_batch(MetricBatch {
            stream_id: self.descriptor.id.clone(),
            window: MetricWindow {
                started_at_unix_ms: self.descriptor.started_at_unix_ms,
                duration_ms: elapsed_ms.max(1.0) as u64,
            },
            metrics,
        });
        let _ = close_performance_stream(&self.descriptor.id, outcome, unix_time_ms());
        self.closed = true;
    }
}

#[cfg(feature = "performance-telemetry")]
impl Drop for SftpPerformanceStream {
    fn drop(&mut self) {
        if !self.closed {
            self.flush_window(true);
            let _ = close_performance_stream(
                &self.descriptor.id,
                StreamOutcome::Failed,
                unix_time_ms(),
            );
            self.closed = true;
        }
    }
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

/// 生成 SFTP 传输任务标识。
///
/// 该标识会跨 session 主循环与具体传输任务共享，用于进度归集和取消定位。
pub(crate) fn next_transfer_id() -> String {
    format!("sftp-{}", Uuid::new_v4())
}

/// 构造统一的“用户主动取消”错误。
fn transfer_cancelled_error() -> EngineError {
    EngineError::new("sftp_transfer_cancelled", "Transfer cancelled")
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

/// 生成批量上传任务的初始展示名称。
///
/// 单根上传使用真实文件或目录名，避免扫描完成前把内部 `items` 占位符暴露给界面；
/// 多根上传仍使用聚合占位名称，随后由扫描进度中的条目总数接管展示。
fn upload_roots_display_name(roots: &[PathBuf]) -> String {
    if roots.len() == 1
        && let Some(name) = roots[0].file_name()
    {
        let display_name = name.to_string_lossy();
        if !display_name.trim().is_empty() {
            return display_name.into_owned();
        }
    }
    items_label(None)
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
    let started = Instant::now();
    log_event!(LogLevel::Debug, "sftp.list.started", None, json!({}),);
    let sftp = open_sftp(session).await?;
    let entries = sftp.read_dir(path.to_string()).await.map_err(|err| {
        let err = EngineError::with_detail(
            SFTP_LIST_FAILED_CODE,
            "Failed to read the directory",
            err.to_string(),
        );
        log_sftp_path_failure(
            SftpLogEvent::ListFailed,
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
    log_event!(
        LogLevel::Debug,
        "sftp.list.succeeded",
        None,
        json!({
            "durationMs": started.elapsed().as_millis(),
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
        .ok_or_else(|| {
            EngineError::new(
                SFTP_STAT_FAILED_CODE,
                "Unable to determine the remote path name",
            )
            .with_message_key("sftp.remoteEdit.remoteMissing")
        })?;
    let entries = sftp_list(session, &parent).await?;
    entries
        .into_iter()
        .find(|entry| entry.path == normalized || entry.name == file_name)
        .ok_or_else(|| {
            EngineError::new(
                SFTP_STAT_FAILED_CODE,
                "The remote file does not exist or is inaccessible",
            )
            .with_message_key("sftp.remoteEdit.remoteMissing")
        })
}

/// 上传本地文件至远端。
pub(crate) async fn sftp_upload(
    session: &client::Handle<super::session::ClientHandler>,
    identity: SftpConnectionIdentity<'_>,
    local_path: &str,
    remote_path: &str,
    cancel_flag: &AtomicBool,
    on_event: &EventCallback,
) -> Result<(), EngineError> {
    let SftpConnectionIdentity {
        session_id,
        transfer_id,
        ..
    } = identity;
    let started = Instant::now();
    let display_name = file_name_from_path(local_path);
    let item_label = items_label(Some(1));
    let (sftp, limits) = open_raw_sftp(session).await?;
    let mut local = tokio::fs::File::open(local_path).await.map_err(|err| {
        EngineError::with_detail(
            SFTP_UPLOAD_FAILED_CODE,
            "Failed to read the local file",
            err.to_string(),
        )
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
    };
    emit_transfer_progress(on_event, progress_context, 0);
    log_event!(
        LogLevel::Debug,
        "sftp.upload.started",
        None,
        json!({
            "sessionId": session_id,
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
            EngineError::with_detail(
                SFTP_UPLOAD_FAILED_CODE,
                "Failed to create the remote file",
                err.to_string(),
            )
        })?;
    let handle_id = handle.handle.clone();
    let chunk_size = upload_chunk_size(limits.write_limit);
    #[cfg(feature = "performance-telemetry")]
    let mut performance = SftpPerformanceStream::open(
        StreamKind::SftpUploadFile,
        &identity,
        chunk_size as u64,
        UPLOAD_WRITE_WINDOW as u64,
        1,
    );
    let mut buf = vec![0u8; chunk_size];
    let mut offset = 0u64;
    let mut transferred = 0u64;
    let mut in_flight: JoinSet<Result<(usize, f64), EngineError>> = JoinSet::new();
    let max_in_flight = UPLOAD_WRITE_WINDOW;

    loop {
        if is_transfer_cancelled(cancel_flag) {
            #[cfg(feature = "performance-telemetry")]
            if let Some(performance) = performance.as_mut() {
                performance.requests_discarded(in_flight.len());
            }
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            let _ = sftp.close_session();
            emit_cancelled_progress(on_event, progress_context, transferred);
            #[cfg(feature = "performance-telemetry")]
            if let Some(performance) = performance.as_mut() {
                performance.finish(StreamOutcome::Cancelled, transferred, 0, 0);
            }
            return Ok(());
        }
        let n = local.read(&mut buf).await.map_err(|err| {
            EngineError::with_detail(
                SFTP_TRANSFER_FAILED_CODE,
                "Failed to read file data",
                err.to_string(),
            )
        })?;
        if n == 0 {
            break;
        }
        while in_flight.len() >= max_in_flight {
            if let Some(result) = in_flight.join_next().await {
                match result {
                    Ok(Ok(result)) => {
                        #[cfg(feature = "performance-telemetry")]
                        let (len, request_duration_ms) = result;
                        #[cfg(not(feature = "performance-telemetry"))]
                        let (len, _) = result;
                        transferred += len as u64;
                        #[cfg(feature = "performance-telemetry")]
                        if let Some(performance) = performance.as_mut() {
                            performance.request_finished(request_duration_ms);
                            performance.observe_bytes(len as u64);
                        }
                        emit_transfer_progress(on_event, progress_context, transferred);
                    }
                    Ok(Err(err)) => {
                        #[cfg(feature = "performance-telemetry")]
                        if let Some(performance) = performance.as_mut() {
                            performance.requests_discarded(in_flight.len() + 1);
                        }
                        log_sftp_failure(
                            SftpLogEvent::UploadFailed,
                            &TransferLogContext {
                                session_id,
                                elapsed_ms: started.elapsed().as_millis(),
                                transferred_bytes: transferred,
                                total_bytes: total,
                            },
                            &err,
                        );
                        in_flight.abort_all();
                        let _ = sftp.close(handle_id.clone()).await;
                        let _ = sftp.close_session();
                        #[cfg(feature = "performance-telemetry")]
                        if let Some(performance) = performance.as_mut() {
                            performance.finish(StreamOutcome::Failed, transferred, 0, 1);
                        }
                        return Err(err);
                    }
                    Err(err) => {
                        #[cfg(feature = "performance-telemetry")]
                        if let Some(performance) = performance.as_mut() {
                            performance.requests_discarded(in_flight.len() + 1);
                        }
                        let err = EngineError::with_detail(
                            SFTP_TRANSFER_FAILED_CODE,
                            "Failed to write file data",
                            err.to_string(),
                        );
                        log_sftp_failure(
                            SftpLogEvent::UploadFailed,
                            &TransferLogContext {
                                session_id,
                                elapsed_ms: started.elapsed().as_millis(),
                                transferred_bytes: transferred,
                                total_bytes: total,
                            },
                            &err,
                        );
                        in_flight.abort_all();
                        let _ = sftp.close(handle_id.clone()).await;
                        let _ = sftp.close_session();
                        #[cfg(feature = "performance-telemetry")]
                        if let Some(performance) = performance.as_mut() {
                            performance.finish(StreamOutcome::Failed, transferred, 0, 1);
                        }
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
            #[cfg(feature = "performance-telemetry")]
            let request_started = Instant::now();
            session
                .write(handle, write_offset, data)
                .await
                .map(|_| {
                    #[cfg(feature = "performance-telemetry")]
                    {
                        (n, request_started.elapsed().as_secs_f64() * 1000.0)
                    }
                    #[cfg(not(feature = "performance-telemetry"))]
                    {
                        (n, 0.0)
                    }
                })
                .map_err(|err| {
                    EngineError::with_detail(
                        SFTP_TRANSFER_FAILED_CODE,
                        "Failed to write file data",
                        err.to_string(),
                    )
                })
        });
        #[cfg(feature = "performance-telemetry")]
        if let Some(performance) = performance.as_mut() {
            performance.request_started();
        }
        offset += n as u64;
    }

    while let Some(result) = in_flight.join_next().await {
        if is_transfer_cancelled(cancel_flag) {
            #[cfg(feature = "performance-telemetry")]
            if let Some(performance) = performance.as_mut() {
                performance.requests_discarded(in_flight.len() + 1);
            }
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            let _ = sftp.close_session();
            emit_cancelled_progress(on_event, progress_context, transferred);
            #[cfg(feature = "performance-telemetry")]
            if let Some(performance) = performance.as_mut() {
                performance.finish(StreamOutcome::Cancelled, transferred, 0, 0);
            }
            return Ok(());
        }
        match result {
            Ok(Ok(result)) => {
                #[cfg(feature = "performance-telemetry")]
                let (len, request_duration_ms) = result;
                #[cfg(not(feature = "performance-telemetry"))]
                let (len, _) = result;
                transferred += len as u64;
                #[cfg(feature = "performance-telemetry")]
                if let Some(performance) = performance.as_mut() {
                    performance.request_finished(request_duration_ms);
                    performance.observe_bytes(len as u64);
                }
                emit_transfer_progress(on_event, progress_context, transferred);
            }
            Ok(Err(err)) => {
                #[cfg(feature = "performance-telemetry")]
                if let Some(performance) = performance.as_mut() {
                    performance.requests_discarded(in_flight.len() + 1);
                }
                log_sftp_failure(
                    SftpLogEvent::UploadFailed,
                    &TransferLogContext {
                        session_id,
                        elapsed_ms: started.elapsed().as_millis(),
                        transferred_bytes: transferred,
                        total_bytes: total,
                    },
                    &err,
                );
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                let _ = sftp.close_session();
                #[cfg(feature = "performance-telemetry")]
                if let Some(performance) = performance.as_mut() {
                    performance.finish(StreamOutcome::Failed, transferred, 0, 1);
                }
                return Err(err);
            }
            Err(err) => {
                #[cfg(feature = "performance-telemetry")]
                if let Some(performance) = performance.as_mut() {
                    performance.requests_discarded(in_flight.len() + 1);
                }
                let err = EngineError::with_detail(
                    SFTP_TRANSFER_FAILED_CODE,
                    "Failed to write file data",
                    err.to_string(),
                );
                log_sftp_failure(
                    SftpLogEvent::UploadFailed,
                    &TransferLogContext {
                        session_id,
                        elapsed_ms: started.elapsed().as_millis(),
                        transferred_bytes: transferred,
                        total_bytes: total,
                    },
                    &err,
                );
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                let _ = sftp.close_session();
                #[cfg(feature = "performance-telemetry")]
                if let Some(performance) = performance.as_mut() {
                    performance.finish(StreamOutcome::Failed, transferred, 0, 1);
                }
                return Err(err);
            }
        }
    }

    sftp.close(handle_id).await.map_err(|err| {
        EngineError::with_detail(
            SFTP_UPLOAD_FAILED_CODE,
            "Failed to close the remote file",
            err.to_string(),
        )
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
        SftpLogEvent::UploadSucceeded,
        &TransferLogContext {
            session_id,
            elapsed_ms: started.elapsed().as_millis(),
            transferred_bytes: transferred,
            total_bytes: total,
        },
    );
    #[cfg(feature = "performance-telemetry")]
    if let Some(performance) = performance.as_mut() {
        performance.finish(StreamOutcome::Succeeded, transferred, 1, 0);
    }
    Ok(())
}

/// 校验上传根路径并根据实际输入确定任务类型。
fn classify_upload_roots(roots: &[PathBuf]) -> Result<UploadJobKind, EngineError> {
    let mut single_kind = None;
    for root in roots {
        let metadata = fs::symlink_metadata(root).map_err(|err| {
            EngineError::with_detail(
                SFTP_UPLOAD_FAILED_CODE,
                "Failed to read local upload path metadata",
                err.to_string(),
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(EngineError::new(
                SFTP_UPLOAD_FAILED_CODE,
                "Uploading symbolic links is not supported",
            ));
        }
        let kind = if metadata.is_file() {
            UploadJobKind::File
        } else if metadata.is_dir() {
            UploadJobKind::Directory
        } else {
            return Err(EngineError::new(
                SFTP_UPLOAD_FAILED_CODE,
                "Uploading this entry type is not supported",
            ));
        };
        single_kind = Some(kind);
    }
    if roots.len() > 1 {
        Ok(UploadJobKind::Batch)
    } else {
        single_kind.ok_or_else(|| {
            EngineError::new(
                SFTP_UPLOAD_FAILED_CODE,
                "No local paths were provided for upload",
            )
        })
    }
}

/// 上传一组本地文件或目录到远端目录。
pub(crate) async fn sftp_upload_paths(
    session: &client::Handle<super::session::ClientHandler>,
    identity: SftpConnectionIdentity<'_>,
    local_paths: &[String],
    remote_dir: &str,
    cancel_flag: &AtomicBool,
    on_event: &EventCallback,
) -> Result<(), EngineError> {
    let SftpConnectionIdentity {
        session_id,
        transfer_id,
        ..
    } = identity;
    let started = Instant::now();
    let local_roots: Vec<PathBuf> = local_paths
        .iter()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    if local_roots.is_empty() {
        return Err(EngineError::new(
            SFTP_UPLOAD_FAILED_CODE,
            "No local paths were provided for upload",
        ));
    }
    let upload_kind = classify_upload_roots(&local_roots)?;
    let worker_count = upload_kind.worker_count();

    let state = Arc::new(Mutex::new(PipelineProgressState {
        transferred: 0,
        total_bytes: Some(0),
        completed_items: 0,
        total_items: 0,
        failed_items: 0,
        status: SftpTransferStatus::Running,
        #[cfg(feature = "performance-telemetry")]
        telemetry: SftpPerformanceStream::open(
            upload_kind.stream_kind(),
            &identity,
            upload_chunk_size(None) as u64,
            (UPLOAD_WRITE_WINDOW * worker_count) as u64,
            worker_count as u64,
        ),
    }));
    let emit_context = PipelineEmitContext {
        session_id: session_id.to_string(),
        transfer_id: transfer_id.to_string(),
        op: SftpProgressOp::Upload,
        kind: upload_kind.transfer_kind(),
        path: remote_dir.to_string(),
        display_name: upload_roots_display_name(&local_roots),
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
    log_event!(
        LogLevel::Debug,
        "sftp.upload.paths.started",
        None,
        json!({
            "sessionId": session_id,
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
    for _ in 0..worker_count {
        workers.push(upload_pipeline_worker(
            session,
            Arc::clone(&task_rx),
            Arc::clone(&remote_dir_cache),
            Arc::clone(&state),
            emit_context.clone(),
            cancel_flag,
        ));
    }

    #[cfg(feature = "performance-telemetry")]
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
            log_event!(
                LogLevel::Warn,
                "sftp.upload.paths.stream.failed",
                None,
                json!({
                    "error": {
                        "code": err.code,
                        "message": err.message,
                        "detail": err.details,
                    }
                }),
            );
            pipeline_discover_failed_item(&state, &emit_context);
        }
    }
    #[cfg(feature = "performance-telemetry")]
    {
        if let Some(telemetry) = state
            .lock()
            .expect("pipeline progress mutex poisoned")
            .telemetry
            .as_mut()
        {
            telemetry.record_scan_duration(scan_started.elapsed());
        }
    }
    drop(task_tx);
    let mut worker_failed = false;
    while let Some(result) = workers.next().await {
        match result {
            Ok(()) => {}
            Err(err) => {
                worker_failed = true;
                log_event!(
                    LogLevel::Warn,
                    "sftp.upload.paths.worker.failed",
                    None,
                    json!({
                        "error": {
                            "code": err.code,
                            "message": err.message,
                            "detail": err.details,
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
            SftpLogEvent::UploadPathsCancelled,
            &TransferLogContext {
                session_id,
                elapsed_ms: started.elapsed().as_millis(),
                transferred_bytes: snapshot.transferred,
                total_bytes: snapshot.total_bytes,
            },
        );
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
                SftpLogEvent::UploadPathsSucceeded,
                &TransferLogContext {
                    session_id,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: snapshot.transferred,
                    total_bytes: snapshot.total_bytes,
                },
            );
            Ok(())
        }
        _ => {
            let err = EngineError::new(SFTP_UPLOAD_FAILED_CODE, "Upload paths task failed");
            log_sftp_failure(
                SftpLogEvent::UploadPathsFailed,
                &TransferLogContext {
                    session_id,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: snapshot.transferred,
                    total_bytes: snapshot.total_bytes,
                },
                &err,
            );
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
    mut on_event: impl FnMut(FilePipelineEvent),
) -> Result<u64, EngineError> {
    let mut local = tokio::fs::File::open(local_path).await.map_err(|err| {
        EngineError::with_detail(
            SFTP_UPLOAD_FAILED_CODE,
            "Failed to read the local file",
            err.to_string(),
        )
    })?;
    let handle = sftp
        .open(
            remote_path.to_string(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            FileAttributes::empty(),
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                SFTP_UPLOAD_FAILED_CODE,
                "Failed to create the remote file",
                err.to_string(),
            )
        })?;
    let handle_id = handle.handle.clone();
    let chunk_size = upload_chunk_size(write_limit);
    let mut buf = vec![0u8; chunk_size];
    let mut offset = 0u64;
    let mut transferred = 0u64;
    let mut in_flight: JoinSet<Result<(usize, f64), EngineError>> = JoinSet::new();
    let max_in_flight = UPLOAD_WRITE_WINDOW;

    loop {
        if is_transfer_cancelled(cancel_flag) {
            #[cfg(feature = "performance-telemetry")]
            on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len()));
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            return Err(transfer_cancelled_error());
        }
        let n = local.read(&mut buf).await.map_err(|err| {
            EngineError::with_detail(
                SFTP_TRANSFER_FAILED_CODE,
                "Failed to read file data",
                err.to_string(),
            )
        })?;
        if n == 0 {
            break;
        }
        while in_flight.len() >= max_in_flight {
            match in_flight.join_next().await {
                Some(Ok(Ok(result))) => {
                    #[cfg(feature = "performance-telemetry")]
                    on_event(FilePipelineEvent::RequestFinished {
                        duration_ms: result.1,
                    });
                    let len = result.0;
                    transferred += len as u64;
                    on_event(FilePipelineEvent::Progress(transferred));
                }
                Some(Ok(Err(err))) => {
                    #[cfg(feature = "performance-telemetry")]
                    on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len() + 1));
                    in_flight.abort_all();
                    let _ = sftp.close(handle_id.clone()).await;
                    return Err(err);
                }
                Some(Err(err)) => {
                    #[cfg(feature = "performance-telemetry")]
                    on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len() + 1));
                    in_flight.abort_all();
                    let _ = sftp.close(handle_id.clone()).await;
                    return Err(EngineError::with_detail(
                        SFTP_TRANSFER_FAILED_CODE,
                        "Failed to write file data",
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
            #[cfg(feature = "performance-telemetry")]
            let request_started = Instant::now();
            session
                .write(handle, write_offset, data)
                .await
                .map(|_| {
                    #[cfg(feature = "performance-telemetry")]
                    {
                        (n, request_started.elapsed().as_secs_f64() * 1000.0)
                    }
                    #[cfg(not(feature = "performance-telemetry"))]
                    {
                        (n, 0.0)
                    }
                })
                .map_err(|err| {
                    EngineError::with_detail(
                        SFTP_TRANSFER_FAILED_CODE,
                        "Failed to write file data",
                        err.to_string(),
                    )
                })
        });
        #[cfg(feature = "performance-telemetry")]
        on_event(FilePipelineEvent::RequestStarted);
        offset += n as u64;
    }

    while let Some(result) = in_flight.join_next().await {
        if is_transfer_cancelled(cancel_flag) {
            #[cfg(feature = "performance-telemetry")]
            on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len() + 1));
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            return Err(transfer_cancelled_error());
        }
        match result {
            Ok(Ok(result)) => {
                #[cfg(feature = "performance-telemetry")]
                on_event(FilePipelineEvent::RequestFinished {
                    duration_ms: result.1,
                });
                let len = result.0;
                transferred += len as u64;
                on_event(FilePipelineEvent::Progress(transferred));
            }
            Ok(Err(err)) => {
                #[cfg(feature = "performance-telemetry")]
                on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len() + 1));
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                return Err(err);
            }
            Err(err) => {
                #[cfg(feature = "performance-telemetry")]
                on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len() + 1));
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                return Err(EngineError::with_detail(
                    SFTP_TRANSFER_FAILED_CODE,
                    "Failed to write file data",
                    err.to_string(),
                ));
            }
        }
    }

    sftp.close(handle_id).await.map_err(|err| {
        EngineError::with_detail(
            SFTP_UPLOAD_FAILED_CODE,
            "Failed to close the remote file",
            err.to_string(),
        )
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
                    SFTP_MKDIR_FAILED_CODE,
                    "Failed to create the directory",
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
            SFTP_UPLOAD_FAILED_CODE,
            "Failed to read local file metadata",
            err.to_string(),
        )
    })?;
    if metadata.file_type().is_symlink() {
        pipeline_discover_failed_item(state, emit_context);
        return Err(EngineError::new(
            SFTP_UPLOAD_FAILED_CODE,
            "Uploading symbolic links is not supported",
        ));
    }

    let root_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            EngineError::new(
                SFTP_UPLOAD_FAILED_CODE,
                "Unable to determine the upload root name",
            )
        })?
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
            EngineError::with_detail(
                SFTP_UPLOAD_FAILED_CODE,
                "Failed to schedule the upload task",
                err.to_string(),
            )
        })?;
        return Ok(());
    }

    if !metadata.is_dir() {
        pipeline_discover_failed_item(state, emit_context);
        return Err(EngineError::new(
            SFTP_UPLOAD_FAILED_CODE,
            "Uploading this entry type is not supported",
        ));
    }

    pipeline_discover_item(state, emit_context, Some(0));
    tx.send(UploadPipelineTask::CreateRemoteDir {
        remote_dir: remote_root.clone(),
        display_name: root_name.clone(),
    })
    .map_err(|err| {
        EngineError::with_detail(
            SFTP_UPLOAD_FAILED_CODE,
            "Failed to schedule the directory creation task",
            err.to_string(),
        )
    })?;

    let mut stack = vec![root.to_path_buf()];
    while let Some(current_dir) = stack.pop() {
        if is_transfer_cancelled(cancel_flag) {
            return Ok(());
        }
        for entry in fs::read_dir(&current_dir).map_err(|err| {
            EngineError::with_detail(
                SFTP_UPLOAD_FAILED_CODE,
                "Failed to read the local directory",
                err.to_string(),
            )
        })? {
            let entry = entry.map_err(|err| {
                EngineError::with_detail(
                    SFTP_UPLOAD_FAILED_CODE,
                    "Failed to read a local directory entry",
                    err.to_string(),
                )
            })?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|err| {
                EngineError::with_detail(
                    SFTP_UPLOAD_FAILED_CODE,
                    "Failed to read local file metadata",
                    err.to_string(),
                )
            })?;
            let relative = path
                .strip_prefix(root)
                .map_err(|err| {
                    EngineError::with_detail(
                        SFTP_UPLOAD_FAILED_CODE,
                        "Failed to calculate the local relative path",
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
                        SFTP_UPLOAD_FAILED_CODE,
                        "Failed to schedule the directory creation task",
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
                        SFTP_UPLOAD_FAILED_CODE,
                        "Failed to schedule the upload task",
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
            EngineError::with_detail(
                SFTP_LIST_FAILED_CODE,
                "Failed to read the directory",
                err.to_string(),
            )
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
                ctx.tx
                    .send(DownloadPipelineTask::CreateLocalDir {
                        local_path: next_local,
                    })
                    .map_err(|err| {
                        EngineError::with_detail(
                            SFTP_DOWNLOAD_FAILED_CODE,
                            "Failed to schedule the directory creation task",
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
                            SFTP_DOWNLOAD_FAILED_CODE,
                            "Failed to schedule the download task",
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
                    log_event!(
                        LogLevel::Warn,
                        "sftp.upload.paths.dir.failed",
                        None,
                        json!({
                            "error": {
                                "code": err.code,
                                "message": err.message,
                                "detail": err.details,
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
                    log_event!(
                        LogLevel::Warn,
                        "sftp.upload.paths.mkdir.parent.failed",
                        None,
                        json!({
                            "error": {
                                "code": err.code,
                                "message": err.message,
                                "detail": err.details,
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
                    |event| {
                        pipeline_handle_file_event(
                            &state,
                            &emit_context,
                            &display_name,
                            &mut last_transferred,
                            event,
                        );
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
                        log_event!(
                            LogLevel::Warn,
                            "sftp.upload.paths.file.failed",
                            None,
                            json!({
                                "error": {
                                    "code": err.code,
                                    "message": err.message,
                                    "detail": err.details,
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
            DownloadPipelineTask::CreateLocalDir { local_path } => {
                match tokio::fs::create_dir_all(&local_path).await {
                    Ok(()) => {}
                    Err(err) => {
                        pipeline_discover_failed_item(&state, &emit_context);
                        log_event!(
                            LogLevel::Warn,
                            "sftp.download.dir.mkdir.failed",
                            None,
                            json!({
                                "error": {
                                    "code": "sftp_download_dir_mkdir_failed",
                                    "message": "Failed to create the local directory",
                                    "detail": err.to_string(),
                                }
                            }),
                        );
                    }
                }
            }
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
                    |event| {
                        pipeline_handle_file_event(
                            &state,
                            &emit_context,
                            &display_name,
                            &mut last_transferred,
                            event,
                        );
                    },
                )
                .await
                {
                    Ok(_) => {
                        pipeline_complete_item(&state, &emit_context, &display_name);
                    }
                    Err(err) if err.code == "sftp_transfer_cancelled" => break,
                    Err(err) => {
                        let _ = tokio::fs::remove_file(&local_path).await;
                        pipeline_fail_item(&state, &emit_context, &display_name);
                        log_event!(
                            LogLevel::Warn,
                            "sftp.download.dir.file.failed",
                            None,
                            json!({
                                "error": {
                                    "code": err.code,
                                    "message": err.message,
                                    "detail": err.details,
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
        EngineError::with_detail(
            SFTP_REMOVE_FAILED_CODE,
            "Failed to remove the remote entry",
            err.to_string(),
        )
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
                    EngineError::with_detail(
                        SFTP_REMOVE_FAILED_CODE,
                        "Failed to remove the remote entry",
                        err.to_string(),
                    )
                })?;
            }
        }
    }
    sftp.remove_dir(path.to_string()).await.map_err(|err| {
        EngineError::with_detail(
            SFTP_REMOVE_FAILED_CODE,
            "Failed to remove the remote entry",
            err.to_string(),
        )
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
pub(crate) async fn sftp_download(
    session: &client::Handle<super::session::ClientHandler>,
    identity: SftpConnectionIdentity<'_>,
    remote_path: &str,
    local_path: &str,
    cancel_flag: &AtomicBool,
    on_event: &EventCallback,
) -> Result<(), EngineError> {
    let SftpConnectionIdentity {
        session_id,
        transfer_id,
        ..
    } = identity;
    let started = Instant::now();
    let display_name = file_name_from_path(remote_path);
    let item_label = items_label(Some(1));
    let (sftp, limits) = open_raw_sftp(session).await?;
    let total = sftp
        .stat(remote_path.to_string())
        .await
        .ok()
        .and_then(|attrs| attrs.attrs.size);
    log_event!(
        LogLevel::Debug,
        "sftp.download.started",
        None,
        json!({
            "sessionId": session_id,
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
    };
    emit_transfer_progress(on_event, progress_context, 0);
    #[cfg(feature = "performance-telemetry")]
    let chunk_size = download_chunk_size(limits.read_limit);
    #[cfg(feature = "performance-telemetry")]
    let mut performance = SftpPerformanceStream::open(
        StreamKind::SftpDownloadFile,
        &identity,
        chunk_size as u64,
        DOWNLOAD_READ_WINDOW as u64,
        1,
    );
    let mut transferred = 0u64;
    let result = download_remote_file_to_local_pipelined(
        &sftp,
        limits.read_limit,
        remote_path,
        &resolved_local_path,
        cancel_flag,
        |event| match event {
            FilePipelineEvent::Progress(file_transferred) => {
                #[cfg(feature = "performance-telemetry")]
                {
                    let delta = file_transferred.saturating_sub(transferred);
                    if let Some(performance) = performance.as_mut() {
                        performance.observe_bytes(delta);
                    }
                }
                transferred = file_transferred;
                emit_transfer_progress(on_event, progress_context, transferred);
            }
            #[cfg(feature = "performance-telemetry")]
            FilePipelineEvent::RequestStarted => {
                if let Some(performance) = performance.as_mut() {
                    performance.request_started();
                }
            }
            #[cfg(feature = "performance-telemetry")]
            FilePipelineEvent::RequestFinished { duration_ms } => {
                if let Some(performance) = performance.as_mut() {
                    performance.request_finished(duration_ms);
                }
            }
            #[cfg(feature = "performance-telemetry")]
            FilePipelineEvent::RequestsDiscarded(count) => {
                if let Some(performance) = performance.as_mut() {
                    performance.requests_discarded(count);
                }
            }
            #[cfg(feature = "performance-telemetry")]
            FilePipelineEvent::PendingChunksAdded(count) => {
                if let Some(performance) = performance.as_mut() {
                    performance.pending_chunks_added(count);
                }
            }
            #[cfg(feature = "performance-telemetry")]
            FilePipelineEvent::PendingChunksRemoved(count) => {
                if let Some(performance) = performance.as_mut() {
                    performance.pending_chunks_removed(count);
                }
            }
        },
    )
    .await;
    let _ = sftp.close_session();
    match result {
        Ok(_) => {
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
                SftpLogEvent::DownloadSucceeded,
                &TransferLogContext {
                    session_id,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: transferred,
                    total_bytes: total,
                },
            );
            #[cfg(feature = "performance-telemetry")]
            if let Some(performance) = performance.as_mut() {
                performance.finish(StreamOutcome::Succeeded, transferred, 1, 0);
            }
            Ok(())
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&resolved_local_path).await;
            if err.code == "sftp_transfer_cancelled" {
                emit_cancelled_progress(on_event, progress_context, transferred);
                #[cfg(feature = "performance-telemetry")]
                if let Some(performance) = performance.as_mut() {
                    performance.finish(StreamOutcome::Cancelled, transferred, 0, 0);
                }
                return Ok(());
            }
            emit_transfer_progress(
                on_event,
                TransferProgressContext {
                    failed_items: 1,
                    status: SftpTransferStatus::Failed,
                    ..progress_context
                },
                transferred,
            );
            log_sftp_failure(
                SftpLogEvent::DownloadFailed,
                &TransferLogContext {
                    session_id,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: transferred,
                    total_bytes: total,
                },
                &err,
            );
            #[cfg(feature = "performance-telemetry")]
            if let Some(performance) = performance.as_mut() {
                performance.finish(StreamOutcome::Failed, transferred, 0, 1);
            }
            Err(err)
        }
    }
}

/// 递归下载远端目录到本地目录。
///
/// 流程分为两阶段：
/// 1. 预扫描远端目录树，统计文件项与总字节数。
/// 2. 在本地创建同名根目录后，顺序创建子目录并顺序下载文件。
///
/// 第一版默认允许部分成功：
/// - 某个目录或文件失败时继续后续项
/// - 最终状态由 completed_items 与 failed_items 聚合判定
pub(crate) async fn sftp_download_dir(
    session: &client::Handle<super::session::ClientHandler>,
    identity: SftpConnectionIdentity<'_>,
    remote_path: &str,
    local_dir: &str,
    cancel_flag: &AtomicBool,
    on_event: &EventCallback,
) -> Result<(), EngineError> {
    let SftpConnectionIdentity {
        session_id,
        transfer_id,
        ..
    } = identity;
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
        #[cfg(feature = "performance-telemetry")]
        telemetry: SftpPerformanceStream::open(
            StreamKind::SftpDownloadDirectory,
            &identity,
            256 * 1024,
            (DOWNLOAD_READ_WINDOW * BATCH_WORKER_COUNT) as u64,
            BATCH_WORKER_COUNT as u64,
        ),
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
    log_event!(
        LogLevel::Debug,
        "sftp.download.dir.started",
        None,
        json!({
            "sessionId": session_id,
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

    if let Err(err) = task_tx.send(DownloadPipelineTask::CreateLocalDir {
        local_path: root_path.clone(),
    }) {
        return Err(EngineError::with_detail(
            SFTP_DOWNLOAD_FAILED_CODE,
            "Failed to schedule local directory creation",
            err.to_string(),
        ));
    }

    let scan_ctx = DownloadScanContext {
        sftp: &sftp,
        remote_root: remote_path.trim_end_matches('/'),
        local_root: &root_path,
        tx: &task_tx,
        state: &state,
        emit_context: &emit_context,
        cancel_flag,
    };
    #[cfg(feature = "performance-telemetry")]
    let scan_started = Instant::now();
    if let Err(err) = stream_remote_download_tasks(&scan_ctx, "").await {
        log_event!(
            LogLevel::Warn,
            "sftp.download.scan.failed",
            None,
            json!({
                "error": {
                    "code": err.code,
                    "message": err.message,
                    "detail": err.details,
                }
            }),
        );
        pipeline_discover_failed_item(&state, &emit_context);
    }
    #[cfg(feature = "performance-telemetry")]
    {
        if let Some(telemetry) = state
            .lock()
            .expect("pipeline progress mutex poisoned")
            .telemetry
            .as_mut()
        {
            telemetry.record_scan_duration(scan_started.elapsed());
        }
    }
    drop(task_tx);
    let mut worker_failed = false;
    while let Some(result) = workers.next().await {
        match result {
            Ok(()) => {}
            Err(err) => {
                worker_failed = true;
                log_event!(
                    LogLevel::Warn,
                    "sftp.download.worker.failed",
                    None,
                    json!({
                        "error": {
                            "code": err.code,
                            "message": err.message,
                            "detail": err.details,
                        }
                    }),
                );
            }
        }
    }

    if is_transfer_cancelled(cancel_flag) {
        finalize_pipeline_state(&state, &emit_context, SftpTransferStatus::Cancelled);
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
                SftpLogEvent::DownloadDirectorySucceeded,
                &TransferLogContext {
                    session_id,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: snapshot.transferred,
                    total_bytes: snapshot.total_bytes,
                },
            );
            Ok(())
        }
        _ => {
            let err = EngineError::new(SFTP_DOWNLOAD_FAILED_CODE, "Directory download failed");
            log_sftp_failure(
                SftpLogEvent::DownloadDirectoryFailed,
                &TransferLogContext {
                    session_id,
                    elapsed_ms: started.elapsed().as_millis(),
                    transferred_bytes: snapshot.transferred,
                    total_bytes: snapshot.total_bytes,
                },
                &err,
            );
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
    let started = Instant::now();
    log_event!(LogLevel::Debug, "sftp.rename.started", None, json!({}),);
    let sftp = open_sftp(session).await?;
    sftp.rename(from.to_string(), to.to_string())
        .await
        .map_err(|err| {
            let err = EngineError::with_detail(
                "sftp_rename_failed",
                "Failed to rename the remote entry",
                err.to_string(),
            );
            log_sftp_pair_failure(
                SftpLogEvent::RenameFailed,
                started.elapsed().as_millis(),
                &err,
            );
            err
        })?;
    log_event!(
        LogLevel::Debug,
        "sftp.rename.succeeded",
        None,
        json!({
            "durationMs": started.elapsed().as_millis(),
        }),
    );
    Ok(())
}

/// 删除远端文件。
pub async fn sftp_remove(
    session: &client::Handle<super::session::ClientHandler>,
    path: &str,
) -> Result<(), EngineError> {
    let started = Instant::now();
    log_event!(LogLevel::Debug, "sftp.remove.started", None, json!({}),);
    let sftp = open_sftp(session).await?;
    remove_remote_path_recursive(&sftp, path)
        .await
        .inspect_err(|err| {
            log_sftp_path_failure(
                SftpLogEvent::RemoveFailed,
                started.elapsed().as_millis(),
                err,
            );
        })?;
    log_event!(
        LogLevel::Debug,
        "sftp.remove.succeeded",
        None,
        json!({
            "durationMs": started.elapsed().as_millis(),
        }),
    );
    Ok(())
}

/// 创建远端目录。
pub async fn sftp_mkdir(
    session: &client::Handle<super::session::ClientHandler>,
    path: &str,
) -> Result<(), EngineError> {
    let started = Instant::now();
    log_event!(LogLevel::Debug, "sftp.mkdir.started", None, json!({}),);
    let sftp = open_sftp(session).await?;
    sftp.create_dir(path.to_string()).await.map_err(|err| {
        let err = EngineError::with_detail(
            SFTP_MKDIR_FAILED_CODE,
            "Failed to create the directory",
            err.to_string(),
        );
        log_sftp_path_failure(
            SftpLogEvent::MkdirFailed,
            started.elapsed().as_millis(),
            &err,
        );
        err
    })?;
    log_event!(
        LogLevel::Debug,
        "sftp.mkdir.succeeded",
        None,
        json!({
            "durationMs": started.elapsed().as_millis(),
        }),
    );
    Ok(())
}

/// 获取远端家目录路径。
pub async fn sftp_home(
    session: &client::Handle<super::session::ClientHandler>,
) -> Result<String, EngineError> {
    let started = Instant::now();
    log_event!(LogLevel::Debug, "sftp.home.started", None, json!({}),);
    let sftp = open_sftp(session).await?;
    let home = sftp.canonicalize(".").await.map_err(|err| {
        let err = EngineError::with_detail(
            "sftp_home_failed",
            "Failed to get the home directory",
            err.to_string(),
        );
        log_event!(
            LogLevel::Warn,
            "sftp.home.failed",
            None,
            json!({
                "durationMs": started.elapsed().as_millis(),
                "error": {
                    "code": err.code.clone(),
                    "message": err.message.clone(),
                    "detail": err.details.clone(),
                }
            }),
        );
        err
    })?;
    log_event!(
        LogLevel::Debug,
        "sftp.home.succeeded",
        None,
        json!({
            "durationMs": started.elapsed().as_millis(),
        }),
    );
    Ok(home)
}

/// 解析远端路径到真实路径。
pub async fn sftp_resolve_path(
    session: &client::Handle<super::session::ClientHandler>,
    path: &str,
) -> Result<String, EngineError> {
    let started = Instant::now();
    log_event!(
        LogLevel::Debug,
        "sftp.resolve.path.started",
        None,
        json!({}),
    );
    let sftp = open_sftp(session).await?;
    let resolved = sftp.canonicalize(path).await.map_err(|err| {
        let err = EngineError::with_detail(
            "sftp_resolve_path_failed",
            "Failed to resolve the remote path",
            err.to_string(),
        );
        log_sftp_path_failure(
            SftpLogEvent::ResolvePathFailed,
            started.elapsed().as_millis(),
            &err,
        );
        err
    })?;
    log_event!(
        LogLevel::Debug,
        "sftp.resolve.path.succeeded",
        None,
        json!({
            "durationMs": started.elapsed().as_millis(),
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
    mut on_event: impl FnMut(FilePipelineEvent),
) -> Result<u64, EngineError> {
    let handle = sftp
        .open(
            remote_path.to_string(),
            OpenFlags::READ,
            FileAttributes::empty(),
        )
        .await
        .map_err(|err| {
            EngineError::with_detail(
                SFTP_DOWNLOAD_FAILED_CODE,
                "Failed to open the remote file",
                err.to_string(),
            )
        })?;
    let handle_id = handle.handle.clone();
    let expected_size = sftp
        .fstat(handle_id.clone())
        .await
        .ok()
        .and_then(|attrs| attrs.attrs.size);
    let mut local = tokio::fs::File::create(local_path).await.map_err(|err| {
        EngineError::with_detail(
            SFTP_DOWNLOAD_FAILED_CODE,
            "Failed to create the local file",
            err.to_string(),
        )
    })?;
    let chunk_size = download_chunk_size(read_limit);
    let mut next_offset = 0u64;
    let mut expected_write_offset = 0u64;
    let mut transferred = 0u64;
    let mut eof_responses = 0u64;
    let mut eof = false;
    let mut in_flight: JoinSet<Result<(DownloadReadChunk, f64), EngineError>> = JoinSet::new();
    let mut pending_chunks = BTreeMap::<u64, Vec<u8>>::new();
    let window_size = DOWNLOAD_READ_WINDOW;
    let spawn_read = |in_flight: &mut JoinSet<Result<(DownloadReadChunk, f64), EngineError>>,
                      read_offset: u64,
                      read_len: u32| {
        let session = Arc::clone(sftp);
        let handle = handle_id.clone();
        in_flight.spawn(async move {
            #[cfg(feature = "performance-telemetry")]
            let request_started = Instant::now();
            let result = match session.read(handle, read_offset, read_len).await {
                Ok(data) => Ok(DownloadReadChunk {
                    offset: read_offset,
                    requested_len: read_len,
                    data: data.data.to_vec(),
                }),
                Err(SftpClientError::Status(status)) if status.status_code == StatusCode::Eof => {
                    Ok(DownloadReadChunk {
                        offset: read_offset,
                        requested_len: read_len,
                        data: Vec::new(),
                    })
                }
                Err(err) => Err(EngineError::with_detail(
                    SFTP_TRANSFER_FAILED_CODE,
                    "Unable to read file data",
                    err.to_string(),
                )),
            };
            result.map(|chunk| {
                #[cfg(feature = "performance-telemetry")]
                {
                    (chunk, request_started.elapsed().as_secs_f64() * 1000.0)
                }
                #[cfg(not(feature = "performance-telemetry"))]
                {
                    (chunk, 0.0)
                }
            })
        });
    };

    loop {
        if is_transfer_cancelled(cancel_flag) {
            #[cfg(feature = "performance-telemetry")]
            {
                on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len()));
                on_event(FilePipelineEvent::PendingChunksRemoved(
                    pending_chunks.len(),
                ));
            }
            in_flight.abort_all();
            let _ = sftp.close(handle_id.clone()).await;
            let _ = tokio::fs::remove_file(local_path).await;
            return Err(transfer_cancelled_error());
        }
        while !eof && in_flight.len() < window_size {
            let read_offset = next_offset;
            let read_len = chunk_size as u32;
            spawn_read(&mut in_flight, read_offset, read_len);
            #[cfg(feature = "performance-telemetry")]
            on_event(FilePipelineEvent::RequestStarted);
            next_offset += chunk_size as u64;
        }
        if in_flight.is_empty() {
            break;
        }
        let result = in_flight.join_next().await;
        let Some(result) = result else {
            break;
        };
        let chunk = match result {
            Ok(Ok(result)) => {
                #[cfg(feature = "performance-telemetry")]
                on_event(FilePipelineEvent::RequestFinished {
                    duration_ms: result.1,
                });
                result.0
            }
            Ok(Err(err)) => {
                #[cfg(feature = "performance-telemetry")]
                {
                    on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len() + 1));
                    on_event(FilePipelineEvent::PendingChunksRemoved(
                        pending_chunks.len(),
                    ));
                }
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                return Err(err);
            }
            Err(err) => {
                #[cfg(feature = "performance-telemetry")]
                {
                    on_event(FilePipelineEvent::RequestsDiscarded(in_flight.len() + 1));
                    on_event(FilePipelineEvent::PendingChunksRemoved(
                        pending_chunks.len(),
                    ));
                }
                in_flight.abort_all();
                let _ = sftp.close(handle_id.clone()).await;
                return Err(EngineError::with_detail(
                    SFTP_TRANSFER_FAILED_CODE,
                    "Unable to read file data",
                    err.to_string(),
                ));
            }
        };
        #[cfg(feature = "performance-telemetry")]
        let pending_before = pending_chunks.len();
        let follow_up =
            queue_download_read_chunk(chunk, &mut pending_chunks, &mut eof, &mut eof_responses);
        #[cfg(feature = "performance-telemetry")]
        if pending_chunks.len() > pending_before {
            on_event(FilePipelineEvent::PendingChunksAdded(
                pending_chunks.len() - pending_before,
            ));
        }
        if let Some(follow_up) = follow_up {
            spawn_read(&mut in_flight, follow_up.offset, follow_up.len);
            #[cfg(feature = "performance-telemetry")]
            on_event(FilePipelineEvent::RequestStarted);
        }
        let chunks =
            drain_contiguous_download_chunks(&mut pending_chunks, &mut expected_write_offset);
        #[cfg(feature = "performance-telemetry")]
        on_event(FilePipelineEvent::PendingChunksRemoved(chunks.len()));
        for chunk in chunks {
            local.write_all(&chunk).await.map_err(|err| {
                EngineError::with_detail(
                    SFTP_TRANSFER_FAILED_CODE,
                    "Unable to write file data",
                    err.to_string(),
                )
            })?;
            transferred += chunk.len() as u64;
            on_event(FilePipelineEvent::Progress(transferred));
        }
    }

    if !pending_chunks.is_empty() {
        #[cfg(feature = "performance-telemetry")]
        on_event(FilePipelineEvent::PendingChunksRemoved(
            pending_chunks.len(),
        ));
        let _ = sftp.close(handle_id.clone()).await;
        let _ = tokio::fs::remove_file(local_path).await;
        return Err(EngineError::with_detail(
            SFTP_TRANSFER_FAILED_CODE,
            "Downloaded file contains non-contiguous data chunks",
            format!(
                "expected_offset={expected_write_offset}, pending_offsets={:?}",
                pending_chunks.keys().copied().collect::<Vec<_>>()
            ),
        ));
    }
    if let Some(size) = expected_size
        && transferred != size
    {
        let _ = sftp.close(handle_id.clone()).await;
        let _ = tokio::fs::remove_file(local_path).await;
        return Err(EngineError::with_detail(
            SFTP_TRANSFER_FAILED_CODE,
            "Downloaded file size does not match the remote file size",
            format!("expected_size={size}, transferred={transferred}"),
        ));
    }

    sftp.close(handle_id).await.map_err(|err| {
        EngineError::with_detail(
            SFTP_DOWNLOAD_FAILED_CODE,
            "Failed to close the remote file",
            err.to_string(),
        )
    })?;
    Ok(transferred)
}

/// 根据服务端限制确定窗口化下载分块大小。
fn download_chunk_size(read_limit: Option<u64>) -> usize {
    let mut chunk_size = 256 * 1024usize;
    if let Some(limit) = read_limit {
        chunk_size = chunk_size.min(limit as usize);
    }
    if chunk_size == 0 {
        64 * 1024
    } else {
        chunk_size
    }
}

/// 根据服务端限制确定窗口化上传分块大小。
fn upload_chunk_size(write_limit: Option<u64>) -> usize {
    match write_limit {
        Some(limit) if limit > 0 => usize::try_from(limit)
            .unwrap_or(usize::MAX)
            .min(MAX_UPLOAD_CHUNK_SIZE),
        _ => DEFAULT_UPLOAD_CHUNK_SIZE,
    }
}

/// 将一次远端读结果纳入待写队列，并为短读返回补读区间。
fn queue_download_read_chunk(
    chunk: DownloadReadChunk,
    pending_chunks: &mut BTreeMap<u64, Vec<u8>>,
    eof: &mut bool,
    eof_responses: &mut u64,
) -> Option<DownloadReadFollowUp> {
    if chunk.data.is_empty() {
        *eof = true;
        *eof_responses += 1;
        return None;
    }

    let actual_len = chunk.data.len();
    let follow_up = if actual_len < chunk.requested_len as usize {
        Some(DownloadReadFollowUp {
            offset: chunk.offset + actual_len as u64,
            len: chunk.requested_len - actual_len as u32,
        })
    } else {
        None
    };
    pending_chunks.insert(chunk.offset, chunk.data);
    follow_up
}

/// 从待写队列中取出当前 offset 起连续可写的数据块。
fn drain_contiguous_download_chunks(
    pending_chunks: &mut BTreeMap<u64, Vec<u8>>,
    expected_write_offset: &mut u64,
) -> Vec<Vec<u8>> {
    let mut chunks = Vec::new();
    while let Some(chunk) = pending_chunks.remove(expected_write_offset) {
        *expected_write_offset += chunk.len() as u64;
        chunks.push(chunk);
    }
    chunks
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
        item_label: items_label(Some(state.total_items)),
        target_name: context.target_name.clone(),
        current_item_name: current_item_name.map(|value| value.to_string()),
        transferred: state.transferred,
        total: state.total_bytes,
        completed_items: state.completed_items,
        total_items: Some(state.total_items),
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
        #[cfg(feature = "performance-telemetry")]
        if let Some(telemetry) = inner.telemetry.as_mut() {
            telemetry.observe_bytes(delta);
        }
    });
}

/// 将文件流水线事件汇总到任务级进度与性能流。
fn pipeline_handle_file_event(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
    current_item_name: &str,
    last_transferred: &mut u64,
    event: FilePipelineEvent,
) {
    match event {
        FilePipelineEvent::Progress(file_transferred) => {
            let delta = file_transferred.saturating_sub(*last_transferred);
            *last_transferred = file_transferred;
            pipeline_add_transferred(state, context, current_item_name, delta);
        }
        #[cfg(feature = "performance-telemetry")]
        FilePipelineEvent::RequestStarted => {
            if let Some(telemetry) = state
                .lock()
                .expect("pipeline progress mutex poisoned")
                .telemetry
                .as_mut()
            {
                telemetry.request_started();
            }
        }
        #[cfg(feature = "performance-telemetry")]
        FilePipelineEvent::RequestFinished { duration_ms } => {
            if let Some(telemetry) = state
                .lock()
                .expect("pipeline progress mutex poisoned")
                .telemetry
                .as_mut()
            {
                telemetry.request_finished(duration_ms);
            }
        }
        #[cfg(feature = "performance-telemetry")]
        FilePipelineEvent::RequestsDiscarded(count) => {
            if let Some(telemetry) = state
                .lock()
                .expect("pipeline progress mutex poisoned")
                .telemetry
                .as_mut()
            {
                telemetry.requests_discarded(count);
            }
        }
        #[cfg(feature = "performance-telemetry")]
        FilePipelineEvent::PendingChunksAdded(count) => {
            if let Some(telemetry) = state
                .lock()
                .expect("pipeline progress mutex poisoned")
                .telemetry
                .as_mut()
            {
                telemetry.pending_chunks_added(count);
            }
        }
        #[cfg(feature = "performance-telemetry")]
        FilePipelineEvent::PendingChunksRemoved(count) => {
            if let Some(telemetry) = state
                .lock()
                .expect("pipeline progress mutex poisoned")
                .telemetry
                .as_mut()
            {
                telemetry.pending_chunks_removed(count);
            }
        }
    }
}

/// 以最终状态结束流水线任务并发出终态事件。
fn finalize_pipeline_state(
    state: &Arc<Mutex<PipelineProgressState>>,
    context: &PipelineEmitContext,
    status: SftpTransferStatus,
) -> PipelineProgressState {
    let mut guard = state.lock().expect("pipeline progress mutex poisoned");
    guard.status = status;
    let snapshot = guard.clone();
    #[cfg(feature = "performance-telemetry")]
    let mut telemetry = guard.telemetry.take();
    drop(guard);
    #[cfg(feature = "performance-telemetry")]
    if let Some(telemetry) = telemetry.as_mut() {
        let outcome = match status {
            SftpTransferStatus::Success => StreamOutcome::Succeeded,
            SftpTransferStatus::PartialSuccess => StreamOutcome::Partial,
            SftpTransferStatus::Cancelled => StreamOutcome::Cancelled,
            SftpTransferStatus::Failed | SftpTransferStatus::Running => StreamOutcome::Failed,
        };
        telemetry.finish(
            outcome,
            snapshot.transferred,
            snapshot.completed_items,
            snapshot.failed_items,
        );
    }
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
        SFTP_DOWNLOAD_FAILED_CODE,
        "Failed to generate an available local destination path",
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

/// 记录 SFTP 传输成功日志。
fn log_sftp_success(event: SftpLogEvent, context: &TransferLogContext<'_>) {
    event.record(json!({
        "sessionId": context.session_id,
        "durationMs": context.elapsed_ms,
        "bytes": context.transferred_bytes,
        "totalBytes": context.total_bytes.unwrap_or(0),
    }));
}

/// 记录 SFTP 传输失败日志。
fn log_sftp_failure(event: SftpLogEvent, context: &TransferLogContext<'_>, err: &EngineError) {
    event.record(json!({
        "sessionId": context.session_id,
        "durationMs": context.elapsed_ms,
        "bytes": context.transferred_bytes,
        "totalBytes": context.total_bytes.unwrap_or(0),
        "error": {
            "code": err.code,
            "message": err.message,
            "detail": err.details,
        }
    }));
}

/// 记录仅包含单一路径的 SFTP 操作失败日志。
fn log_sftp_path_failure(event: SftpLogEvent, elapsed_ms: u128, err: &EngineError) {
    event.record(json!({
        "durationMs": elapsed_ms,
        "error": {
            "code": err.code,
            "message": err.message,
            "detail": err.details,
        }
    }));
}

/// 记录包含源路径和目标路径的 SFTP 操作失败日志。
fn log_sftp_pair_failure(event: SftpLogEvent, elapsed_ms: u128, err: &EngineError) {
    event.record(json!({
        "durationMs": elapsed_ms,
        "error": {
            "code": err.code,
            "message": err.message,
            "detail": err.details,
        }
    }));
}

/// 记录 SFTP 初始化阶段超时，便于分析服务端兼容性。
fn log_sftp_init_timeout(stage: &str, mode: &str) {
    log_event!(
        LogLevel::Warn,
        "sftp.initialization.failed",
        None,
        json!({
            "stage": stage,
            "mode": mode,
            "timeoutMs": SFTP_INIT_STAGE_TIMEOUT_MS,
            "error": {
                "code": "sftp_init_timeout",
                "message": "SFTP initialization timed out",
            }
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
            SFTP_INIT_FAILED_CODE,
            "Timed out while opening the SFTP channel",
            format!(
                "stage=channel_open_session timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail(
            SFTP_INIT_FAILED_CODE,
            "Failed to open the SFTP channel",
            err.to_string(),
        )
    })?;
    timeout(
        Duration::from_millis(SFTP_INIT_STAGE_TIMEOUT_MS),
        channel.request_subsystem(true, "sftp"),
    )
    .await
    .map_err(|_| {
        log_sftp_init_timeout("request_subsystem", "session");
        EngineError::with_detail(
            SFTP_INIT_FAILED_CODE,
            "Timed out while requesting the SFTP subsystem",
            format!(
                "stage=request_subsystem timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail(
            SFTP_INIT_FAILED_CODE,
            "Failed to request the SFTP subsystem",
            err.to_string(),
        )
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
            SFTP_INIT_FAILED_CODE,
            "Timed out while initializing SFTP",
            format!(
                "stage=sftp_session_new timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail(
            SFTP_INIT_FAILED_CODE,
            "Failed to initialize SFTP",
            err.to_string(),
        )
    })
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
            SFTP_INIT_FAILED_CODE,
            "Timed out while opening the SFTP channel",
            format!(
                "stage=channel_open_session timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail(
            SFTP_INIT_FAILED_CODE,
            "Failed to open the SFTP channel",
            err.to_string(),
        )
    })?;
    timeout(
        Duration::from_millis(SFTP_INIT_STAGE_TIMEOUT_MS),
        channel.request_subsystem(true, "sftp"),
    )
    .await
    .map_err(|_| {
        log_sftp_init_timeout("request_subsystem", "raw");
        EngineError::with_detail(
            SFTP_INIT_FAILED_CODE,
            "Timed out while requesting the SFTP subsystem",
            format!(
                "stage=request_subsystem timeout={}ms",
                SFTP_INIT_STAGE_TIMEOUT_MS
            ),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail(
            SFTP_INIT_FAILED_CODE,
            "Failed to request the SFTP subsystem",
            err.to_string(),
        )
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
            SFTP_INIT_FAILED_CODE,
            "Timed out while initializing SFTP",
            format!("stage=raw_init timeout={}ms", SFTP_INIT_STAGE_TIMEOUT_MS),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail(
            SFTP_INIT_FAILED_CODE,
            "Failed to initialize SFTP",
            err.to_string(),
        )
    })?;
    let mut limits_snapshot = RawSftpLimits::default();
    if version
        .extensions
        .get(extensions::LIMITS)
        .is_some_and(|value| value == "1")
    {
        let limits = raw.limits().await.map_err(|err| {
            EngineError::with_detail(
                SFTP_INIT_FAILED_CODE,
                "Failed to get SFTP limits",
                err.to_string(),
            )
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

#[cfg(test)]
mod tests {
    use super::{
        DownloadReadChunk, DownloadReadFollowUp, PipelineEmitContext, PipelineProgressState,
        UploadJobKind, classify_upload_roots, download_chunk_size,
        drain_contiguous_download_chunks, emit_pipeline_progress, next_transfer_id,
        queue_download_read_chunk, upload_chunk_size, upload_roots_display_name,
    };
    use crate::types::{EngineEvent, SftpProgressOp, SftpTransferKind, SftpTransferStatus};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;
    #[cfg(feature = "performance-telemetry")]
    use {
        super::SftpPerformanceStream,
        fluxterm_performance_telemetry::{
            HistogramAccumulator, StreamCorrelation, StreamKind, StreamTarget,
            create_stream_descriptor, definition as metric_definition,
        },
        std::collections::BTreeMap as TelemetryParameters,
        std::time::{Duration, Instant},
    };

    fn temporary_test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("fluxterm-sftp-{name}-{}", Uuid::new_v4()))
    }

    #[test]
    fn transfer_ids_are_globally_unique() {
        let first = next_transfer_id();
        let second = next_transfer_id();

        assert!(first.starts_with("sftp-"));
        assert!(second.starts_with("sftp-"));
        assert_ne!(first, second);
    }

    #[test]
    fn classifies_upload_roots_by_business_shape() {
        let root = temporary_test_path("classify");
        let directory = root.join("directory");
        let file = root.join("file.txt");
        std::fs::create_dir_all(&directory).expect("create test directory");
        std::fs::write(&file, b"fixture").expect("create test file");

        assert_eq!(
            classify_upload_roots(std::slice::from_ref(&file)).expect("classify file"),
            UploadJobKind::File
        );
        assert_eq!(
            classify_upload_roots(std::slice::from_ref(&directory)).expect("classify directory"),
            UploadJobKind::Directory
        );
        assert_eq!(
            classify_upload_roots(&[file.clone(), directory.clone()]).expect("classify batch"),
            UploadJobKind::Batch
        );
        assert!(classify_upload_roots(&[root.join("missing")]).is_err());

        std::fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn single_upload_root_uses_real_display_name() {
        assert_eq!(
            upload_roots_display_name(&[PathBuf::from("folder/file.txt")]),
            "file.txt"
        );
        assert_eq!(
            upload_roots_display_name(&[PathBuf::from("folder/directory")]),
            "directory"
        );
        assert_eq!(
            upload_roots_display_name(&[
                PathBuf::from("folder/a.txt"),
                PathBuf::from("folder/b.txt")
            ]),
            "items"
        );
    }

    #[test]
    fn download_chunk_size_respects_server_limit_and_zero_fallback() {
        assert_eq!(download_chunk_size(None), 256 * 1024);
        assert_eq!(download_chunk_size(Some(64 * 1024)), 64 * 1024);
        assert_eq!(download_chunk_size(Some(0)), 64 * 1024);
    }

    #[test]
    fn upload_chunk_size_uses_safe_fallback_and_respects_server_limit() {
        assert_eq!(upload_chunk_size(None), 128 * 1024);
        assert_eq!(upload_chunk_size(Some(0)), 128 * 1024);
        assert_eq!(upload_chunk_size(Some(64 * 1024)), 64 * 1024);
        assert_eq!(upload_chunk_size(Some(128 * 1024)), 128 * 1024);
        assert_eq!(
            upload_chunk_size(Some(256 * 1024 - 1024)),
            256 * 1024 - 1024
        );
        assert_eq!(upload_chunk_size(Some(512 * 1024)), 256 * 1024);
    }

    #[cfg(feature = "performance-telemetry")]
    #[test]
    fn telemetry_tracks_real_request_and_pending_lifecycle() {
        let now = Instant::now();
        let mut telemetry = SftpPerformanceStream {
            descriptor: create_stream_descriptor(
                StreamKind::SftpDownloadFile,
                1,
                TelemetryParameters::new(),
                StreamTarget {
                    host: "server.internal".into(),
                    port: 22,
                },
                StreamCorrelation {
                    session_id: Uuid::new_v4().to_string(),
                    transfer_id: Some("transfer-1".into()),
                },
            ),
            interval: Duration::from_secs(3600),
            started_at: now,
            window_started_at: now,
            window_started_unix_ms: 1,
            window_bytes: 0,
            window_requests: 0,
            current_in_flight: 0,
            current_pending_chunks: 0,
            max_in_flight: 0,
            max_pending_chunks: 0,
            request_durations: HistogramAccumulator::new(
                metric_definition("fluxterm.sftp.request.duration")
                    .expect("request duration metric")
                    .histogram_bounds,
            ),
            scan_duration_ms: None,
            closed: true,
        };

        telemetry.request_started();
        telemetry.request_started();
        telemetry.pending_chunks_added(2);
        telemetry.request_finished(4.0);
        telemetry.observe_bytes(128);
        telemetry.requests_discarded(1);
        telemetry.pending_chunks_removed(2);

        assert_eq!(telemetry.window_bytes, 128);
        assert_eq!(telemetry.window_requests, 1);
        assert_eq!(telemetry.current_in_flight, 0);
        assert_eq!(telemetry.current_pending_chunks, 0);
        assert_eq!(telemetry.max_in_flight, 2);
        assert_eq!(telemetry.max_pending_chunks, 2);
    }

    #[test]
    fn queue_download_read_chunk_accepts_full_chunk() {
        let mut pending = BTreeMap::new();
        let mut eof = false;
        let mut eof_responses = 0;

        let follow_up = queue_download_read_chunk(
            DownloadReadChunk {
                offset: 0,
                requested_len: 4,
                data: b"abcd".to_vec(),
            },
            &mut pending,
            &mut eof,
            &mut eof_responses,
        );
        let mut expected_offset = 0;
        let chunks = drain_contiguous_download_chunks(&mut pending, &mut expected_offset);

        assert_eq!(follow_up, None);
        assert!(!eof);
        assert_eq!(eof_responses, 0);
        assert_eq!(expected_offset, 4);
        assert_eq!(chunks.concat(), b"abcd");
    }

    #[test]
    fn queue_download_read_chunk_schedules_short_read_follow_up() {
        let mut pending = BTreeMap::new();
        let mut eof = false;
        let mut eof_responses = 0;
        let mut expected_offset = 0;

        let follow_up = queue_download_read_chunk(
            DownloadReadChunk {
                offset: 0,
                requested_len: 4,
                data: b"ab".to_vec(),
            },
            &mut pending,
            &mut eof,
            &mut eof_responses,
        );
        let first_chunks = drain_contiguous_download_chunks(&mut pending, &mut expected_offset);
        queue_download_read_chunk(
            DownloadReadChunk {
                offset: 2,
                requested_len: 2,
                data: b"cd".to_vec(),
            },
            &mut pending,
            &mut eof,
            &mut eof_responses,
        );
        let second_chunks = drain_contiguous_download_chunks(&mut pending, &mut expected_offset);

        assert_eq!(follow_up, Some(DownloadReadFollowUp { offset: 2, len: 2 }));
        assert_eq!(first_chunks.concat(), b"ab");
        assert_eq!(second_chunks.concat(), b"cd");
        assert_eq!(expected_offset, 4);
        assert!(!eof);
    }

    #[test]
    fn drain_contiguous_download_chunks_preserves_offset_order() {
        let mut pending = BTreeMap::new();
        let mut eof = false;
        let mut eof_responses = 0;
        let mut expected_offset = 0;

        queue_download_read_chunk(
            DownloadReadChunk {
                offset: 4,
                requested_len: 2,
                data: b"ef".to_vec(),
            },
            &mut pending,
            &mut eof,
            &mut eof_responses,
        );
        assert!(drain_contiguous_download_chunks(&mut pending, &mut expected_offset).is_empty());

        queue_download_read_chunk(
            DownloadReadChunk {
                offset: 0,
                requested_len: 4,
                data: b"abcd".to_vec(),
            },
            &mut pending,
            &mut eof,
            &mut eof_responses,
        );
        let chunks = drain_contiguous_download_chunks(&mut pending, &mut expected_offset);

        assert_eq!(chunks.concat(), b"abcdef");
        assert_eq!(expected_offset, 6);
        assert!(pending.is_empty());
    }

    #[test]
    fn queue_download_read_chunk_marks_eof_without_hiding_gaps() {
        let mut pending = BTreeMap::new();
        let mut eof = false;
        let mut eof_responses = 0;
        let mut expected_offset = 0;

        queue_download_read_chunk(
            DownloadReadChunk {
                offset: 4,
                requested_len: 2,
                data: b"ef".to_vec(),
            },
            &mut pending,
            &mut eof,
            &mut eof_responses,
        );
        queue_download_read_chunk(
            DownloadReadChunk {
                offset: 6,
                requested_len: 2,
                data: Vec::new(),
            },
            &mut pending,
            &mut eof,
            &mut eof_responses,
        );
        let chunks = drain_contiguous_download_chunks(&mut pending, &mut expected_offset);

        assert!(eof);
        assert_eq!(eof_responses, 1);
        assert!(chunks.is_empty());
        assert_eq!(expected_offset, 0);
        assert!(!pending.is_empty());
    }

    #[test]
    fn emit_pipeline_progress_preserves_zero_total_items() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);
        let context = PipelineEmitContext {
            session_id: "session-1".to_string(),
            transfer_id: "transfer-1".to_string(),
            op: SftpProgressOp::Download,
            kind: SftpTransferKind::Directory,
            path: "/remote/empty".to_string(),
            display_name: "empty".to_string(),
            target_name: None,
            on_event: Arc::new(move |event| {
                captured_events.lock().expect("events lock").push(event);
            }),
        };
        let state = PipelineProgressState {
            transferred: 0,
            total_bytes: Some(0),
            completed_items: 0,
            total_items: 0,
            failed_items: 0,
            status: SftpTransferStatus::Running,
            #[cfg(feature = "performance-telemetry")]
            telemetry: None,
        };

        emit_pipeline_progress(&context, &state, None);

        let events = events.lock().expect("events lock");
        let Some(EngineEvent::SftpProgress(progress)) = events.last() else {
            panic!("expected sftp progress event");
        };
        assert_eq!(progress.total_items, Some(0));
        assert_eq!(progress.completed_items, 0);
        assert_eq!(progress.item_label, "0 items");
    }
}
