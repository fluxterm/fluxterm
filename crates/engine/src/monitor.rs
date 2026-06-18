//! 远端资源监控实现。
use std::time::Duration;

use regex::Regex;
use russh::client;
use serde_json::json;
use tokio::{sync::watch, time::timeout};

use crate::auth::{AuthPurpose, authenticate};
use crate::error::EngineError;
use crate::session::{ClientHandler, ExpectedHostKey};
use crate::ssh_transport::{JumpHostSpec, connect_ssh_client};
use crate::telemetry::{TelemetryLevel, log_telemetry};
use crate::types::{
    EngineEvent, EventCallback, HostProfile, ResourceCpuSnapshot, ResourceMemorySnapshot,
    ResourceMonitorStatus, ResourceMonitorUnsupportedReason, SessionResourceSnapshot,
};
use crate::util::now_epoch;

const REMOTE_RESOURCE_COMMAND: &str = "cat /proc/stat 2>/dev/null; printf '\\n'; cat /proc/meminfo 2>/dev/null; printf '\\n'; cat /proc/uptime 2>/dev/null";
const INITIAL_RESOURCE_SAMPLE_WINDOW: Duration = Duration::from_secs(1);
const SSH_RESOURCE_MONITOR_CONNECT_TIMEOUT_SECS: u64 = 8;

#[derive(Clone, Copy)]
struct CpuCounters {
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    irq: u64,
    softirq: u64,
    steal: u64,
}

impl CpuCounters {
    fn total(self) -> u64 {
        self.user
            + self.nice
            + self.system
            + self.idle
            + self.iowait
            + self.irq
            + self.softirq
            + self.steal
    }
}

/// 运行独立 SSH 资源监控循环，仅用于远端 Linux 主机。
pub async fn run_ssh_resource_monitor(
    session_id: String,
    profile: HostProfile,
    expected_host_key: Option<ExpectedHostKey>,
    jump_spec: JumpHostSpec,
    interval_sec: u64,
    mut stop_rx: watch::Receiver<bool>,
    on_event: EventCallback,
) -> Result<(), EngineError> {
    let handler = match expected_host_key {
        Some(expected) => ClientHandler::with_expected(expected),
        None => ClientHandler::unchecked(),
    };
    let connection = timeout(
        Duration::from_secs(SSH_RESOURCE_MONITOR_CONNECT_TIMEOUT_SECS),
        connect_ssh_client(&profile, None, &jump_spec, handler),
    )
    .await
    .map_err(|err| {
        EngineError::with_detail(
            "resource_monitor_connect_failed",
            "Failed to establish resource monitor connection",
            err.to_string(),
        )
    })?
    .map_err(|err| {
        EngineError::with_detail(
            "resource_monitor_connect_failed",
            "Failed to establish resource monitor connection",
            err.detail.unwrap_or(err.message),
        )
    })?;
    let mut session = connection.handle;

    authenticate(&mut session, &profile, AuthPurpose::ResourceMonitor).await?;

    let baseline_output = exec_remote_resource_command(&session).await?;
    let baseline_cpu = parse_cpu_counters(&baseline_output)?;
    tokio::select! {
        _ = stop_rx.changed() => {
            if *stop_rx.borrow() {
                return Ok(());
            }
        }
        _ = tokio::time::sleep(INITIAL_RESOURCE_SAMPLE_WINDOW) => {}
    }
    let (snapshot, mut previous_cpu) =
        sample_linux_resource_snapshot(&session_id, &session, baseline_cpu).await?;
    if *stop_rx.borrow() {
        return Ok(());
    }
    on_event(EngineEvent::SessionResource(snapshot));

    let mut ticker = tokio::time::interval(Duration::from_secs(interval_sec.max(3)));
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
                match sample_linux_resource_snapshot(&session_id, &session, previous_cpu).await {
                    Ok((snapshot, current_cpu)) => {
                        previous_cpu = current_cpu;
                        on_event(EngineEvent::SessionResource(snapshot));
                    }
                    Err(error) if error.code == "resource_monitor_unsupported" => {
                        on_event(EngineEvent::SessionResource(SessionResourceSnapshot {
                            session_id: session_id.clone(),
                            sampled_at: now_epoch(),
                            source: "ssh-linux".to_string(),
                            status: ResourceMonitorStatus::Unsupported,
                            unsupported_reason: Some(
                                ResourceMonitorUnsupportedReason::UnsupportedPlatform,
                            ),
                            uptime_seconds: None,
                            cpu: None,
                            memory: None,
                        }));
                        break;
                    }
                    Err(error) => {
                        log_telemetry(
                            TelemetryLevel::Debug,
                            "resource.monitor.ssh.sample.failed",
                            None,
                            json!({
                                "sessionId": session_id,
                                "error": {
                                    "code": error.code,
                                    "message": error.message,
                                    "detail": error.detail,
                                }
                            }),
                        );
                    }
                }
            }
        }
    }

    Ok(())
}

