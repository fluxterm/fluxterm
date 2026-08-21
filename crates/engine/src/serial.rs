//! 串口枚举与运行时会话管理。
//!
//! 串口会话保持原始字节边界，并通过独立事件交给前端决定终端解码和
//! 结构化监视器展示方式。

const SERIAL_CONNECT_TASK_FAILED_CODE: &str = "serial_connect_task_failed";
const SERIAL_STATE_UNAVAILABLE_CODE: &str = "serial_state_unavailable";
const SERIAL_EXTERNAL_PORT_IN_USE_KEY: &str = "error.serial.externalPortInUse";
const SERIAL_OPEN_FAILED_KEY: &str = "error.serial.openFailed";

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use encoding_rs::Encoding;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Runtime;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, SerialPortType, StopBits};
use uuid::Uuid;

use crate::error::EngineError;
use crate::types::{
    EngineEvent, EventCallback, SerialDataBits, SerialEncoding, SerialFlowControl, SerialParity,
    SerialPortInfo, SerialProfile, SerialStopBits, Session, SessionKind, SessionState,
};
use crate::util::{now_epoch, now_epoch_millis};

const SERIAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

enum SerialCommand {
    Write {
        data: Vec<u8>,
        respond_to: oneshot::Sender<Result<(), EngineError>>,
    },
    Disconnect {
        respond_to: oneshot::Sender<Result<(), EngineError>>,
    },
}

#[derive(Clone)]
struct SerialSessionHandle {
    tx: mpsc::UnboundedSender<SerialCommand>,
}

/// 尚未完成的串口连接任务。
struct PendingSerialConnect {
    cancelled: AtomicBool,
    cancel_notified: Notify,
    #[cfg(windows)]
    worker_thread_handle: Mutex<Option<usize>>,
}

