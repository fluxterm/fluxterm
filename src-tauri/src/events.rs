//! 引擎事件到前端事件的桥接。
use std::sync::Arc;

use engine::{EngineError, EngineEvent, SessionState};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::ai::{
    record_resource_snapshot_from_app, record_session_status_from_app,
    record_terminal_exit_from_app, record_terminal_output_from_app,
};
use crate::remote_edit::RemoteEditState;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusPayload {
    session_id: String,
    state: SessionState,
    error: Option<EngineError>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    session_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerialOutputPayload {
    session_id: String,
    data: Vec<u8>,
    received_at: u64,
}

/// 构建引擎事件到前端事件的桥接器。
pub fn build_event_bridge(app: AppHandle) -> Arc<dyn Fn(EngineEvent) + Send + Sync> {
    Arc::new(move |event| match event {
        EngineEvent::TerminalOutput { session_id, data } => {
            record_terminal_output_from_app(&app, &session_id, &data);
            let _ = app.emit(
                "terminal:output",
                TerminalOutputPayload { session_id, data },
            );
        }
        EngineEvent::TerminalExit { session_id } => {
            record_terminal_exit_from_app(&app, &session_id);
            let _ = app.emit("terminal:exit", TerminalExitPayload { session_id });
        }
        EngineEvent::SerialOutput {
            session_id,
            data,
            received_at,
        } => {
            let _ = app.emit(
                "serial:output",
                SerialOutputPayload {
                    session_id,
                    data,
                    received_at,
                },
            );
        }
        EngineEvent::SftpProgress(progress) => {
            let _ = app.emit("sftp:progress", progress);
        }
        EngineEvent::SshTunnelUpdate(runtime) => {
            let _ = app.emit("ssh:tunnel:update", runtime);
        }
        EngineEvent::ProxyUpdate(runtime) => {
            let _ = app.emit("proxy:update", runtime);
        }
        EngineEvent::SessionResource(resource) => {
            record_resource_snapshot_from_app(&app, &resource);
            let _ = app.emit("session:resource", resource);
        }
        EngineEvent::SessionStatus {
            session_id,
            state,
            error,
        } => {
            if matches!(state, SessionState::Disconnected | SessionState::Error) {
                let app_handle = app.clone();
                let target_session_id = session_id.clone();
                tauri::async_runtime::spawn(async move {
                    app_handle
                        .state::<RemoteEditState>()
                        .remove_by_session(&target_session_id)
                        .await;
                });
            }
            record_session_status_from_app(&app, &session_id, state.clone(), error.clone());
            let _ = app.emit(
                "session:status",
                SessionStatusPayload {
                    session_id,
                    state,
                    error,
                },
            );
        }
    })
}
