//! 会话资源监控管理。
//!
//! FluxTerm 将 SSH 主会话与资源监控连接拆成两条独立链路：
//!
//! - 主 SSH 会话负责终端交互、PTY 与 SFTP
//! - 资源监控连接仅负责远端采样与事件回传
//!
//! 远端资源监控只在以下条件满足时启动：
//!
//! - 当前活动会话为 SSH 会话
//! - 会话状态为已连接
//! - 会话设置启用了资源监控
//! - 主机身份校验允许建立监控连接
//!
//! 资源监控连接与主 SSH 会话共享同一套 Host Key 策略：
//!
//! - `off`：不校验 Host Key
//! - `ask` / `strict`：仅在目标主机已有受信任记录时才允许后台监控连接启动
//!
//! 一旦连接建立，正式握手阶段仍会校验服务端公钥与预期公钥一致。
//! 无法启动或采样失败时，本模块会回推 `unsupported` 终态并附带原因码。
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use engine::{
    EngineEvent, EventCallback, ExpectedHostKey, HostProfile, JumpHostSpec, ResourceCpuSnapshot,
    ResourceMemorySnapshot, ResourceMonitorStatus, ResourceMonitorUnsupportedReason,
    SessionResourceSnapshot,
    monitor::{SshResourceMonitorRequest, run_ssh_resource_monitor},
    util::now_epoch,
};
use fluxterm_logging::{LogLevel, log_event};
use serde_json::json;
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

pub const MIN_RESOURCE_MONITOR_INTERVAL_SEC: u64 = 3;
const INITIAL_RESOURCE_SAMPLE_WINDOW: Duration = Duration::from_secs(1);

struct ResourceMonitorHandle {
    stop_tx: watch::Sender<bool>,
}

/// 资源监控共享状态。
pub struct ResourceMonitorState {
    monitors: Mutex<HashMap<String, ResourceMonitorHandle>>,
}

/// 启动独立 SSH 资源监控所需的完整上下文。
pub(crate) struct SshResourceMonitorStartRequest {
    pub(crate) app: AppHandle,
    pub(crate) session_id: String,
    pub(crate) profile: HostProfile,
    pub(crate) operation_id: String,
    pub(crate) expected_host_key: Option<ExpectedHostKey>,
    pub(crate) jump_spec: JumpHostSpec,
    pub(crate) interval_sec: u64,
}

impl Default for ResourceMonitorState {
    fn default() -> Self {
        Self {
            monitors: Mutex::new(HashMap::new()),
        }
    }
}

impl ResourceMonitorState {
    /// 启动本地资源监控。
    pub fn start_local(&self, app: AppHandle, session_id: String, interval_sec: u64) {
        self.stop(&session_id);
        let interval_sec = interval_sec.max(MIN_RESOURCE_MONITOR_INTERVAL_SEC);
        let (stop_tx, stop_rx) = watch::channel(false);
        self.monitors
            .lock()
            .expect("resource monitor lock poisoned")
            .insert(session_id.clone(), ResourceMonitorHandle { stop_tx });

        log_event!(
            LogLevel::Debug,
            "resource.monitor.local.started",
            None,
            json!({
                "sessionId": session_id.clone(),
                "intervalSec": interval_sec,
            }),
        );
        tauri::async_runtime::spawn(async move {
            run_local_resource_monitor(app, session_id, interval_sec, stop_rx).await;
        });
    }

    /// 启动远端 SSH 资源监控。
    pub(crate) fn start_ssh(&self, request: SshResourceMonitorStartRequest) {
        let SshResourceMonitorStartRequest {
            app,
            session_id,
            profile,
            operation_id,
            expected_host_key,
            jump_spec,
            interval_sec,
        } = request;
        self.stop(&session_id);
        let interval_sec = interval_sec.max(MIN_RESOURCE_MONITOR_INTERVAL_SEC);
        let (stop_tx, stop_rx) = watch::channel(false);
        self.monitors
            .lock()
            .expect("resource monitor lock poisoned")
            .insert(session_id.clone(), ResourceMonitorHandle { stop_tx });
        let profile_id = profile.id.clone();
        let host = profile.host.clone();
        let user = profile.username.clone();

        tauri::async_runtime::spawn(async move {
            let on_event = build_resource_event_bridge(app.clone());
            if let Err(error) = run_ssh_resource_monitor(SshResourceMonitorRequest {
                session_id: session_id.clone(),
                profile,
                operation_id: operation_id.clone(),
                expected_host_key,
                jump_spec,
                interval_sec,
                stop_rx,
                on_event,
            })
            .await
            {
                log_event!(
                    LogLevel::Warn,
                    "resource.monitor.ssh.failed",
                    Some(&operation_id),
                    json!({
                        "sessionId": session_id.clone(),
                        "profileId": profile_id,
                        "host": host,
                        "user": user,
                        "connectionPurpose": "resourceMonitor",
                        "error": {
                            "code": error.code.clone(),
                            "message": "Resource monitor SSH connection failed",
                            "detail": error.details.clone().unwrap_or(error.message.clone()),
                        }
                    }),
                );
                let reason = match error.code.as_str() {
                    "resource_monitor_connect_failed" => {
                        ResourceMonitorUnsupportedReason::ConnectFailed
                    }
                    "resource_monitor_unsupported" => {
                        ResourceMonitorUnsupportedReason::UnsupportedPlatform
                    }
                    _ => ResourceMonitorUnsupportedReason::SampleFailed,
                };
                emit_resource_monitor_unsupported(&app, &session_id, "ssh-linux", reason);
            }
        });
    }