impl PendingSerialConnect {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            cancel_notified: Notify::new(),
            #[cfg(windows)]
            worker_thread_handle: Mutex::new(None),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// 端口占用所有者，释放通知用于串行衔接已取消任务后的下一次连接。
struct SerialPortOwner {
    operation_id: String,
    released: Arc<Notify>,
}

/// 已预留串口的生命周期守卫，确保仅由当前 operation 释放自己的占用标记。
struct SerialPortClaim {
    claimed_ports: Arc<Mutex<HashMap<String, SerialPortOwner>>>,
    port_name: String,
    operation_id: String,
    released: Arc<Notify>,
}

impl Drop for SerialPortClaim {
    fn drop(&mut self) {
        if let Ok(mut claimed_ports) = self.claimed_ports.lock() {
            let owned = claimed_ports
                .get(&self.port_name)
                .is_some_and(|owner| owner.operation_id == self.operation_id);
            if owned {
                claimed_ports.remove(&self.port_name);
                self.released.notify_one();
            }
        }
    }
}

/// 串口会话管理器。
pub struct SerialManager {
    sessions: Arc<Mutex<HashMap<String, SerialSessionHandle>>>,
    claimed_ports: Arc<Mutex<HashMap<String, SerialPortOwner>>>,
    pending_connects: Arc<Mutex<HashMap<String, Arc<PendingSerialConnect>>>>,
    runtime: Arc<Runtime>,
}

impl Default for SerialManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialManager {
    /// 创建串口会话管理器和独立异步运行时。
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            claimed_ports: Arc::new(Mutex::new(HashMap::new())),
            pending_connects: Arc::new(Mutex::new(HashMap::new())),
            runtime: Arc::new(Runtime::new().expect("failed to create serial runtime")),
        }
    }

    /// 枚举系统当前可见的串口。
    pub fn list_ports(&self) -> Result<Vec<SerialPortInfo>, EngineError> {
        let ports = tokio_serial::available_ports().map_err(|error| {
            EngineError::with_detail(
                "serial_port_list_failed",
                "Failed to enumerate system serial ports",
                error.to_string(),
            )
            .with_message_key("error.serial.portListFailed")
        })?;
        let mut result = ports
            .into_iter()
            .map(|port| {
                let mut info = SerialPortInfo {
                    port_name: port.port_name,
                    port_type: "unknown".to_string(),
                    vid: None,
                    pid: None,
                    serial_number: None,
                    manufacturer: None,
                    product: None,
                };
                match port.port_type {
                    SerialPortType::UsbPort(usb) => {
                        info.port_type = "usb".to_string();
                        info.vid = Some(usb.vid);
                        info.pid = Some(usb.pid);
                        info.serial_number = usb.serial_number;
                        info.manufacturer = usb.manufacturer;
                        info.product = usb.product;
                    }
                    SerialPortType::BluetoothPort => {
                        info.port_type = "bluetooth".to_string();
                    }
                    SerialPortType::PciPort => {
                        info.port_type = "pci".to_string();
                    }
                    SerialPortType::Unknown => {}
                }
                info
            })
            .collect::<Vec<_>>();
        result.sort_by(|left, right| left.port_name.cmp(&right.port_name));
        Ok(result)
    }

    /// 打开串口并启动异步收发循环。
    pub async fn connect(
        &self,
        operation_id: String,
        profile: SerialProfile,
        profile_id: Option<String>,
        on_event: EventCallback,
    ) -> Result<Session, EngineError> {
        self.connect_with_opener(operation_id, profile, profile_id, on_event, |profile| {
            let builder = tokio_serial::new(&profile.port_name, profile.baud_rate)
                .data_bits(to_data_bits(profile.data_bits))
                .stop_bits(to_stop_bits(profile.stop_bits))
                .parity(to_parity(profile.parity))
                .flow_control(to_flow_control(profile.flow_control));
            builder.open_native_async().map_err(map_open_error)
        })
        .await
    }

    /// 在串口专属 runtime 中打开端口并启动收发循环。
    async fn connect_with_opener<F>(
        &self,
        operation_id: String,
        profile: SerialProfile,
        profile_id: Option<String>,
        on_event: EventCallback,
        opener: F,
    ) -> Result<Session, EngineError>
    where
        F: FnOnce(&SerialProfile) -> Result<tokio_serial::SerialStream, EngineError>
            + Send
            + 'static,
    {
        self.connect_with_opener_timeout(
            operation_id,
            profile,
            profile_id,
            on_event,
            SERIAL_CONNECT_TIMEOUT,
            opener,
        )
        .await
    }

    /// 使用指定截止时间打开串口，便于验证超时与取消任务的竞态。
    async fn connect_with_opener_timeout<F>(
        &self,
        operation_id: String,
        profile: SerialProfile,
        profile_id: Option<String>,
        on_event: EventCallback,
        connect_timeout: Duration,
        opener: F,
    ) -> Result<Session, EngineError>
    where
        F: FnOnce(&SerialProfile) -> Result<tokio_serial::SerialStream, EngineError>
            + Send
            + 'static,
    {
        validate_profile(&profile)?;
        if operation_id.trim().is_empty() {
            return Err(EngineError::new(
                "serial_operation_id_required",
                "Serial connection operation id is required",
            ));
        }
        let pending = Arc::new(PendingSerialConnect::new());
        {
            let mut pending_connects = self
                .pending_connects
                .lock()
                .map_err(|_| serial_state_unavailable_error())?;
            if pending_connects.contains_key(&operation_id) {
                return Err(EngineError::new(
                    "serial_operation_conflict",
                    "Serial connection operation id is already active",
                ));
            }
            pending_connects.insert(operation_id.clone(), Arc::clone(&pending));
        }
        let connect_deadline = tokio::time::Instant::now() + connect_timeout;
        let claim_result = tokio::select! {
            biased;
            result = self.claim_port(&profile.port_name, &operation_id, &pending) => result,
            _ = tokio::time::sleep_until(connect_deadline) => {
                mark_pending_cancelled(&pending);
                Err(serial_connect_timeout_error())
            }
        };
        let port_claim = match claim_result {
            Ok(claim) => claim,
            Err(error) => {
                self.remove_pending_connect(&operation_id, &pending);
                return Err(error);
            }
        };
        let session_id = Uuid::new_v4().to_string();
        let session = Session {
            session_id: session_id.clone(),
            profile_id,
            kind: SessionKind::Serial,
            state: SessionState::Connected,
            created_at: now_epoch(),
            last_error: None,
        };
        let (ready_tx, ready_rx) = oneshot::channel();
        let sessions = Arc::clone(&self.sessions);
        let task_session_id = session_id.clone();
        let task_event = Arc::clone(&on_event);
        let task_operation_id = operation_id.clone();
        let pending_connects = Arc::clone(&self.pending_connects);
        let runtime_handle = self.runtime.handle().clone();
        let timeout_pending = Arc::clone(&pending);
        self.runtime.spawn(async move {
            let mut port_claim = Some(port_claim);
            let (open_tx, open_rx) = oneshot::channel();
            let (start_tx, start_rx) = std::sync::mpsc::sync_channel(0);
            let worker_pending = Arc::clone(&pending);
            let worker = std::thread::spawn(move || {
                if start_rx.recv().is_err() {
                    return;
                }
                // Windows 的 tokio-serial 创建 Tokio Named Pipe 时需要可见的 I/O reactor。
                let _runtime_guard = runtime_handle.enter();
                let result = if worker_pending.is_cancelled() {
                    Err(serial_connect_cancelled_error())
                } else {
                    opener(&profile)
                };
                let _ = open_tx.send(result);
            });
            #[cfg(windows)]
            if let Ok(mut handle) = pending.worker_thread_handle.lock() {
                use std::os::windows::io::AsRawHandle;
                *handle = Some(worker.as_raw_handle() as usize);
            }
            let _ = start_tx.send(());
            let open_result = open_rx.await.unwrap_or_else(|_| {
                Err(EngineError::localized(
                    SERIAL_CONNECT_TASK_FAILED_CODE,
                    "The serial connection task ended unexpectedly",
                    "error.serial.connectTaskFailed",
                ))
            });
            // 先撤销共享句柄，再消费 JoinHandle，避免取消路径读取已关闭的 Windows HANDLE。
            #[cfg(windows)]
            if let Ok(mut handle) = pending.worker_thread_handle.lock() {
                *handle = None;
            }
            let _ = worker.join();
            let mut port = match open_result {
                Ok(port) => port,
                Err(error) => {
                    drop(port_claim.take());
                    remove_pending_connect_entry(
                        &pending_connects,
                        &task_operation_id,
                        &pending,
                    );
                    let result = if pending.is_cancelled() {
                        Err(serial_connect_cancelled_error())
                    } else {
                        Err(error)
                    };
                    let _ = ready_tx.send(result);
                    return;
                }
            };
            if pending.is_cancelled() {
                drop(port);
                drop(port_claim.take());
                remove_pending_connect_entry(&pending_connects, &task_operation_id, &pending);
                let _ = ready_tx.send(Err(serial_connect_cancelled_error()));
                return;
            }
            let (tx, mut rx) = mpsc::unbounded_channel();
            let insert_result = sessions
                .lock()
                .map_err(|_| {
                    EngineError::localized(
                        SERIAL_STATE_UNAVAILABLE_CODE,
                        "Serial session state is unavailable",
                        "error.serial.stateUnavailable",
                    )
                })
                .map(|mut guard| {
                    guard.insert(task_session_id.clone(), SerialSessionHandle { tx });
                });
            if let Err(error) = insert_result {
                remove_pending_connect_entry(&pending_connects, &task_operation_id, &pending);
                let _ = ready_tx.send(Err(error));
                return;
            }
            remove_pending_connect_entry(&pending_connects, &task_operation_id, &pending);

            // 调用方可能已经因超时丢弃接收端；只有确认其接受会话后才能发布 Connected。
            if ready_tx.send(Ok(session)).is_err() {
                if let Ok(mut guard) = sessions.lock() {
                    guard.remove(&task_session_id);
                }
                return;
            }
            task_event(EngineEvent::SessionStatus {
                session_id: task_session_id.clone(),
                state: SessionState::Connected,
                error: None,
            });

            let mut buffer = vec![0_u8; 4096];
            let mut final_error: Option<EngineError> = None;
            let mut requested_disconnect = false;
            loop {
                tokio::select! {
                    read_result = port.read(&mut buffer) => {
                        match read_result {
                            Ok(0) => continue,
                            Ok(length) => task_event(EngineEvent::SerialOutput {
                                session_id: task_session_id.clone(),
                                data: buffer[..length].to_vec(),
                                received_at: now_epoch_millis(),
                            }),
                            Err(error) => {
                                final_error = Some(EngineError::with_detail(
                                    "serial_read_failed",
                                    "Failed to read from the serial port or the device was disconnected",
                                    error.to_string(),
                                ).with_message_key("error.serial.readFailed"));
                                break;
                            }
                        }
                    }
                    command = rx.recv() => {
                        match command {
                            Some(SerialCommand::Write { data, respond_to }) => {
                                let result = port.write_all(&data).await.map_err(|error| {
                                    EngineError::with_detail(
                                        "serial_write_failed",
                                        "Failed to write to the serial port",
                                        error.to_string(),
                                    )
                                    .with_message_key("error.serial.writeFailed")
                                });
                                let failed = result.as_ref().err().cloned();
                                let _ = respond_to.send(result);
                                if let Some(error) = failed {
                                    final_error = Some(error);
                                    break;
                                }
                            }
                            Some(SerialCommand::Disconnect { respond_to }) => {
                                requested_disconnect = true;
                                let result = port.flush().await.map_err(|error| {
                                    EngineError::with_detail(
                                        "serial_flush_failed",
                                        "Failed to flush the serial port buffer",
                                        error.to_string(),
                                    )
                                    .with_message_key("error.serial.flushFailed")
                                });
                                let _ = respond_to.send(result);
                                break;
                            }
                            None => break,
                        }
                    }
                }
            }
            if let Ok(mut guard) = sessions.lock() {
                guard.remove(&task_session_id);
            }
            // 在发布最终状态前先关闭系统句柄并释放预留，确保 UI 收到断开
            // 状态后可以立即重新连接同一端口。
            drop(port);
            drop(port_claim.take());
            if let Some(error) = final_error {
                task_event(EngineEvent::SessionStatus {
                    session_id: task_session_id,
                    state: SessionState::Error,
                    error: Some(error),
                });
            } else {
                task_event(EngineEvent::SessionStatus {
                    session_id: task_session_id.clone(),
                    state: SessionState::Disconnected,
                    error: None,
                });
                if !requested_disconnect {
                    task_event(EngineEvent::TerminalExit {
                        session_id: task_session_id,
                    });
                }
            }
        });
        tokio::select! {
            biased;
            result = ready_rx => result.map_err(|_| {
                EngineError::localized(
                    SERIAL_CONNECT_TASK_FAILED_CODE,
                    "The serial connection task ended unexpectedly",
                    "error.serial.connectTaskFailed",
                )
            })?,
            _ = tokio::time::sleep_until(connect_deadline) => {
                mark_pending_cancelled(&timeout_pending);
                Err(serial_connect_timeout_error())
            }
        }
    }

    /// 取消尚未完成的串口连接任务；重复取消保持幂等。
    pub fn cancel_connect(&self, operation_id: &str) -> Result<bool, EngineError> {
        let pending = self
            .pending_connects
            .lock()
            .map_err(|_| serial_state_unavailable_error())?
            .get(operation_id)
            .cloned();
        let Some(pending) = pending else {
            return Ok(false);
        };
        mark_pending_cancelled(&pending);
        Ok(true)
    }

    /// 将文本按会话配置的编码写入串口。
    pub async fn write_text(
        &self,
        session_id: &str,
        text: String,
        encoding: SerialEncoding,
    ) -> Result<Vec<u8>, EngineError> {
        let data = encode_text(&text, encoding)?;
        self.write_binary(session_id, data.clone()).await?;
        Ok(data)
    }

    /// 将原始字节写入串口。
    pub async fn write_binary(&self, session_id: &str, data: Vec<u8>) -> Result<(), EngineError> {
        let (respond_to, response) = oneshot::channel();
        self.sender(session_id)?
            .send(SerialCommand::Write { data, respond_to })
            .map_err(|_| serial_session_closed_error())?;
        response.await.map_err(|_| serial_session_closed_error())?
    }

    /// 主动关闭串口会话。
    pub async fn disconnect(&self, session_id: &str) -> Result<(), EngineError> {
        let (respond_to, response) = oneshot::channel();
        self.sender(session_id)?
            .send(SerialCommand::Disconnect { respond_to })
            .map_err(|_| serial_session_closed_error())?;
        response.await.map_err(|_| serial_session_closed_error())?
    }

    fn sender(
        &self,
        session_id: &str,
    ) -> Result<mpsc::UnboundedSender<SerialCommand>, EngineError> {
        self.sessions
            .lock()
            .map_err(|_| serial_state_unavailable_error())?
            .get(session_id)
            .map(|handle| handle.tx.clone())
            .ok_or_else(|| {
                EngineError::localized(
                    "serial_session_not_found",
                    "Serial session not found",
                    "error.serial.sessionNotFound",
                )
            })
    }

    /// 原子预留端口；若旧所有者已取消，则等待其释放后接续连接。
    async fn claim_port(
        &self,
        port_name: &str,
        operation_id: &str,
        pending: &PendingSerialConnect,
    ) -> Result<SerialPortClaim, EngineError> {
        loop {
            if pending.is_cancelled() {
                return Err(serial_connect_cancelled_error());
            }
            let wait_for_release = {
                let mut claimed_ports = self
                    .claimed_ports
                    .lock()
                    .map_err(|_| serial_state_unavailable_error())?;
                let Some(owner) = claimed_ports.get(port_name) else {
                    let released = Arc::new(Notify::new());
                    claimed_ports.insert(
                        port_name.to_string(),
                        SerialPortOwner {
                            operation_id: operation_id.to_string(),
                            released: Arc::clone(&released),
                        },
                    );
                    return Ok(SerialPortClaim {
                        claimed_ports: Arc::clone(&self.claimed_ports),
                        port_name: port_name.to_string(),
                        operation_id: operation_id.to_string(),
                        released,
                    });
                };
                let owner_cancelled = self
                    .pending_connects
                    .lock()
                    .map_err(|_| serial_state_unavailable_error())?
                    .get(&owner.operation_id)
                    .is_some_and(|owner_pending| owner_pending.is_cancelled());
                if !owner_cancelled {
                    return Err(serial_port_in_use_error(port_name));
                }
                Arc::clone(&owner.released).notified_owned()
            };
            tokio::select! {
                _ = wait_for_release => {}
                _ = pending.cancel_notified.notified() => {
                    return Err(serial_connect_cancelled_error());
                }
            }
        }
    }

    fn remove_pending_connect(&self, operation_id: &str, pending: &Arc<PendingSerialConnect>) {
        remove_pending_connect_entry(&self.pending_connects, operation_id, pending);
    }
}

