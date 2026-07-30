//! SFTP/RDP 性能遥测配置和 UDP 发送服务。

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fluxterm_logging::{LogLevel, log_event};
use fluxterm_performance_telemetry::{
    DeviceIdentity, MetricBatch, PerformanceDomain, PerformanceTelemetrySink, RecordOutcome,
    Source, StreamDescriptor, StreamOutcome, encode_stream_closed, encode_stream_opened,
    encode_stream_snapshot, unix_time_ms, validate_metric,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::config_paths::{
    resolve_performance_telemetry_config_path, resolve_performance_telemetry_device_path,
};

const QUEUE_CAPACITY: usize = 256;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(100);
const DEFAULT_DESTINATION: &str = "127.0.0.1:43190";
const DEFAULT_INTERVAL_MS: u64 = 1000;
const MIN_INTERVAL_MS: u64 = 250;
const MAX_INTERVAL_MS: u64 = 60_000;

/// 原始 JSON 配置。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawConfig {
    schema_version: u8,
    enabled: bool,
    #[serde(default = "default_destination")]
    destination: String,
    #[serde(default = "default_interval_ms")]
    interval_ms: u64,
    #[serde(default = "default_domains")]
    domains: BTreeSet<PerformanceDomain>,
}

/// 持久化设备身份文件。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceIdentityFile {
    schema_version: u8,
    device_id: String,
}

fn default_destination() -> String {
    DEFAULT_DESTINATION.to_string()
}

const fn default_interval_ms() -> u64 {
    DEFAULT_INTERVAL_MS
}

fn default_domains() -> BTreeSet<PerformanceDomain> {
    BTreeSet::from([PerformanceDomain::Sftp, PerformanceDomain::Rdp])
}

/// 已验证的启动配置。
#[derive(Debug, Clone)]
pub struct PerformanceTelemetryConfig {
    destination: SocketAddr,
    interval_ms: u64,
    domains: BTreeSet<PerformanceDomain>,
}

/// 配置加载结果。
pub enum ConfigLoadResult {
    /// 文件不存在或明确关闭。
    Disabled,
    /// 启用且验证成功。
    Enabled(PerformanceTelemetryConfig),
    /// 配置存在但无效。
    Invalid(ConfigError),
}

/// 不包含配置原文的稳定配置错误。
#[derive(Debug)]
pub struct ConfigError {
    code: &'static str,
    message: &'static str,
    detail: &'static str,
}

impl ConfigError {
    /// 记录一次配置告警。
    pub fn log(&self) {
        log_event!(
            LogLevel::Warn,
            "performance.telemetry.configuration.failed",
            None,
            json!({
                "error": {
                    "code": self.code,
                    "message": self.message,
                    "detail": self.detail,
                }
            }),
        );
    }
}

fn config_error(code: &'static str, message: &'static str, detail: &'static str) -> ConfigError {
    ConfigError {
        code,
        message,
        detail,
    }
}

/// 从 Tauri app config 目录读取性能遥测配置。
pub fn load_config(app: &tauri::AppHandle) -> ConfigLoadResult {
    let path = match resolve_performance_telemetry_config_path(app) {
        Ok(path) => path,
        Err(_) => {
            return ConfigLoadResult::Invalid(config_error(
                "performance_telemetry_config_path_failed",
                "Performance telemetry configuration path resolution failed",
                "Tauri app config directory is unavailable",
            ));
        }
    };
    load_config_path(&path)
}