    /// 停止指定会话的资源监控。
    pub fn stop(&self, session_id: &str) {
        let handle = self
            .monitors
            .lock()
            .expect("resource monitor lock poisoned")
            .remove(session_id);
        if let Some(handle) = handle {
            let _ = handle.stop_tx.send(true);
            log_event!(
                LogLevel::Debug,
                "resource.monitor.stop.succeeded",
                None,
                json!({
                    "sessionId": session_id,
                }),
            );
        }
    }
}

async fn run_local_resource_monitor(
    app: AppHandle,
    session_id: String,
    interval_sec: u64,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut system = System::new_all();
    system.refresh_memory();
    system.refresh_cpu_usage();
    tokio::select! {
        _ = stop_rx.changed() => {
            if *stop_rx.borrow() {
                return;
            }
        }
        _ = tokio::time::sleep(INITIAL_RESOURCE_SAMPLE_WINDOW) => {}
    }
    system.refresh_memory();
    system.refresh_cpu_usage();
    if *stop_rx.borrow() {
        return;
    }
    let _ = app.emit(
        "session:resource",
        build_local_resource_snapshot(&session_id, &system),
    );

    let mut ticker = tokio::time::interval(Duration::from_secs(interval_sec));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker.tick().await;

    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    break;
                }
            }
            _ = ticker.tick() => {
                system.refresh_memory();
                system.refresh_cpu_usage();
                let _ = app.emit(
                    "session:resource",
                    build_local_resource_snapshot(&session_id, &system),
                );
            }
        }
    }
}

fn build_local_resource_snapshot(session_id: &str, system: &System) -> SessionResourceSnapshot {
    SessionResourceSnapshot {
        session_id: session_id.to_string(),
        sampled_at: now_epoch(),
        source: "local".to_string(),
        status: ResourceMonitorStatus::Ready,
        unsupported_reason: None,
        uptime_seconds: Some(System::uptime()),
        cpu: Some(ResourceCpuSnapshot {
            total_percent: system.global_cpu_usage(),
            user_percent: 0.0,
            system_percent: 0.0,
            idle_percent: 0.0,
            iowait_percent: 0.0,
            logical_cpu_count: u32::try_from(system.cpus().len()).ok(),
        }),
        memory: Some(ResourceMemorySnapshot {
            total_bytes: system.total_memory(),
            used_bytes: system.used_memory(),
            free_bytes: system.free_memory(),
            available_bytes: system.available_memory(),
            cache_bytes: 0,
        }),
    }
}

fn build_resource_event_bridge(app: AppHandle) -> EventCallback {
    std::sync::Arc::new(move |event| {
        if let EngineEvent::SessionResource(payload) = event {
            let _ = app.emit("session:resource", payload);
        }
    })
}

fn emit_resource_monitor_unsupported(
    app: &AppHandle,
    session_id: &str,
    source: &str,
    reason: ResourceMonitorUnsupportedReason,
) {
    // 回推资源监控不可用终态。
    let _ = app.emit(
        "session:resource",
        build_unsupported_resource_snapshot(session_id, source, reason),
    );
}

fn build_unsupported_resource_snapshot(
    session_id: &str,
    source: &str,
    reason: ResourceMonitorUnsupportedReason,
) -> SessionResourceSnapshot {
    SessionResourceSnapshot {
        session_id: session_id.to_string(),
        sampled_at: now_epoch(),
        source: source.to_string(),
        status: ResourceMonitorStatus::Unsupported,
        unsupported_reason: Some(reason),
        uptime_seconds: None,
        cpu: None,
        memory: None,
    }
}

#[cfg(test)]
mod tests {
    use super::build_unsupported_resource_snapshot;
    use engine::{ResourceMonitorStatus, ResourceMonitorUnsupportedReason};

    #[test]
    fn build_unsupported_snapshot_marks_status_reason_and_clears_metrics() {
        let snapshot = build_unsupported_resource_snapshot(
            "session-1",
            "ssh-linux",
            ResourceMonitorUnsupportedReason::HostKeyUntrusted,
        );
        assert_eq!(snapshot.session_id, "session-1");
        assert_eq!(snapshot.source, "ssh-linux");
        assert!(matches!(
            snapshot.status,
            ResourceMonitorStatus::Unsupported
        ));
        assert!(matches!(
            snapshot.unsupported_reason,
            Some(ResourceMonitorUnsupportedReason::HostKeyUntrusted)
        ));
        assert!(snapshot.cpu.is_none());
        assert!(snapshot.memory.is_none());
    }
}