fn remove_pending_connect_entry(
    pending_connects: &Mutex<HashMap<String, Arc<PendingSerialConnect>>>,
    operation_id: &str,
    pending: &Arc<PendingSerialConnect>,
) {
    if let Ok(mut entries) = pending_connects.lock()
        && entries
            .get(operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, pending))
    {
        entries.remove(operation_id);
    }
}

#[cfg(windows)]
fn cancel_pending_worker(pending: &PendingSerialConnect) {
    use windows_sys::Win32::System::IO::CancelSynchronousIo;

    if let Ok(handle) = pending.worker_thread_handle.lock()
        && let Some(handle) = *handle
    {
        // SAFETY: 持锁期间 JoinHandle 不会被释放；该句柄仅用于取消工作线程当前同步 I/O。
        unsafe {
            CancelSynchronousIo(handle as *mut core::ffi::c_void);
        }
    }
}

#[cfg(not(windows))]
fn cancel_pending_worker(_pending: &PendingSerialConnect) {}

/// 标记连接任务已取消，并尽力中断工作线程中尚未完成的同步打开调用。
fn mark_pending_cancelled(pending: &PendingSerialConnect) {
    pending.cancelled.store(true, Ordering::SeqCst);
    pending.cancel_notified.notify_one();
    cancel_pending_worker(pending);
}

