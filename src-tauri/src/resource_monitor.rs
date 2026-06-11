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
    EngineEvent, EventCallback, ExpectedHostKey, HostProfile, ResourceCpuSnapshot,
    ResourceMemorySnapshot, ResourceMonitorStatus, ResourceMonitorUnsupportedReason,
    SessionResourceSnapshot, monitor::run_ssh_resource_monitor, probe_host_key, util::now_epoch,
};
use serde_json::json;
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::session_settings::{HostKeyPolicy, read_session_settings};
use crate::ssh_host_keys::{HostKeyMatchStatus, match_host_key};
use crate::telemetry::{TelemetryLevel, log_telemetry};

pub const MIN_RESOURCE_MONITOR_INTERVAL_SEC: u64 = 3;
const INITIAL_RESOURCE_SAMPLE_WINDOW: Duration = Duration::from_secs(1);

struct ResourceMonitorHandle {
    stop_tx: watch::Sender<bool>,
}

/// 资源监控共享状态。
pub struct ResourceMonitorState {
    monitors: Mutex<HashMap<String, ResourceMonitorHandle>>,
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

        log_telemetry(
            TelemetryLevel::Debug,
            "resource.monitor.local.start",
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
    pub fn start_ssh(
        &self,
        app: AppHandle,
        session_id: String,
        profile: HostProfile,
        interval_sec: u64,
    ) {
        self.stop(&session_id);
        let interval_sec = interval_sec.max(MIN_RESOURCE_MONITOR_INTERVAL_SEC);
        let (stop_tx, stop_rx) = watch::channel(false);
        self.monitors
            .lock()
            .expect("resource monitor lock poisoned")
            .insert(session_id.clone(), ResourceMonitorHandle { stop_tx });

        log_telemetry(
            TelemetryLevel::Debug,
            "resource.monitor.ssh.start",
            None,
            json!({
                "sessionId": session_id.clone(),
                "profileId": profile.id.clone(),
                "host": profile.host.clone(),
                "intervalSec": interval_sec,
            }),
        );
        tauri::async_runtime::spawn(async move {
            let on_event = build_resource_event_bridge(app.clone());
            // 资源监控使用独立 SSH 连接，并执行主机身份校验。
            // 未受信任时直接回传 unsupported。
            let expected_host_key = match resolve_monitor_expected_host_key(&app, &profile).await {
                Ok(expected_host_key) => expected_host_key,
                Err(reason) => {
                    log_telemetry(
                        TelemetryLevel::Warn,
                        "resource.monitor.ssh.failed",
                        None,
                        json!({
                            "sessionId": session_id,
                            "profileId": profile.id,
                            "host": profile.host,
                            "phase": "resolveExpectedHostKey",
                            "error": {
                                "code": "resource_monitor_host_key_untrusted",
                                "message": "资源监控连接主机身份校验未通过",
                                "detail": format!("{reason:?}"),
                            }
                        }),
                    );
                    emit_resource_monitor_unsupported(&app, &session_id, "ssh-linux", reason);
                    return;
                }
            };
            if let Err(error) = run_ssh_resource_monitor(
                session_id.clone(),
                profile,
                expected_host_key,
                interval_sec,
                stop_rx,
                on_event,
            )
            .await
            {
                log_telemetry(
                    TelemetryLevel::Warn,
                    "resource.monitor.ssh.failed",
                    None,
                    json!({
                        "sessionId": session_id.clone(),
                        "phase": "runSshMonitor",
                        "error": {
                            "code": error.code.clone(),
                            "message": error.message.clone(),
                            "detail": error.detail.clone(),
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
            log_telemetry(
                TelemetryLevel::Debug,
                "resource.monitor.stop.success",
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

async fn resolve_monitor_expected_host_key(
    app: &AppHandle,
    profile: &HostProfile,
) -> Result<Option<ExpectedHostKey>, ResourceMonitorUnsupportedReason> {
    let settings =
        read_session_settings(app).map_err(|_| ResourceMonitorUnsupportedReason::ProbeFailed)?;
    if settings.host_key_policy == HostKeyPolicy::Off {
        return Ok(None);
    }
    // 为资源监控连接生成正式握手阶段使用的 ExpectedHostKey。
    let probe = probe_host_key(profile)
        .await
        .map_err(|_| ResourceMonitorUnsupportedReason::ProbeFailed)?;
    let matched = match_host_key(
        app,
        &profile.host,
        profile.port,
        &probe.key_algorithm,
        &probe.public_key_base64,
    )
    .map_err(|_| ResourceMonitorUnsupportedReason::ProbeFailed)?;
    match matched.status {
        HostKeyMatchStatus::Trusted => Ok(Some(ExpectedHostKey {
            public_key_base64: probe.public_key_base64,
            fingerprint_sha256: probe.fingerprint_sha256,
        })),
        HostKeyMatchStatus::Unknown | HostKeyMatchStatus::Mismatch => {
            Err(ResourceMonitorUnsupportedReason::HostKeyUntrusted)
        }
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
