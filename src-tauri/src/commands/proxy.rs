//! 全局代理相关命令。
use std::sync::Arc;

use fluxterm_engine::{Engine, EngineError, ProxyRuntime, ProxySpec};
use tauri::{AppHandle, State};

use crate::events::build_event_bridge;
use crate::state::EngineState;

#[tauri::command]
/// 创建全局代理实例。
pub async fn proxy_open(
    app: AppHandle,
    state: State<'_, EngineState>,
    spec: ProxySpec,
    operation_id: Option<String>,
) -> Result<ProxyRuntime, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    let on_event = build_event_bridge(app);
    tauri::async_runtime::spawn_blocking({
        move || engine.proxy_open(spec, on_event, operation_id.as_deref())
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to create the proxy instance",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 关闭指定代理实例。
pub async fn proxy_close(
    state: State<'_, EngineState>,
    proxy_id: String,
    operation_id: Option<String>,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        move || engine.proxy_close(&proxy_id, operation_id.as_deref())
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to close the proxy instance",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 获取全部代理实例。
pub async fn proxy_list(state: State<'_, EngineState>) -> Result<Vec<ProxyRuntime>, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || engine.proxy_list())
        .await
        .map_err(|err| {
            EngineError::with_detail(
                fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
                "Failed to list proxy instances",
                err.to_string(),
            )
        })?
}

#[tauri::command]
/// 关闭全部代理实例。
pub async fn proxy_close_all(
    state: State<'_, EngineState>,
    operation_id: Option<String>,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || engine.proxy_close_all(operation_id.as_deref()))
        .await
        .map_err(|err| {
            EngineError::with_detail(
                fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
                "Failed to close all proxy instances",
                err.to_string(),
            )
        })?
}