fn serial_connect_cancelled_error() -> EngineError {
    EngineError::new(
        "serial_connect_cancelled",
        "Serial connection was cancelled",
    )
}

fn serial_connect_timeout_error() -> EngineError {
    EngineError::localized(
        "serial_connect_timeout",
        "The serial connection timed out after 5 seconds",
        "error.serial.connectTimeout",
    )
}

fn serial_port_in_use_error(port_name: &str) -> EngineError {
    EngineError::localized(
        "serial_port_in_use",
        format!("Serial port {port_name} is already connected in a session"),
        "error.serial.portInUse",
    )
    .with_message_vars(crate::error::MessageVars::from([(
        "portName".to_string(),
        crate::error::MessageVar::from(port_name),
    )]))
}

/// 校验串口配置中的必填字段和波特率。
pub fn validate_profile(profile: &SerialProfile) -> Result<(), EngineError> {
    if profile.port_name.trim().is_empty() {
        return Err(EngineError::localized(
            "serial_port_required",
            "Serial port name is required",
            "error.serial.portRequired",
        ));
    }
    if profile.baud_rate == 0 {
        return Err(EngineError::new(
            "serial_baud_rate_invalid",
            "Serial baud rate must be greater than zero",
        )
        .with_message_key("error.serial.baudRateInvalid"));
    }
    Ok(())
}

