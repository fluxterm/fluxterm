//! SSH 隧道相关命令。
use std::sync::Arc;

use fluxterm_engine::{Engine, EngineError, SshTunnelRuntime, SshTunnelSpec};
use tauri::State;

use crate::state::EngineState;

#[tauri::command]
/// 打开 SSH 隧道。
pub async fn ssh_tunnel_open(
    state: State<'_, EngineState>,
    session_id: String,
    spec: SshTunnelSpec,
) -> Result<SshTunnelRuntime, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let spec = spec.clone();
        move || engine.tunnel_open(&session_id, spec)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to create the SSH tunnel",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 关闭指定 SSH 隧道。
pub async fn ssh_tunnel_close(
    state: State<'_, EngineState>,
    session_id: String,
    tunnel_id: String,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        let tunnel_id = tunnel_id.clone();
        move || engine.tunnel_close(&session_id, &tunnel_id)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to close the SSH tunnel",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 列出会话下所有 SSH 隧道。
pub async fn ssh_tunnel_list(
    state: State<'_, EngineState>,
    session_id: String,
) -> Result<Vec<SshTunnelRuntime>, EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        move || engine.tunnel_list(&session_id)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to list SSH tunnels",
            err.to_string(),
        )
    })?
}

#[tauri::command]
/// 关闭会话下全部 SSH 隧道。
pub async fn ssh_tunnel_close_all(
    state: State<'_, EngineState>,
    session_id: String,
) -> Result<(), EngineError> {
    let engine: Arc<Engine> = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking({
        let session_id = session_id.clone();
        move || engine.tunnel_close_all(&session_id)
    })
    .await
    .map_err(|err| {
        EngineError::with_detail(
            fluxterm_engine::SESSION_COMMAND_FAILED_CODE,
            "Failed to close SSH tunnels",
            err.to_string(),
        )
    })?
}