fn load_config_path(path: &Path) -> ConfigLoadResult {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return ConfigLoadResult::Disabled,
        Err(_) => {
            return ConfigLoadResult::Invalid(config_error(
                "performance_telemetry_config_read_failed",
                "Performance telemetry configuration could not be read",
                "configuration file read failed",
            ));
        }
    };
    if raw.len() > 16 * 1024 {
        return ConfigLoadResult::Invalid(config_error(
            "performance_telemetry_config_too_large",
            "Performance telemetry configuration is too large",
            "configuration file exceeds 16 KiB",
        ));
    }
    let raw: RawConfig = match serde_json::from_slice(&raw) {
        Ok(raw) => raw,
        Err(_) => {
            return ConfigLoadResult::Invalid(config_error(
                "performance_telemetry_config_invalid",
                "Performance telemetry configuration is invalid",
                "configuration must be valid strict JSON",
            ));
        }
    };
    if raw.schema_version != 1 {
        return ConfigLoadResult::Invalid(config_error(
            "performance_telemetry_config_version_unsupported",
            "Performance telemetry configuration version is unsupported",
            "schemaVersion must be 1",
        ));
    }
    if !raw.enabled {
        return ConfigLoadResult::Disabled;
    }
    if !(MIN_INTERVAL_MS..=MAX_INTERVAL_MS).contains(&raw.interval_ms) {
        return ConfigLoadResult::Invalid(config_error(
            "performance_telemetry_interval_invalid",
            "Performance telemetry interval is invalid",
            "intervalMs must be between 250 and 60000",
        ));
    }
    if raw.domains.is_empty() {
        return ConfigLoadResult::Invalid(config_error(
            "performance_telemetry_domains_invalid",
            "Performance telemetry domains are invalid",
            "domains must contain sftp or rdp",
        ));
    }
    let destination = match parse_private_destination(&raw.destination) {
        Ok(destination) => destination,
        Err(error) => return ConfigLoadResult::Invalid(error),
    };
    ConfigLoadResult::Enabled(PerformanceTelemetryConfig {
        destination,
        interval_ms: raw.interval_ms,
        domains: raw.domains,
    })
}

/// 加载或首次创建安装级设备身份。
pub fn load_device_identity(app: &tauri::AppHandle) -> Result<DeviceIdentity, ConfigError> {
    let path = resolve_performance_telemetry_device_path(app).map_err(|_| {
        config_error(
            "performance_telemetry_device_path_failed",
            "Performance telemetry device path resolution failed",
            "Tauri app config directory is unavailable",
        )
    })?;
    load_device_identity_path(&path, sysinfo::System::host_name())
}

fn load_device_identity_path(
    path: &Path,
    host_name: Option<String>,
) -> Result<DeviceIdentity, ConfigError> {
    let device_id = match fs::read(path) {
        Ok(raw) => {
            if raw.len() > 4096 {
                return Err(device_identity_error("device identity file exceeds 4 KiB"));
            }
            let identity: DeviceIdentityFile = serde_json::from_slice(&raw)
                .map_err(|_| device_identity_error("device identity file is invalid"))?;
            if identity.schema_version != 1 || Uuid::parse_str(&identity.device_id).is_err() {
                return Err(device_identity_error(
                    "device identity version or UUID is invalid",
                ));
            }
            identity.device_id
        }
        Err(error) if error.kind() == ErrorKind::NotFound => create_device_identity(path)?,
        Err(_) => {
            return Err(device_identity_error(
                "device identity file could not be read",
            ));
        }
    };
    Ok(DeviceIdentity {
        id: device_id,
        name: normalize_device_name(host_name),
    })
}

fn create_device_identity(path: &Path) -> Result<String, ConfigError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| device_identity_error("device identity parent directory is invalid"))?;
    fs::create_dir_all(parent)
        .map_err(|_| device_identity_error("device identity directory could not be created"))?;
    let device_id = Uuid::new_v4().to_string();
    let temporary = parent.join(format!(
        ".performance-telemetry-device-{}.tmp",
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| device_identity_error("device identity temporary file creation failed"))?;
        let payload = serde_json::to_vec_pretty(&DeviceIdentityFile {
            schema_version: 1,
            device_id: device_id.clone(),
        })
        .map_err(|_| device_identity_error("device identity serialization failed"))?;
        file.write_all(&payload)
            .and_then(|()| file.sync_all())
            .map_err(|_| device_identity_error("device identity file write failed"))?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|_| device_identity_error("device identity file commit failed"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|()| device_id)
}

fn normalize_device_name(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control))
            .then(|| value.to_string())
    })
}

fn device_identity_error(detail: &'static str) -> ConfigError {
    config_error(
        "performance_telemetry_device_identity_failed",
        "Performance telemetry device identity is unavailable",
        detail,
    )
}