fn encode_text(text: &str, encoding: SerialEncoding) -> Result<Vec<u8>, EngineError> {
    if encoding == SerialEncoding::Utf8 {
        return Ok(text.as_bytes().to_vec());
    }
    let encoding = Encoding::for_label(b"gb18030").ok_or_else(|| {
        EngineError::localized(
            "serial_encoding_unavailable",
            "GB18030 encoding is unavailable",
            "error.serial.encodingUnavailable",
        )
    })?;
    let (encoded, _, had_errors) = encoding.encode(text);
    if had_errors {
        return Err(EngineError::new(
            "serial_text_encode_failed",
            "The text contains characters that cannot be represented in GB18030",
        )
        .with_message_key("error.serial.textEncodeFailed"));
    }
    Ok(encoded.into_owned())
}

fn map_open_error(error: tokio_serial::Error) -> EngineError {
    let detail = error.to_string();
    let normalized = detail.to_ascii_lowercase();
    let code = if normalized.contains("access is denied")
        || normalized.contains("permission denied")
        || normalized.contains("resource busy")
    {
        "serial_port_in_use"
    } else {
        "serial_open_failed"
    };
    let error = EngineError::with_detail(code, "Failed to open the target serial port", detail);
    if code == "serial_port_in_use" {
        error.with_message_key(SERIAL_EXTERNAL_PORT_IN_USE_KEY)
    } else {
        error.with_message_key(SERIAL_OPEN_FAILED_KEY)
    }
}

