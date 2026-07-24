//! 资源监控命令。
use engine::{EngineError, HostProfile};
use fluxterm_logging::{LogLevel, log_event};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::commands::ssh::resolve_ssh_connect_plan;
use crate::resource_monitor::{
    MIN_RESOURCE_MONITOR_INTERVAL_SEC, ResourceMonitorState, SshResourceMonitorStartRequest,
};
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
    operation_id: String,
    interval_sec: u64,
) -> Result<(), EngineError> {
    let plan = resolve_ssh_connect_plan(&app, &security, &profile)
        .await
        .inspect_err(|error| {
            log_event!(
                LogLevel::Warn,
                "resource.monitor.ssh.failed",
                Some(&operation_id),
                json!({
                    "sessionId": session_id.clone(),
                    "profileId": profile.id.clone(),
                    "host": profile.host.clone(),
                    "user": profile.username.clone(),
                    "connectionPurpose": "resourceMonitor",
                    "error": {
                        "code": error.code.clone(),
                        "message": "Resource monitor SSH connection failed",
                        "detail": error.detail.clone().unwrap_or(error.message.clone()),
                    }
                }),
            );
        })?;
    state.start_ssh(SshResourceMonitorStartRequest {
        app,
        session_id,
        profile: plan.profile,
        operation_id,
        expected_host_key: plan.expected_host_key,
        jump_spec: plan.jump_spec,
        interval_sec: interval_sec.max(MIN_RESOURCE_MONITOR_INTERVAL_SEC),
    });
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