fn parse_private_destination(value: &str) -> Result<SocketAddr, ConfigError> {
    let address = SocketAddr::from_str(value.trim()).map_err(|_| {
        config_error(
            "performance_telemetry_destination_invalid",
            "Performance telemetry destination is invalid",
            "destination must be a numeric IP socket address",
        )
    })?;
    if address.port() == 0 || !is_allowed_ip(address.ip()) {
        return Err(config_error(
            "performance_telemetry_destination_forbidden",
            "Performance telemetry destination is forbidden",
            "destination must be loopback or a private network address",
        ));
    }
    Ok(address)
}

fn is_allowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                    && !ip.is_unspecified()
                    && !ip.is_link_local()
                    && !ip.is_broadcast()
                    && !ip.is_multicast()
        }
        IpAddr::V6(ip) => {
            ip == Ipv6Addr::LOCALHOST
                || is_ipv6_unique_local(ip)
                    && !ip.is_unspecified()
                    && !ip.is_unicast_link_local()
                    && !ip.is_multicast()
        }
    }
}

fn is_ipv6_unique_local(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}

#[derive(Default)]
struct SenderCounters {
    accepted: AtomicU64,
    dropped: AtomicU64,
    invalid: AtomicU64,
    sent: AtomicU64,
    send_failed: AtomicU64,
    encoded_bytes: AtomicU64,
}

/// 前端可查询的发送端状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceTelemetryStatus {
    enabled: bool,
    interval_ms: u64,
    domains: Vec<PerformanceDomain>,
    accepted: u64,
    dropped: u64,
    invalid: u64,
    sent: u64,
    send_failed: u64,
    encoded_bytes: u64,
}

enum WorkerMessage {
    Open {
        stream: StreamDescriptor,
        datagram: Vec<u8>,
    },
    Batch(MetricBatch),
    Close {
        stream_id: String,
        outcome: StreamOutcome,
        ended_at_unix_ms: u64,
    },
    Shutdown(mpsc::Sender<()>),
}

struct ChannelSink {
    sender: SyncSender<WorkerMessage>,
    source: Source,
    domains: BTreeSet<PerformanceDomain>,
    interval_ms: u64,
    streams: Arc<Mutex<HashMap<String, PerformanceDomain>>>,
    counters: Arc<SenderCounters>,
}

impl ChannelSink {
    fn try_send(&self, message: WorkerMessage) -> RecordOutcome {
        match self.sender.try_send(message) {
            Ok(()) => {
                self.counters.accepted.fetch_add(1, Ordering::Relaxed);
                RecordOutcome::Accepted
            }
            Err(TrySendError::Full(_)) => {
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                RecordOutcome::Dropped
            }
            Err(TrySendError::Disconnected(_)) => {
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                RecordOutcome::Dropped
            }
        }
    }
}

impl PerformanceTelemetrySink for ChannelSink {
    fn enabled(&self, domain: PerformanceDomain) -> bool {
        self.domains.contains(&domain)
    }

    fn interval_ms(&self, domain: PerformanceDomain) -> Option<u64> {
        self.enabled(domain).then_some(self.interval_ms)
    }

    fn open_stream(&self, stream: StreamDescriptor) -> RecordOutcome {
        if !self.enabled(stream.domain) {
            self.counters.invalid.fetch_add(1, Ordering::Relaxed);
            return RecordOutcome::Invalid;
        }
        let datagram = match encode_stream_opened(&self.source, &stream, 0, unix_time_ms()) {
            Ok(datagram) => datagram,
            Err(_) => {
                self.counters.invalid.fetch_add(1, Ordering::Relaxed);
                return RecordOutcome::Invalid;
            }
        };
        let mut streams = self
            .streams
            .lock()
            .expect("performance telemetry stream registry poisoned");
        if streams.contains_key(&stream.id) {
            self.counters.invalid.fetch_add(1, Ordering::Relaxed);
            return RecordOutcome::Invalid;
        }
        let outcome = self.try_send(WorkerMessage::Open {
            stream: stream.clone(),
            datagram,
        });
        if outcome == RecordOutcome::Accepted {
            streams.insert(stream.id, stream.domain);
        }
        outcome
    }

