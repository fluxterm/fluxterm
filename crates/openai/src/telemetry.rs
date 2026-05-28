//! OpenAI crate 埋点日志助手。
use fluxterm_telemetry::build_payload;
use log::{debug, error, info, warn};
use serde_json::Value;

/// 埋点级别。
pub enum TelemetryLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// 输出统一结构化埋点日志。
pub fn log_telemetry(level: TelemetryLevel, event: &str, trace_id: Option<&str>, fields: Value) {
    let line = build_payload(event, trace_id, fields).to_string();
    match level {
        TelemetryLevel::Debug => debug!("{line}"),
        TelemetryLevel::Info => info!("{line}"),
        TelemetryLevel::Warn => warn!("{line}"),
        TelemetryLevel::Error => error!("{line}"),
    }
}