async fn sample_linux_resource_snapshot(
    session_id: &str,
    session: &client::Handle<ClientHandler>,
    previous_cpu: CpuCounters,
) -> Result<(SessionResourceSnapshot, CpuCounters), EngineError> {
    let output = exec_remote_resource_command(session).await?;
    let current_cpu = parse_cpu_counters(&output)?;
    let logical_cpu_count = parse_logical_cpu_count(&output)?;
    let memory = parse_memory_snapshot(&output)?;
    let uptime_seconds = parse_uptime_seconds(&output)?;
    let cpu_snapshot = calculate_cpu_snapshot(previous_cpu, current_cpu, logical_cpu_count);

    Ok((
        SessionResourceSnapshot {
            session_id: session_id.to_string(),
            sampled_at: now_epoch(),
            source: "ssh-linux".to_string(),
            status: ResourceMonitorStatus::Ready,
            unsupported_reason: None,
            uptime_seconds: Some(uptime_seconds),
            cpu: Some(cpu_snapshot),
            memory: Some(memory),
        },
        current_cpu,
    ))
}

async fn exec_remote_resource_command(
    session: &client::Handle<ClientHandler>,
) -> Result<String, EngineError> {
    let mut channel = session.channel_open_session().await.map_err(|err| {
        EngineError::with_detail(
            "resource_monitor_exec_failed",
            "Failed to open resource monitor channel",
            err.to_string(),
        )
    })?;
    channel
        .exec(false, REMOTE_RESOURCE_COMMAND)
        .await
        .map_err(|err| {
            EngineError::with_detail(
                "resource_monitor_exec_failed",
                "Failed to execute resource monitor command",
                err.to_string(),
            )
        })?;

    let mut stdout = String::new();
    let mut stderr = String::new();

    while let Some(message) = channel.wait().await {
        match message {
            russh::ChannelMsg::Data { data } => {
                stdout.push_str(&String::from_utf8_lossy(data.as_ref()));
            }
            russh::ChannelMsg::ExtendedData { data, .. } => {
                stderr.push_str(&String::from_utf8_lossy(data.as_ref()));
            }
            russh::ChannelMsg::Close | russh::ChannelMsg::Eof => break,
            _ => {}
        }
    }

    if !stderr.trim().is_empty() {
        return Err(EngineError::with_detail(
            "resource_monitor_exec_failed",
            "Resource monitor command failed",
            stderr,
        ));
    }

    Ok(stdout)
}

fn parse_cpu_counters(output: &str) -> Result<CpuCounters, EngineError> {
    let line = output
        .lines()
        .find(|line| line.starts_with("cpu "))
        .ok_or_else(|| {
            EngineError::new(
                "resource_monitor_unsupported",
                "Remote system does not support resource monitoring",
            )
        })?;
    let numbers: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .map(|part| part.parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            EngineError::with_detail(
                "resource_monitor_parse_failed",
                "Failed to parse CPU information",
                err.to_string(),
            )
        })?;
    if numbers.len() < 8 {
        return Err(EngineError::new(
            "resource_monitor_unsupported",
            "Remote system does not support resource monitoring",
        ));
    }
    Ok(CpuCounters {
        user: numbers[0],
        nice: numbers[1],
        system: numbers[2],
        idle: numbers[3],
        iowait: numbers[4],
        irq: numbers[5],
        softirq: numbers[6],
        steal: numbers[7],
    })
}