    fn record_batch(&self, batch: MetricBatch) -> RecordOutcome {
        let streams = self
            .streams
            .lock()
            .expect("performance telemetry stream registry poisoned");
        let domain = streams.get(&batch.stream_id).copied();
        if domain.is_none()
            || batch.window.started_at_unix_ms == 0
            || batch.window.duration_ms == 0
            || batch
                .window
                .started_at_unix_ms
                .checked_add(batch.window.duration_ms)
                .is_none()
            || batch.metrics.is_empty()
            || batch.metrics.len() > 64
            || batch.metrics.iter().any(|point| {
                validate_metric(point).is_err()
                    || domain.is_some_and(|domain| !point.name.starts_with(domain_prefix(domain)))
            })
        {
            self.counters.invalid.fetch_add(1, Ordering::Relaxed);
            return RecordOutcome::Invalid;
        }
        self.try_send(WorkerMessage::Batch(batch))
    }

    fn close_stream(
        &self,
        stream_id: &str,
        outcome: StreamOutcome,
        ended_at_unix_ms: u64,
    ) -> RecordOutcome {
        let mut streams = self
            .streams
            .lock()
            .expect("performance telemetry stream registry poisoned");
        if !streams.contains_key(stream_id)
            || ended_at_unix_ms == 0
            || ended_at_unix_ms > unix_time_ms()
        {
            self.counters.invalid.fetch_add(1, Ordering::Relaxed);
            return RecordOutcome::Invalid;
        }
        let result = self.try_send(WorkerMessage::Close {
            stream_id: stream_id.to_string(),
            outcome,
            ended_at_unix_ms,
        });
        if result == RecordOutcome::Accepted {
            streams.remove(stream_id);
        }
        result
    }
}

fn domain_prefix(domain: PerformanceDomain) -> &'static str {
    match domain {
        PerformanceDomain::Sftp => "fluxterm.sftp.",
        PerformanceDomain::Rdp => "fluxterm.rdp.",
    }
}

/// Tauri 管理的性能遥测服务。
pub struct PerformanceTelemetryService {
    enabled: bool,
    interval_ms: u64,
    domains: BTreeSet<PerformanceDomain>,
    sink: Option<Arc<ChannelSink>>,
    counters: Arc<SenderCounters>,
    shutdown_started: AtomicBool,
}

impl PerformanceTelemetryService {
    /// 创建禁用服务。
    pub fn disabled() -> Arc<Self> {
        Arc::new(Self {
            enabled: false,
            interval_ms: DEFAULT_INTERVAL_MS,
            domains: BTreeSet::new(),
            sink: None,
            counters: Arc::new(SenderCounters::default()),
            shutdown_started: AtomicBool::new(false),
        })
    }

    /// 启动 UDP worker。
    pub fn start(
        config: PerformanceTelemetryConfig,
        device: DeviceIdentity,
    ) -> Result<Arc<Self>, ConfigError> {
        let bind_address = match config.destination {
            SocketAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
            SocketAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
        };
        let socket = UdpSocket::bind(bind_address).map_err(|_| {
            config_error(
                "performance_telemetry_socket_bind_failed",
                "Performance telemetry socket could not be created",
                "UDP socket bind failed",
            )
        })?;
        socket.connect(config.destination).map_err(|_| {
            config_error(
                "performance_telemetry_socket_connect_failed",
                "Performance telemetry destination could not be configured",
                "UDP socket connect failed",
            )
        })?;

        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let counters = Arc::new(SenderCounters::default());
        let streams = Arc::new(Mutex::new(HashMap::new()));
        let source = Source {
            application: "fluxterm".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            instance_id: Uuid::new_v4().to_string(),
            device,
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            build_profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
            .to_string(),
        };
        let sink = Arc::new(ChannelSink {
            sender,
            source: source.clone(),
            domains: config.domains.clone(),
            interval_ms: config.interval_ms,
            streams,
            counters: Arc::clone(&counters),
        });
        let worker_counters = Arc::clone(&counters);
        std::thread::Builder::new()
            .name("fluxterm-performance-telemetry".to_string())
            .spawn(move || run_worker(receiver, socket, source, worker_counters))
            .map_err(|_| {
                config_error(
                    "performance_telemetry_worker_start_failed",
                    "Performance telemetry worker could not be started",
                    "sender thread creation failed",
                )
            })?;

        log_event!(
            LogLevel::Info,
            "performance.telemetry.sender.ready",
            None,
            json!({
                "intervalMs": config.interval_ms,
                "domainCount": config.domains.len(),
            }),
        );
        Ok(Arc::new(Self {
            enabled: true,
            interval_ms: config.interval_ms,
            domains: config.domains,
            sink: Some(sink),
            counters,
            shutdown_started: AtomicBool::new(false),
        }))
    }