fn serial_state_unavailable_error() -> EngineError {
    EngineError::localized(
        SERIAL_STATE_UNAVAILABLE_CODE,
        "Serial session state is unavailable",
        "error.serial.stateUnavailable",
    )
}

fn serial_session_closed_error() -> EngineError {
    EngineError::localized(
        "serial_session_closed",
        "Serial session is already closed",
        "error.serial.sessionClosed",
    )
}

fn to_data_bits(value: SerialDataBits) -> DataBits {
    match value {
        SerialDataBits::Five => DataBits::Five,
        SerialDataBits::Six => DataBits::Six,
        SerialDataBits::Seven => DataBits::Seven,
        SerialDataBits::Eight => DataBits::Eight,
    }
}

fn to_stop_bits(value: SerialStopBits) -> StopBits {
    match value {
        SerialStopBits::One => StopBits::One,
        SerialStopBits::Two => StopBits::Two,
    }
}

fn to_parity(value: SerialParity) -> Parity {
    match value {
        SerialParity::None => Parity::None,
        SerialParity::Odd => Parity::Odd,
        SerialParity::Even => Parity::Even,
    }
}

fn to_flow_control(value: SerialFlowControl) -> FlowControl {
    match value {
        SerialFlowControl::None => FlowControl::None,
        SerialFlowControl::Software => FlowControl::Software,
        SerialFlowControl::Hardware => FlowControl::Hardware,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SerialLineEnding, SerialProfile};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    fn event_sink() -> EventCallback {
        Arc::new(|_| {})
    }

    fn open_error() -> EngineError {
        EngineError::new("serial_open_failed", "test open failure")
    }

    fn profile() -> SerialProfile {
        SerialProfile {
            id: "serial-1".to_string(),
            name: "Debug UART".to_string(),
            port_name: "COM1".to_string(),
            baud_rate: 115_200,
            data_bits: SerialDataBits::Eight,
            stop_bits: SerialStopBits::One,
            parity: SerialParity::None,
            flow_control: SerialFlowControl::None,
            encoding: SerialEncoding::Utf8,
            line_ending: SerialLineEnding::Crlf,
            tags: None,
        }
    }

    #[test]
    fn loads_legacy_profile_without_tags_and_ignores_local_echo() {
        let profile: SerialProfile = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "name": "Legacy COM",
            "portName": "COM9",
            "baudRate": 115200,
            "dataBits": "eight",
            "stopBits": "one",
            "parity": "none",
            "flowControl": "none",
            "encoding": "utf8",
            "lineEnding": "crlf",
            "localEcho": true
        }))
        .expect("旧版串口配置应继续可读");
        assert_eq!(profile.tags, None);
    }

    #[test]
    fn validates_required_serial_fields() {
        assert!(validate_profile(&profile()).is_ok());
        let mut invalid = profile();
        invalid.port_name.clear();
        assert_eq!(
            validate_profile(&invalid)
                .expect_err("port should be required")
                .code,
            "serial_port_required"
        );
        invalid.port_name = "COM1".to_string();
        invalid.baud_rate = 0;
        assert_eq!(
            validate_profile(&invalid)
                .expect_err("baud should be valid")
                .code,
            "serial_baud_rate_invalid"
        );
    }

    #[test]
    fn accepts_supported_serial_parameter_combinations() {
        let data_bits = [
            SerialDataBits::Five,
            SerialDataBits::Six,
            SerialDataBits::Seven,
            SerialDataBits::Eight,
        ];
        let stop_bits = [SerialStopBits::One, SerialStopBits::Two];
        let parity = [SerialParity::None, SerialParity::Odd, SerialParity::Even];
        let flow_control = [
            SerialFlowControl::None,
            SerialFlowControl::Software,
            SerialFlowControl::Hardware,
        ];
        for data_bits in data_bits {
            for stop_bits in stop_bits {
                for parity in parity {
                    for flow_control in flow_control {
                        let mut candidate = profile();
                        candidate.data_bits = data_bits;
                        candidate.stop_bits = stop_bits;
                        candidate.parity = parity;
                        candidate.flow_control = flow_control;
                        assert!(validate_profile(&candidate).is_ok());
                    }
                }
            }
        }
    }

    #[test]
    fn encodes_utf8_and_gb18030_text() {
        assert_eq!(
            encode_text("串口", SerialEncoding::Utf8).expect("utf8 should encode"),
            "串口".as_bytes()
        );
        let encoded = encode_text("串口", SerialEncoding::Gb18030).expect("gb18030 should encode");
        assert!(!encoded.is_empty());
        assert_ne!(encoded, "串口".as_bytes());
    }

    #[test]
    fn executes_serial_opener_inside_owned_runtime() {
        let manager = SerialManager::new();
        let runtime = Arc::clone(&manager.runtime);
        let observed_runtime = Arc::new(AtomicBool::new(false));
        let task_observed_runtime = Arc::clone(&observed_runtime);
        let error = runtime
            .block_on(manager.connect_with_opener(
                "operation-runtime".to_string(),
                profile(),
                Some("serial-1".to_string()),
                event_sink(),
                move |_| {
                    task_observed_runtime.store(
                        tokio::runtime::Handle::try_current().is_ok(),
                        Ordering::SeqCst,
                    );
                    Err(open_error())
                },
            ))
            .expect_err("mocked opening should fail");
        assert_eq!(error.code, "serial_open_failed");
        assert!(observed_runtime.load(Ordering::SeqCst));
    }

    #[test]
    fn opening_failure_releases_port_claim() {
        let manager = SerialManager::new();
        let runtime = Arc::clone(&manager.runtime);
        for attempt in 0..2 {
            let error = runtime
                .block_on(manager.connect_with_opener(
                    format!("operation-failure-{attempt}"),
                    profile(),
                    Some("serial-1".to_string()),
                    event_sink(),
                    |_| Err(open_error()),
                ))
                .expect_err("mocked opening should fail");
            assert_eq!(error.code, "serial_open_failed");
        }
    }

    #[test]
    fn opening_timeout_cancels_task_and_releases_port_claim() {
        let manager = SerialManager::new();
        let runtime = Arc::clone(&manager.runtime);
        let error = runtime
            .block_on(manager.connect_with_opener_timeout(
                "operation-timeout".to_string(),
                profile(),
                Some("serial-1".to_string()),
                event_sink(),
                Duration::from_millis(20),
                |_| {
                    std::thread::sleep(Duration::from_millis(80));
                    Err(open_error())
                },
            ))
            .expect_err("slow opening should time out");
        assert_eq!(error.code, "serial_connect_timeout");
        assert_eq!(
            error.message_key.as_deref(),
            Some("error.serial.connectTimeout")
        );

        for _ in 0..100 {
            let finished = manager
                .pending_connects
                .lock()
                .expect("pending state should be available")
                .get("operation-timeout")
                .is_none();
            if finished {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            manager
                .pending_connects
                .lock()
                .expect("pending state should be available")
                .get("operation-timeout")
                .is_none(),
            "timed out operation should eventually be cleaned up"
        );

        let retry_error = runtime
            .block_on(manager.connect_with_opener(
                "operation-after-timeout".to_string(),
                profile(),
                Some("serial-1".to_string()),
                event_sink(),
                |_| Err(open_error()),
            ))
            .expect_err("mocked retry should reach its opener");
        assert_eq!(retry_error.code, "serial_open_failed");
    }

    #[test]
    fn reconnect_timeout_includes_waiting_for_cancelled_port_claim() {
        let manager = Arc::new(SerialManager::new());
        let runtime = Arc::clone(&manager.runtime);
        runtime.block_on(async {
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let first_manager = Arc::clone(&manager);
            let first = tokio::spawn(async move {
                first_manager
                    .connect_with_opener_timeout(
                        "operation-timeout-owner".to_string(),
                        profile(),
                        Some("serial-1".to_string()),
                        event_sink(),
                        Duration::from_secs(2),
                        move |_| {
                            started_tx.send(()).expect("start signal should send");
                            release_rx.recv().expect("release signal should arrive");
                            Err(open_error())
                        },
                    )
                    .await
            });
            started_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("first connection should enter opener");
            assert!(
                manager
                    .cancel_connect("operation-timeout-owner")
                    .expect("owner cancellation should succeed")
            );

            let retry_error = tokio::time::timeout(
                Duration::from_millis(200),
                manager.connect_with_opener_timeout(
                    "operation-timeout-waiter".to_string(),
                    profile(),
                    Some("serial-1".to_string()),
                    event_sink(),
                    Duration::from_millis(20),
                    |_| -> Result<tokio_serial::SerialStream, EngineError> {
                        panic!("retry opener must not run before the old claim is released")
                    },
                ),
            )
            .await
            .expect("retry should honor its own total deadline")
            .expect_err("retry should time out while waiting for the old claim");
            assert_eq!(retry_error.code, "serial_connect_timeout");
            assert!(
                manager
                    .pending_connects
                    .lock()
                    .expect("pending state should be available")
                    .get("operation-timeout-waiter")
                    .is_none(),
                "timed out waiter should be removed immediately"
            );

            release_tx.send(()).expect("release signal should send");
            let first_error = first
                .await
                .expect("cancelled owner task should finish")
                .expect_err("cancelled owner must not connect");
            assert_eq!(first_error.code, "serial_connect_cancelled");
        });
    }

    #[test]
    fn concurrent_connect_rejects_already_claimed_port() {
        let manager = Arc::new(SerialManager::new());
        let runtime = Arc::clone(&manager.runtime);
        runtime.block_on(async {
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let first_manager = Arc::clone(&manager);
            let first = tokio::spawn(async move {
                first_manager
                    .connect_with_opener(
                        "operation-concurrent-first".to_string(),
                        profile(),
                        Some("serial-1".to_string()),
                        event_sink(),
                        move |_| {
                            started_tx.send(()).expect("start signal should send");
                            release_rx.recv().expect("release signal should arrive");
                            Err(open_error())
                        },
                    )
                    .await
            });
            started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("first connection should claim the port");

            let second_error = manager
                .connect_with_opener(
                    "operation-concurrent-second".to_string(),
                    profile(),
                    Some("serial-1".to_string()),
                    event_sink(),
                    |_| -> Result<tokio_serial::SerialStream, EngineError> {
                        panic!("second opener must not run")
                    },
                )
                .await
                .expect_err("second connection should be rejected");
            assert_eq!(second_error.code, "serial_port_in_use");
            assert_eq!(
                second_error.message_key.as_deref(),
                Some("error.serial.portInUse")
            );
            assert_eq!(
                second_error
                    .message_vars
                    .as_ref()
                    .and_then(|vars| vars.get("portName"))
                    .and_then(|value| value.as_str()),
                Some("COM1")
            );

            release_tx.send(()).expect("release signal should send");
            let first_error = first
                .await
                .expect("first task should finish")
                .expect_err("mocked first opening should fail");
            assert_eq!(first_error.code, "serial_open_failed");
        });
    }

    #[test]
    fn cancelled_connect_allows_waiting_reconnect_after_owned_claim_releases() {
        let manager = Arc::new(SerialManager::new());
        let runtime = Arc::clone(&manager.runtime);
        runtime.block_on(async {
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let first_manager = Arc::clone(&manager);
            let first = tokio::spawn(async move {
                first_manager
                    .connect_with_opener(
                        "operation-cancelled".to_string(),
                        profile(),
                        Some("serial-1".to_string()),
                        event_sink(),
                        move |_| {
                            started_tx.send(()).expect("start signal should send");
                            release_rx.recv().expect("release signal should arrive");
                            Err(open_error())
                        },
                    )
                    .await
            });
            started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("first connection should enter opener");

            assert!(
                manager
                    .cancel_connect("operation-cancelled")
                    .expect("cancel should succeed")
            );
            assert!(
                manager
                    .cancel_connect("operation-cancelled")
                    .expect("repeated cancel should stay idempotent")
            );

            let reconnect_started = Arc::new(AtomicBool::new(false));
            let reconnect_flag = Arc::clone(&reconnect_started);
            let second_manager = Arc::clone(&manager);
            let mut second = tokio::spawn(async move {
                second_manager
                    .connect_with_opener(
                        "operation-reconnect".to_string(),
                        profile(),
                        Some("serial-1".to_string()),
                        event_sink(),
                        move |_| {
                            reconnect_flag.store(true, Ordering::SeqCst);
                            Err(open_error())
                        },
                    )
                    .await
            });
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut second)
                    .await
                    .is_err(),
                "reconnect should wait for the cancelled owner to release the port"
            );
            assert!(!reconnect_started.load(Ordering::SeqCst));

            release_tx.send(()).expect("release signal should send");
            let first_error = first
                .await
                .expect("cancelled task should finish")
                .expect_err("cancelled connection must not succeed");
            assert_eq!(first_error.code, "serial_connect_cancelled");
            let second_error = second
                .await
                .expect("reconnect task should finish")
                .expect_err("mocked reconnect should fail in opener");
            assert_eq!(second_error.code, "serial_open_failed");
            assert!(reconnect_started.load(Ordering::SeqCst));
            assert!(
                !manager
                    .cancel_connect("operation-cancelled")
                    .expect("finished operation should be absent")
            );
        });
    }

    #[test]
    fn missing_port_returns_error_without_panicking() {
        let manager = SerialManager::new();
        let runtime = Arc::clone(&manager.runtime);
        let mut missing = profile();
        missing.port_name = "__fluxterm_missing_serial_port__".to_string();
        let error = runtime
            .block_on(manager.connect(
                "operation-missing".to_string(),
                missing,
                Some("serial-missing".to_string()),
                event_sink(),
            ))
            .expect_err("missing port should fail");
        assert_eq!(error.code, "serial_open_failed");
    }
}
