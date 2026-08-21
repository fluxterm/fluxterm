//! 本地 Shell 命令。
use fluxterm_engine::{EngineError, Session, TerminalSize};
use tauri::{AppHandle, State};

use crate::ai::{AiRuntimeState, register_local_session};
use crate::local_shell::{
    LocalShellLaunchConfig, LocalShellProfile, LocalShellState, list_local_shells,
    resize_local_shell, start_local_shell, stop_local_shell, write_local_shell,
};
use crate::resource_monitor::ResourceMonitorState;

#[tauri::command]
/// 列出本地可用 Shell。
pub fn local_shell_list() -> Vec<LocalShellProfile> {
    list_local_shells()
}

#[tauri::command]
/// 启动本地 Shell 会话。
pub fn local_shell_connect(
    app: AppHandle,
    state: State<LocalShellState>,
    ai_state: State<AiRuntimeState>,
    shell_id: Option<String>,
    launch_config: Option<LocalShellLaunchConfig>,
    size: TerminalSize,
) -> Result<Session, EngineError> {
    let session = start_local_shell(app, &state, shell_id.clone(), launch_config, size)?;
    let shells = list_local_shells();
    let selected_shell = shell_id
        .as_deref()
        .and_then(|id| shells.iter().find(|shell| shell.id == id))
        .or_else(|| shells.iter().find(|shell| shell.id == "powershell"))
        .or_else(|| shells.first());
    let label = selected_shell
        .map(|shell| shell.label.clone())
        .unwrap_or_else(|| "Local Shell".to_string());
    let shell_name = selected_shell.map(|shell| shell.label.clone());
    register_local_session(&ai_state, &session, &label, shell_name)?;
    Ok(session)
}

#[tauri::command]
/// 写入本地 Shell 数据。
pub fn local_shell_write(
    state: State<LocalShellState>,
    session_id: String,
    data: String,
) -> Result<(), EngineError> {
    write_local_shell(&state, &session_id, data.as_bytes())
}

#[tauri::command]
/// 写入本地 Shell 二进制数据。
pub fn local_shell_write_binary(
    state: State<LocalShellState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), EngineError> {
    write_local_shell(&state, &session_id, &data)
}

#[tauri::command]
/// 调整本地 Shell 终端尺寸。
pub fn local_shell_resize(
    state: State<LocalShellState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), EngineError> {
    resize_local_shell(&state, &session_id, cols, rows)
}

#[tauri::command]
/// 关闭本地 Shell 会话。
pub fn local_shell_disconnect(
    state: State<LocalShellState>,
    monitor_state: State<ResourceMonitorState>,
    session_id: String,
) -> Result<(), EngineError> {
    monitor_state.stop(&session_id);
    stop_local_shell(&state, &session_id)
}