    /// 返回可安装到公共 crate 的 sink。
    pub fn sink(&self) -> Option<Arc<dyn PerformanceTelemetrySink>> {
        self.sink
            .as_ref()
            .map(|sink| Arc::clone(sink) as Arc<dyn PerformanceTelemetrySink>)
    }

    /// 查询发送端状态。
    pub fn status(&self) -> PerformanceTelemetryStatus {
        PerformanceTelemetryStatus {
            enabled: self.enabled,
            interval_ms: self.interval_ms,
            domains: self.domains.iter().copied().collect(),
            accepted: self.counters.accepted.load(Ordering::Relaxed),
            dropped: self.counters.dropped.load(Ordering::Relaxed),
            invalid: self.counters.invalid.load(Ordering::Relaxed),
            sent: self.counters.sent.load(Ordering::Relaxed),
            send_failed: self.counters.send_failed.load(Ordering::Relaxed),
            encoded_bytes: self.counters.encoded_bytes.load(Ordering::Relaxed),
        }
    }

    /// 最多等待 100 ms 尝试刷新退出消息。
    pub fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(sink) = &self.sink else {
            return;
        };
        let (ack_sender, ack_receiver) = mpsc::channel();
        if sink
            .sender
            .try_send(WorkerMessage::Shutdown(ack_sender))
            .is_ok()
        {
            let _ = ack_receiver.recv_timeout(SHUTDOWN_TIMEOUT);
        }
    }
}

struct WorkerStream {
    descriptor: StreamDescriptor,
    next_sequence: u64,
    batch_sequence: u64,
}

