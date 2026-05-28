//! # RDP 剪贴板重定向后端
//!
//! `cliprdr` 模块实现了 `ironrdp_cliprdr::backend::CliprdrBackend` trait，
//! 用于处理 RDP 会话中的剪贴板数据交换。
//!
//! 目前该模块主要聚焦于纯文本 (UTF-16) 的双向同步，并为未来扩展文件和图片同步预留了接口。

use ironrdp::core::AsAny;
use ironrdp_cliprdr::backend::CliprdrBackend;
use ironrdp_cliprdr::pdu::{
    ClipboardFormat, ClipboardGeneralCapabilityFlags, FileContentsRequest, FileContentsResponse,
    FormatDataRequest, FormatDataResponse, LockDataId,
};
use serde_json::json;
use tokio::sync::mpsc;

use crate::telemetry::{TelemetryLevel, log_telemetry};

/// FluxTerm 自定义的 RDP 剪贴板后端实现。
///
/// 该结构体通过 `proxy_tx` 将 RDP 协议栈触发的剪贴板事件转发给主事件循环处理。
#[derive(Debug)]
pub struct FluxCliprdrBackend {
    /// 用于向主异步任务发送剪贴板事件的通道。
    pub proxy_tx: mpsc::UnboundedSender<CliprdrProxyEvent>,
    /// 用于存放剪贴板临时文件的目录路径。
    pub temp_dir: String,
}

/// 剪贴板后端发送给主事件循环的代理事件。
#[derive(Debug)]
pub enum CliprdrProxyEvent {
    /// 剪贴板通道已就绪，或者服务器请求初始格式列表。
    NeedInitialSync { reason: &'static str },
    /// 远端宣告其支持的剪贴板格式列表。
    FormatList {
        reason: &'static str,
        formats: Vec<ClipboardFormat>,
    },
    /// 远端返回的具体剪贴板数据内容。
    DataResponse { reason: &'static str, data: Vec<u8> },
    /// 远端请求本地剪贴板的具体格式数据。
    DataRequest {
        reason: &'static str,
        request: FormatDataRequest,
    },
}

impl AsAny for FluxCliprdrBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl CliprdrBackend for FluxCliprdrBackend {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        // 目前仅声明基础能力，不启用高级文件锁
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {
        // 通道建立后，通知主循环进行初始同步
        log_telemetry(TelemetryLevel::Info, "rdp.cliprdr.backend.ready", json!({}));
        let _ = self.proxy_tx.send(CliprdrProxyEvent::NeedInitialSync {
            reason: "backend_ready",
        });
    }

    fn on_request_format_list(&mut self) {
        // 当服务器主动要求格式列表时，触发同步
        log_telemetry(
            TelemetryLevel::Info,
            "rdp.cliprdr.backend.request.format.list",
            json!({}),
        );
        let _ = self.proxy_tx.send(CliprdrProxyEvent::NeedInitialSync {
            reason: "remote_requested_format_list",
        });
    }

    fn on_process_negotiated_capabilities(&mut self, _: ClipboardGeneralCapabilityFlags) {}

    fn on_remote_copy(&mut self, formats: &[ClipboardFormat]) {
        // 当远端执行复制操作时，转发格式列表以触发后续的粘贴请求
        log_telemetry(
            TelemetryLevel::Debug,
            "rdp.cliprdr.backend.remote.copy",
            json!({ "formatCount": formats.len() }),
        );
        let _ = self.proxy_tx.send(CliprdrProxyEvent::FormatList {
            reason: "remote_copy",
            formats: formats.to_vec(),
        });
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        // 当远端执行粘贴操作时，请求本地提供数据
        log_telemetry(
            TelemetryLevel::Info,
            "rdp.cliprdr.backend.data.request",
            json!({ "format": format!("{:?}", request.format) }),
        );
        let _ = self.proxy_tx.send(CliprdrProxyEvent::DataRequest {
            reason: "remote_paste_request",
            request,
        });
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        // 当本地请求的远端数据到达时，转发给前端
        log_telemetry(
            TelemetryLevel::Info,
            "rdp.cliprdr.backend.data.response",
            json!({ "dataLen": response.data().len() }),
        );
        let _ = self.proxy_tx.send(CliprdrProxyEvent::DataResponse {
            reason: "remote_data_response",
            data: response.data().to_vec(),
        });
    }

    fn on_file_contents_request(&mut self, _: FileContentsRequest) {}

    fn on_file_contents_response(&mut self, _: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _: LockDataId) {}

    fn on_unlock(&mut self, _: LockDataId) {}
}
