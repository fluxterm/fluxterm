//! 全局代理相关命令。
use std::sync::Arc;

use engine::{Engine, EngineError, ProxyRuntime, ProxySpec};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::events::build_event_bridge;
use crate::state::EngineState;
use crate::telemetry::{TelemetryLevel, log_telemetry};

#[tauri::command]
/// 创建全局代理实例。
pub async fn proxy_open(
    app: AppHandle,
    state: State<'_, EngineState>,
    spec: ProxySpec,
    trace_id: Option<String>,
) -> Result<ProxyRuntime, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    let on_event = build_event_bridge(app);
    log_telemetry(
        TelemetryLevel::Debug,
        "proxy.create.start",
        trace_id.as_deref(),
        json!({
            "protocol": spec.protocol,
            "bindHost": spec.bind_host,
            "bindPort": spec.bind_port,
            "authEnabled": spec.auth.is_some(),
        }),
    );
    let result = tauri::async_runtime::spawn_blocking({
        let spec = spec.clone();
        let trace_id = trace_id.clone();
        move || engine.proxy_open(spec, on_event, trace_id.as_deref())
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            "session_command_failed",
            "Failed to create the proxy instance",
            err.to_string(),
        )
    })?;
    match result {
        Ok(runtime) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "proxy.create.success",
                trace_id.as_deref(),
                json!({
                    "proxyId": runtime.proxy_id,
                    "protocol": runtime.protocol,
                    "bindHost": runtime.bind_host,
                    "bindPort": runtime.bind_port,
                }),
            );
            Ok(runtime)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "proxy.create.failed",
                trace_id.as_deref(),
                json!({
                    "protocol": spec.protocol,
                    "bindHost": spec.bind_host,
                    "bindPort": spec.bind_port,
                    "error": {
                        "code": err.code,
                        "message": err.message,
                        "detail": err.detail,
                    }
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 关闭指定代理实例。
pub async fn proxy_close(
    state: State<'_, EngineState>,
    proxy_id: String,
    trace_id: Option<String>,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    log_telemetry(
        TelemetryLevel::Debug,
        "proxy.close.start",
        trace_id.as_deref(),
        json!({
            "proxyId": proxy_id,
        }),
    );
    let result = tauri::async_runtime::spawn_blocking({
        let proxy_id = proxy_id.clone();
        let trace_id = trace_id.clone();
        move || engine.proxy_close(&proxy_id, trace_id.as_deref())
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            "session_command_failed",
            "Failed to close the proxy instance",
            err.to_string(),
        )
    })?;
    match result {
        Ok(()) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "proxy.close.success",
                trace_id.as_deref(),
                json!({
                    "proxyId": proxy_id,
                }),
            );
            Ok(())
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "proxy.close.failed",
                trace_id.as_deref(),
                json!({
                    "proxyId": proxy_id,
                    "error": {
                        "code": err.code,
                        "message": err.message,
                        "detail": err.detail,
                    }
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 获取全部代理实例。
pub async fn proxy_list(
    state: State<'_, EngineState>,
    trace_id: Option<String>,
) -> Result<Vec<ProxyRuntime>, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    let result = tauri::async_runtime::spawn_blocking(move || engine.proxy_list())
        .await
        .map_err(|err| {
            EngineError::with_detail(
                "session_command_failed",
                "Failed to list proxy instances",
                err.to_string(),
            )
        })?;
    match result {
        Ok(list) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "proxy.list.success",
                trace_id.as_deref(),
                json!({
                    "count": list.len(),
                }),
            );
            Ok(list)
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "proxy.list.failed",
                trace_id.as_deref(),
                json!({
                    "error": {
                        "code": err.code,
                        "message": err.message,
                        "detail": err.detail,
                    }
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
/// 关闭全部代理实例。
pub async fn proxy_close_all(
    state: State<'_, EngineState>,
    trace_id: Option<String>,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    log_telemetry(
        TelemetryLevel::Debug,
        "proxy.close.all.start",
        trace_id.as_deref(),
        json!({}),
    );
    let trace_id_for_call = trace_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        engine.proxy_close_all(trace_id_for_call.as_deref())
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            "session_command_failed",
            "Failed to close all proxy instances",
            err.to_string(),
        )
    })?;
    match result {
        Ok(()) => {
            log_telemetry(
                TelemetryLevel::Debug,
                "proxy.close.all.success",
                trace_id.as_deref(),
                json!({}),
            );
            Ok(())
        }
        Err(err) => {
            log_telemetry(
                TelemetryLevel::Warn,
                "proxy.close.all.failed",
                trace_id.as_deref(),
                json!({
                    "error": {
                        "code": err.code,
                        "message": err.message,
                        "detail": err.detail,
                    }
                }),
            );
            Err(err)
        }
    }
}
