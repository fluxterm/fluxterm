//! RDP 运行时统一埋点日志助手。

use fluxterm_telemetry::build_payload;
use log::{debug, error, info, warn};
use serde_json::Value;

/// RDP 运行时埋点级别。
pub enum TelemetryLevel {
    /// 开发诊断事件。
    Debug,
    /// 正常状态事件。
    Info,
    /// 可恢复异常事件。
    Warn,
    /// 运行时失败事件。
    Error,
}

/// 输出统一结构化埋点。
pub fn log_telemetry(level: TelemetryLevel, event: &str, fields: Value) {
    let line = build_payload(event, None, fields).to_string();
    match level {
        TelemetryLevel::Debug => debug!("{line}"),
        TelemetryLevel::Info => info!("{line}"),
        TelemetryLevel::Warn => warn!("{line}"),
        TelemetryLevel::Error => error!("{line}"),
    }
}
