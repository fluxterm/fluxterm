//! 资源监控命令。
use engine::{EngineError, HostProfile};
use tauri::{AppHandle, State};

use crate::commands::ssh::resolve_ssh_connect_plan;
use crate::resource_monitor::{MIN_RESOURCE_MONITOR_INTERVAL_SEC, ResourceMonitorState};
use crate::state::SecurityState;

#[tauri::command]
/// 启动本地资源监控。
pub fn resource_monitor_start_local(
    app: AppHandle,
    state: State<'_, ResourceMonitorState>,
    session_id: String,
    interval_sec: u64,
) -> Result<(), EngineError> {
    state.start_local(
        app,
        session_id,
        interval_sec.max(MIN_RESOURCE_MONITOR_INTERVAL_SEC),
    );
    Ok(())
}

#[tauri::command]
/// 启动 SSH 资源监控。
pub async fn resource_monitor_start_ssh(
    app: AppHandle,
    state: State<'_, ResourceMonitorState>,
    security: State<'_, SecurityState>,
    session_id: String,
    profile: HostProfile,
    interval_sec: u64,
) -> Result<(), EngineError> {
    let plan = resolve_ssh_connect_plan(&app, &security, &profile).await?;
    state.start_ssh(
        app,
        session_id,
        plan.profile,
        plan.expected_host_key,
        plan.jump_spec,
        interval_sec.max(MIN_RESOURCE_MONITOR_INTERVAL_SEC),
    );
    Ok(())
}

#[tauri::command]
/// 停止会话资源监控。
pub fn resource_monitor_stop(
    state: State<ResourceMonitorState>,
    session_id: String,
) -> Result<(), EngineError> {
    state.stop(&session_id);
    Ok(())
}