fn run_worker(
    receiver: Receiver<WorkerMessage>,
    socket: UdpSocket,
    source: Source,
    counters: Arc<SenderCounters>,
) {
    let mut streams = HashMap::<String, WorkerStream>::new();
    let mut send_failed = false;
    while let Ok(message) = receiver.recv() {
        match message {
            WorkerMessage::Open { stream, datagram } => {
                send_datagram(&socket, &datagram, &counters, &mut send_failed);
                streams.insert(
                    stream.id.clone(),
                    WorkerStream {
                        descriptor: stream,
                        next_sequence: 1,
                        batch_sequence: 0,
                    },
                );
            }
            WorkerMessage::Batch(batch) => {
                let Some(stream) = streams.get_mut(&batch.stream_id) else {
                    counters.invalid.fetch_add(1, Ordering::Relaxed);
                    continue;
                };
                let batch_id = format!("{}:{}", stream.descriptor.id, stream.batch_sequence);
                let sent_at_unix_ms = batch
                    .window
                    .started_at_unix_ms
                    .checked_add(batch.window.duration_ms)
                    .map_or_else(unix_time_ms, |ended_at| ended_at.max(unix_time_ms()));
                match encode_stream_snapshot(
                    &source,
                    &stream.descriptor,
                    batch.window,
                    batch.metrics,
                    stream.next_sequence,
                    &batch_id,
                    sent_at_unix_ms,
                ) {
                    Ok(encoded) => {
                        counters
                            .invalid
                            .fetch_add(encoded.rejected_metrics, Ordering::Relaxed);
                        stream.next_sequence = encoded.next_sequence;
                        stream.batch_sequence = stream.batch_sequence.saturating_add(1);
                        for datagram in encoded.datagrams {
                            send_datagram(&socket, &datagram, &counters, &mut send_failed);
                        }
                    }
                    Err(_) => {
                        counters.invalid.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            WorkerMessage::Close {
                stream_id,
                outcome,
                ended_at_unix_ms,
            } => {
                let Some(stream) = streams.remove(&stream_id) else {
                    counters.invalid.fetch_add(1, Ordering::Relaxed);
                    continue;
                };
                match encode_stream_closed(
                    &source,
                    &stream.descriptor,
                    outcome,
                    ended_at_unix_ms,
                    stream.next_sequence,
                    unix_time_ms(),
                ) {
                    Ok(datagram) => {
                        send_datagram(&socket, &datagram, &counters, &mut send_failed);
                    }
                    Err(_) => {
                        counters.invalid.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            WorkerMessage::Shutdown(ack) => {
                for (_, stream) in streams.drain() {
                    if let Ok(datagram) = encode_stream_closed(
                        &source,
                        &stream.descriptor,
                        StreamOutcome::Disconnected,
                        unix_time_ms(),
                        stream.next_sequence,
                        unix_time_ms(),
                    ) {
                        send_datagram(&socket, &datagram, &counters, &mut send_failed);
                    }
                }
                let _ = ack.send(());
                return;
            }
        }
    }
}

fn send_datagram(
    socket: &UdpSocket,
    datagram: &[u8],
    counters: &SenderCounters,
    failed_state: &mut bool,
) {
    match socket.send(datagram) {
        Ok(bytes) => {
            counters.sent.fetch_add(1, Ordering::Relaxed);
            counters
                .encoded_bytes
                .fetch_add(bytes as u64, Ordering::Relaxed);
            if *failed_state {
                *failed_state = false;
                log_event!(
                    LogLevel::Info,
                    "performance.telemetry.sender.recovered",
                    None,
                    json!({}),
                );
            }
        }
        Err(_) => {
            counters.send_failed.fetch_add(1, Ordering::Relaxed);
            if !*failed_state {
                *failed_state = true;
                log_event!(
                    LogLevel::Warn,
                    "performance.telemetry.sender.failed",
                    None,
                    json!({
                        "error": {
                            "code": "performance_telemetry_udp_send_failed",
                            "message": "Performance telemetry UDP send failed",
                        }
                    }),
                );
            }
        }
    }
}

/// 查询性能遥测状态。
#[tauri::command]
pub fn performance_telemetry_status_get(
    service: tauri::State<'_, Arc<PerformanceTelemetryService>>,
) -> PerformanceTelemetryStatus {
    service.status()
}

/// 提交一批已经在 RDP Webview 聚合的指标。
#[tauri::command]
pub fn performance_telemetry_record_rdp_batch(
    service: tauri::State<'_, Arc<PerformanceTelemetryService>>,
    batch: FrontendMetricBatch,
) -> RecordOutcomeDto {
    let outcome = service
        .sink
        .as_ref()
        .map_or(RecordOutcome::Disabled, |sink| {
            sink.record_batch(batch.into_metric_batch())
        });
    outcome.into()
}

/// Webview 指标批次。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendMetricBatch {
    stream_id: String,
    window: fluxterm_performance_telemetry::MetricWindow,
    metrics: Vec<fluxterm_performance_telemetry::MetricPoint>,
}

impl FrontendMetricBatch {
    fn into_metric_batch(self) -> MetricBatch {
        MetricBatch {
            stream_id: self.stream_id,
            window: self.window,
            metrics: self.metrics,
        }
    }
}

/// 可序列化记录结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordOutcomeDto {
    outcome: &'static str,
}

impl From<RecordOutcome> for RecordOutcomeDto {
    fn from(value: RecordOutcome) -> Self {
        Self {
            outcome: match value {
                RecordOutcome::Accepted => "accepted",
                RecordOutcome::Dropped => "dropped",
                RecordOutcome::Invalid => "invalid",
                RecordOutcome::Disabled => "disabled",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fluxterm_performance_telemetry::{
        Message, MetricUnit, MetricWindow, StreamCorrelation, StreamKind, StreamParameter,
        StreamTarget, create_stream_descriptor, decode_datagram, gauge_metric,
    };
    use std::collections::BTreeMap;

    fn test_device() -> DeviceIdentity {
        DeviceIdentity {
            id: "27ec5c1f-73d8-45d6-a3dc-6242203fc777".into(),
            name: Some("WORKSTATION-01".into()),
        }
    }

    fn test_source() -> Source {
        Source {
            application: "fluxterm".into(),
            version: "test".into(),
            instance_id: "7d28b773-9bea-47a6-93a1-b52da63b74fa".into(),
            device: test_device(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            build_profile: "test".into(),
        }
    }

    fn test_stream(kind: StreamKind) -> StreamDescriptor {
        let parameters = if kind == StreamKind::RdpSession {
            BTreeMap::from([
                ("width".into(), StreamParameter::Unsigned(1920)),
                ("height".into(), StreamParameter::Unsigned(1080)),
                ("wallpaper".into(), StreamParameter::Bool(false)),
                ("fullWindowDrag".into(), StreamParameter::Bool(false)),
                ("menuAnimations".into(), StreamParameter::Bool(false)),
                ("theming".into(), StreamParameter::Bool(true)),
                ("cursorShadow".into(), StreamParameter::Bool(false)),
                ("cursorSettings".into(), StreamParameter::Bool(true)),
                ("fontSmoothing".into(), StreamParameter::Bool(true)),
                ("desktopComposition".into(), StreamParameter::Bool(true)),
            ])
        } else {
            BTreeMap::from([
                (
                    "chunkSizeBytes".into(),
                    StreamParameter::Unsigned(32 * 1024),
                ),
                ("requestWindow".into(), StreamParameter::Unsigned(8)),
                ("workerCount".into(), StreamParameter::Unsigned(1)),
            ])
        };
        create_stream_descriptor(
            kind,
            unix_time_ms(),
            parameters,
            StreamTarget {
                host: "server.internal".into(),
                port: if kind == StreamKind::RdpSession {
                    3389
                } else {
                    22
                },
            },
            StreamCorrelation {
                session_id: "31a0ae31-4116-4909-95be-0b81c1ab2ad9".into(),
                transfer_id: (kind != StreamKind::RdpSession).then(|| "sftp-1780000000000".into()),
            },
        )
    }

    #[test]
    fn accepts_only_loopback_and_private_addresses() {
        assert!(parse_private_destination("127.0.0.1:43190").is_ok());
        assert!(parse_private_destination("10.0.0.1:43190").is_ok());
        assert!(parse_private_destination("172.16.0.1:43190").is_ok());
        assert!(parse_private_destination("192.168.1.1:43190").is_ok());
        assert!(parse_private_destination("[::1]:43190").is_ok());
        assert!(parse_private_destination("[fd00::1]:43190").is_ok());
        assert!(parse_private_destination("8.8.8.8:43190").is_err());
        assert!(parse_private_destination("0.0.0.0:43190").is_err());
        assert!(parse_private_destination("169.254.1.1:43190").is_err());
        assert!(parse_private_destination("example.com:43190").is_err());
    }

    #[test]
    fn missing_config_is_disabled_and_unknown_fields_are_invalid() {
        let missing = std::env::temp_dir().join(format!(
            "fluxterm-performance-missing-{}.json",
            Uuid::new_v4()
        ));
        assert!(matches!(
            load_config_path(&missing),
            ConfigLoadResult::Disabled
        ));
        let raw = br#"{
            "schemaVersion": 1,
            "enabled": true,
            "destination": "127.0.0.1:43190",
            "intervalMs": 1000,
            "domains": ["sftp"],
            "unknown": true
        }"#;
        assert!(serde_json::from_slice::<RawConfig>(raw).is_err());
    }

    #[test]
    fn device_identity_is_created_and_reused() {
        let directory =
            std::env::temp_dir().join(format!("fluxterm-performance-device-{}", Uuid::new_v4()));
        let path = directory.join("performance-telemetry-device.json");
        let first = load_device_identity_path(&path, Some(" WORKSTATION-01 ".into()))
            .expect("create identity");
        let second = load_device_identity_path(&path, Some("WORKSTATION-02".into()))
            .expect("reuse identity");
        assert_eq!(first.id, second.id);
        assert_eq!(first.name.as_deref(), Some("WORKSTATION-01"));
        assert_eq!(second.name.as_deref(), Some("WORKSTATION-02"));
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn invalid_device_identity_is_rejected() {
        let directory = std::env::temp_dir().join(format!(
            "fluxterm-performance-device-invalid-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("fixture directory");
        let path = directory.join("performance-telemetry-device.json");
        fs::write(&path, br#"{"schemaVersion":1,"deviceId":"invalid"}"#).expect("fixture");
        assert!(load_device_identity_path(&path, None).is_err());
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn queue_overflow_drops_new_batches_without_blocking() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let counters = Arc::new(SenderCounters::default());
        let sink = ChannelSink {
            sender,
            source: test_source(),
            domains: BTreeSet::from([PerformanceDomain::Rdp]),
            interval_ms: 1000,
            streams: Arc::new(Mutex::new(HashMap::new())),
            counters: Arc::clone(&counters),
        };
        let first = sink.try_send(WorkerMessage::Open {
            stream: test_stream(StreamKind::RdpSession),
            datagram: Vec::new(),
        });
        let second = sink.try_send(WorkerMessage::Open {
            stream: test_stream(StreamKind::RdpSession),
            datagram: Vec::new(),
        });
        assert_eq!(first, RecordOutcome::Accepted);
        assert_eq!(second, RecordOutcome::Dropped);
        assert_eq!(counters.dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn full_queue_does_not_split_close_state_from_worker_state() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let counters = Arc::new(SenderCounters::default());
        let streams = Arc::new(Mutex::new(HashMap::new()));
        let sink = ChannelSink {
            sender,
            source: test_source(),
            domains: BTreeSet::from([PerformanceDomain::Rdp]),
            interval_ms: 1000,
            streams: Arc::clone(&streams),
            counters,
        };
        let stream = test_stream(StreamKind::RdpSession);
        let stream_id = stream.id.clone();
        assert_eq!(sink.open_stream(stream), RecordOutcome::Accepted);
        assert_eq!(
            sink.close_stream(&stream_id, StreamOutcome::Disconnected, unix_time_ms()),
            RecordOutcome::Dropped
        );
        assert!(streams.lock().expect("streams").contains_key(&stream_id));
    }

    #[test]
    fn sends_stream_lifecycle_and_snapshot_to_udp_receiver() {
        let receiver = UdpSocket::bind("127.0.0.1:0").expect("receiver");
        receiver
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("timeout");
        let service = PerformanceTelemetryService::start(
            PerformanceTelemetryConfig {
                destination: receiver.local_addr().expect("address"),
                interval_ms: 250,
                domains: BTreeSet::from([PerformanceDomain::Rdp]),
            },
            test_device(),
        )
        .expect("service");
        let sink = service.sink().expect("sink");
        let stream = test_stream(StreamKind::RdpSession);
        let stream_id = stream.id.clone();
        assert_eq!(sink.open_stream(stream), RecordOutcome::Accepted);

        let fps = gauge_metric(
            "fluxterm.rdp.renderer.fps",
            MetricUnit::FramePerSecond,
            60.0,
        );
        assert_eq!(
            sink.record_batch(MetricBatch {
                stream_id: stream_id.clone(),
                window: MetricWindow {
                    started_at_unix_ms: unix_time_ms().saturating_sub(1000),
                    duration_ms: 1000,
                },
                metrics: vec![fps],
            }),
            RecordOutcome::Accepted
        );
        assert_eq!(
            sink.close_stream(&stream_id, StreamOutcome::Disconnected, unix_time_ms()),
            RecordOutcome::Accepted
        );

        let mut messages = Vec::new();
        for _ in 0..3 {
            let mut buffer = [0_u8; 1200];
            let length = receiver.recv(&mut buffer).expect("datagram");
            messages.push(decode_datagram(&buffer[..length]).expect("shared protocol decode"));
        }
        assert!(matches!(messages[0], Message::StreamOpened(_)));
        assert!(matches!(messages[1], Message::MetricsSnapshot(_)));
        assert!(matches!(messages[2], Message::StreamClosed(_)));
        service.shutdown();
    }

    #[test]
    fn deserializes_frontend_metric_shape() {
        let batch: FrontendMetricBatch = serde_json::from_value(json!({
            "streamId": Uuid::new_v4().to_string(),
            "window": {
                "startedAtUnixMs": 1,
                "durationMs": 1000
            },
            "metrics": [{
                "name": "fluxterm.rdp.renderer.fps",
                "kind": "gauge",
                "unit": "{frame}/s",
                "value": 60,
                "attributes": {
                    "rendererMode": "worker",
                    "visibility": "visible",
                    "resolutionClass": "fullHd"
                }
            }]
        }))
        .expect("frontend batch");
        assert_eq!(batch.metrics.len(), 1);
    }
}