fn parse_memory_snapshot(output: &str) -> Result<ResourceMemorySnapshot, EngineError> {
    let regex = Regex::new(r"^(?P<key>[A-Za-z_]+):\s+(?P<value>\d+)\s+kB$").map_err(|err| {
        EngineError::with_detail(
            "resource_monitor_parse_failed",
            "Failed to initialize memory parser",
            err.to_string(),
        )
    })?;
    let mut total_kb = None;
    let mut free_kb = None;
    let mut available_kb = None;
    let mut cache_kb = None;

    for line in output.lines() {
        if let Some(captures) = regex.captures(line) {
            let value = captures["value"].parse::<u64>().map_err(|err| {
                EngineError::with_detail(
                    "resource_monitor_parse_failed",
                    "Failed to parse memory information",
                    err.to_string(),
                )
            })?;
            match &captures["key"] {
                "MemTotal" => total_kb = Some(value),
                "MemFree" => free_kb = Some(value),
                "MemAvailable" => available_kb = Some(value),
                "Cached" => cache_kb = Some(value),
                _ => {}
            }
        }
    }

    let total_kb = total_kb.ok_or_else(|| {
        EngineError::new(
            "resource_monitor_unsupported",
            "Remote system does not support resource monitoring",
        )
    })?;
    let free_kb = free_kb.unwrap_or(0);
    let available_kb = available_kb.unwrap_or(free_kb);
    let cache_kb = cache_kb.unwrap_or(0);
    let used_kb = total_kb.saturating_sub(available_kb);

    Ok(ResourceMemorySnapshot {
        total_bytes: total_kb * 1024,
        used_bytes: used_kb * 1024,
        free_bytes: free_kb * 1024,
        available_bytes: available_kb * 1024,
        cache_bytes: cache_kb * 1024,
    })
}

fn parse_logical_cpu_count(output: &str) -> Result<u32, EngineError> {
    let count = output
        .lines()
        .filter(|line| {
            line.strip_prefix("cpu")
                .map(|suffix| {
                    !suffix.is_empty()
                        && suffix
                            .chars()
                            .next()
                            .map(|ch| ch.is_ascii_digit())
                            .unwrap_or(false)
                })
                .unwrap_or(false)
        })
        .count();

    if count == 0 {
        return Err(EngineError::new(
            "resource_monitor_unsupported",
            "Remote system does not support resource monitoring",
        ));
    }

    u32::try_from(count).map_err(|err| {
        EngineError::with_detail(
            "resource_monitor_parse_failed",
            "Failed to parse CPU count",
            err.to_string(),
        )
    })
}

fn parse_uptime_seconds(output: &str) -> Result<u64, EngineError> {
    let line = output
        .lines()
        .find(|line| {
            let mut parts = line.split_whitespace();
            matches!(
                (parts.next(), parts.next(), parts.next()),
                (Some(first), Some(second), None)
                    if first.parse::<f64>().is_ok() && second.parse::<f64>().is_ok()
            )
        })
        .ok_or_else(|| {
            EngineError::new(
                "resource_monitor_unsupported",
                "Remote system does not support resource monitoring",
            )
        })?;

    let seconds = line
        .split_whitespace()
        .next()
        .ok_or_else(|| {
            EngineError::new(
                "resource_monitor_unsupported",
                "Remote system does not support resource monitoring",
            )
        })?
        .parse::<f64>()
        .map_err(|err| {
            EngineError::with_detail(
                "resource_monitor_parse_failed",
                "Failed to parse system uptime",
                err.to_string(),
            )
        })?;

    Ok(seconds.max(0.0).floor() as u64)
}

fn calculate_cpu_snapshot(
    previous: CpuCounters,
    current: CpuCounters,
    logical_cpu_count: u32,
) -> ResourceCpuSnapshot {
    let total_diff = current.total().saturating_sub(previous.total()).max(1) as f32;
    let user_diff = current.user.saturating_sub(previous.user) as f32;
    let nice_diff = current.nice.saturating_sub(previous.nice) as f32;
    let system_diff = current.system.saturating_sub(previous.system) as f32;
    let idle_diff = current.idle.saturating_sub(previous.idle) as f32;
    let iowait_diff = current.iowait.saturating_sub(previous.iowait) as f32;
    let irq_diff = current.irq.saturating_sub(previous.irq) as f32;
    let softirq_diff = current.softirq.saturating_sub(previous.softirq) as f32;
    let steal_diff = current.steal.saturating_sub(previous.steal) as f32;
    let busy_total =
        user_diff + nice_diff + system_diff + iowait_diff + irq_diff + softirq_diff + steal_diff;
    let total_percent = (busy_total / total_diff) * 100.0;

    ResourceCpuSnapshot {
        total_percent,
        user_percent: ((user_diff + nice_diff) / total_diff) * 100.0,
        system_percent: ((system_diff + irq_diff + softirq_diff + steal_diff) / total_diff) * 100.0,
        idle_percent: (idle_diff / total_diff) * 100.0,
        iowait_percent: (iowait_diff / total_diff) * 100.0,
        logical_cpu_count: Some(logical_cpu_count),
    }
}
