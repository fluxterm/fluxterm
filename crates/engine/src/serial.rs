//! 串口枚举与运行时会话管理。
//!
//! 串口会话保持原始字节边界，并通过独立事件交给前端决定终端解码和
//! 结构化监视器展示方式。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use encoding_rs::Encoding;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, oneshot};
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, SerialPortType, StopBits};
use uuid::Uuid;

use crate::error::EngineError;
use crate::types::{
    EngineEvent, EventCallback, SerialDataBits, SerialEncoding, SerialFlowControl, SerialParity,
    SerialPortInfo, SerialProfile, SerialStopBits, Session, SessionKind, SessionState,
};
use crate::util::{now_epoch, now_epoch_millis};

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

/// 已预留串口的生命周期守卫，确保任意退出路径都会释放端口占用标记。
struct SerialPortClaim {
    claimed_ports: Arc<Mutex<HashSet<String>>>,
    port_name: String,
}

impl Drop for SerialPortClaim {
    fn drop(&mut self) {
        if let Ok(mut claimed_ports) = self.claimed_ports.lock() {
            claimed_ports.remove(&self.port_name);
        }
    }
}

/// 串口会话管理器。
pub struct SerialManager {
    sessions: Arc<Mutex<HashMap<String, SerialSessionHandle>>>,
    claimed_ports: Arc<Mutex<HashSet<String>>>,
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
            claimed_ports: Arc::new(Mutex::new(HashSet::new())),
            runtime: Arc::new(Runtime::new().expect("failed to create serial runtime")),
        }
    }

    /// 枚举系统当前可见的串口。
    pub fn list_ports(&self) -> Result<Vec<SerialPortInfo>, EngineError> {
        let ports = tokio_serial::available_ports().map_err(|error| {
            EngineError::with_detail(
                "serial_port_list_failed",
                "无法枚举系统串口",
                error.to_string(),
            )
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
        profile: SerialProfile,
        profile_id: Option<String>,
        on_event: EventCallback,
    ) -> Result<Session, EngineError> {
        self.connect_with_opener(profile, profile_id, on_event, |profile| {
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
        validate_profile(&profile)?;
        let port_claim = self.claim_port(&profile.port_name)?;
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
        self.runtime.spawn(async move {
            let mut port_claim = Some(port_claim);
            // Windows 的 tokio-serial 在这里创建 Tokio Named Pipe；必须在持有
            // I/O reactor 的 runtime 任务中执行，不能提前在 Tauri 主线程打开。
            let mut port = match opener(&profile) {
                Ok(port) => port,
                Err(error) => {
                    // 先释放端口预留，再通知调用方失败；否则调用方立即重试时
                    // 可能在任务析构完成前短暂收到 serial_port_in_use。
                    drop(port_claim.take());
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let (tx, mut rx) = mpsc::unbounded_channel();
            let insert_result = sessions
                .lock()
                .map_err(|_| EngineError::new("serial_state_unavailable", "无法访问串口会话状态"))
                .map(|mut guard| {
                    guard.insert(task_session_id.clone(), SerialSessionHandle { tx });
                });
            if let Err(error) = insert_result {
                let _ = ready_tx.send(Err(error));
                return;
            }

            task_event(EngineEvent::SessionStatus {
                session_id: task_session_id.clone(),
                state: SessionState::Connected,
                error: None,
            });
            if ready_tx.send(Ok(session)).is_err() {
                if let Ok(mut guard) = sessions.lock() {
                    guard.remove(&task_session_id);
                }
                return;
            }

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
                                    "串口读取失败或设备已断开",
                                    error.to_string(),
                                ));
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
                                        "串口写入失败",
                                        error.to_string(),
                                    )
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
                                        "串口缓冲区刷新失败",
                                        error.to_string(),
                                    )
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
        ready_rx
            .await
            .map_err(|_| EngineError::new("serial_connect_task_failed", "串口连接任务意外结束"))?
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
            .map_err(|_| EngineError::new("serial_session_closed", "串口会话已经关闭"))?;
        response
            .await
            .map_err(|_| EngineError::new("serial_session_closed", "串口会话已经关闭"))?
    }

    /// 主动关闭串口会话。
    pub async fn disconnect(&self, session_id: &str) -> Result<(), EngineError> {
        let (respond_to, response) = oneshot::channel();
        self.sender(session_id)?
            .send(SerialCommand::Disconnect { respond_to })
            .map_err(|_| EngineError::new("serial_session_closed", "串口会话已经关闭"))?;
        response
            .await
            .map_err(|_| EngineError::new("serial_session_closed", "串口会话已经关闭"))?
    }

    fn sender(
        &self,
        session_id: &str,
    ) -> Result<mpsc::UnboundedSender<SerialCommand>, EngineError> {
        self.sessions
            .lock()
            .map_err(|_| EngineError::new("serial_state_unavailable", "无法访问串口会话状态"))?
            .get(session_id)
            .map(|handle| handle.tx.clone())
            .ok_or_else(|| EngineError::new("serial_session_not_found", "串口会话不存在"))
    }

    /// 原子预留端口，直到返回的守卫被释放。
    fn claim_port(&self, port_name: &str) -> Result<SerialPortClaim, EngineError> {
        let mut claimed_ports = self
            .claimed_ports
            .lock()
            .map_err(|_| EngineError::new("serial_state_unavailable", "无法访问串口会话状态"))?;
        if !claimed_ports.insert(port_name.to_string()) {
            return Err(EngineError::localized(
                "serial_port_in_use",
                format!("串口 {port_name} 已在会话中连接"),
                "error.serial.portInUse",
            )
            .with_message_vars(json!({ "portName": port_name })));
        }
        Ok(SerialPortClaim {
            claimed_ports: Arc::clone(&self.claimed_ports),
            port_name: port_name.to_string(),
        })
    }
}

/// 校验串口配置中的必填字段和波特率。
pub fn validate_profile(profile: &SerialProfile) -> Result<(), EngineError> {
    if profile.port_name.trim().is_empty() {
        return Err(EngineError::new("serial_port_required", "串口名称不能为空"));
    }
    if profile.baud_rate == 0 {
        return Err(EngineError::new(
            "serial_baud_rate_invalid",
            "串口波特率必须大于零",
        ));
    }
    Ok(())
}

fn encode_text(text: &str, encoding: SerialEncoding) -> Result<Vec<u8>, EngineError> {
    if encoding == SerialEncoding::Utf8 {
        return Ok(text.as_bytes().to_vec());
    }
    let encoding = Encoding::for_label(b"gb18030")
        .ok_or_else(|| EngineError::new("serial_encoding_unavailable", "GB18030 编码不可用"))?;
    let (encoded, _, had_errors) = encoding.encode(text);
    if had_errors {
        return Err(EngineError::new(
            "serial_text_encode_failed",
            "文本包含 GB18030 无法表示的字符",
        ));
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
    EngineError::with_detail(code, "无法打开目标串口", detail)
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
        for _ in 0..2 {
            let error = runtime
                .block_on(manager.connect_with_opener(
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
                    .as_deref()
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
    fn missing_port_returns_error_without_panicking() {
        let manager = SerialManager::new();
        let runtime = Arc::clone(&manager.runtime);
        let mut missing = profile();
        missing.port_name = "__fluxterm_missing_serial_port__".to_string();
        let error = runtime
            .block_on(manager.connect(missing, Some("serial-missing".to_string()), event_sink()))
            .expect_err("missing port should fail");
        assert_eq!(error.code, "serial_open_failed");
    }
}
