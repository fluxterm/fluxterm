//! SSH 会话相关命令。
use std::collections::HashSet;

use engine::{
    EngineError, ExpectedHostKey, HostProfile, JumpHostProfile, JumpHostSpec, Session,
    TerminalSize, probe_host_key,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::ai::{AiRuntimeState, register_remote_session};
use crate::events::build_event_bridge;
use crate::profile_secrets::decrypt_profile_secrets;
use crate::resource_monitor::ResourceMonitorState;
use crate::security::{CryptoService, SecretStore};
use crate::security_store::read_security_config;
use crate::session_settings::{HostKeyPolicy, read_session_settings};
use crate::ssh_host_keys::{HostKeyMatchStatus, match_host_key, trust_host_key};
use crate::ssh_profile_store::read_ssh_profiles;
use crate::state::{EngineState, SecurityState};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// 前端弹窗确认 Host Key 所需的最小载荷。
struct HostKeyVerificationRequiredPayload {
    profile_id: String,
    host: String,
    port: u16,
    key_algorithm: String,
    public_key_base64: String,
    fingerprint_sha256: String,
    previous_fingerprint_sha256: Option<String>,
    policy: String,
}

/// 建立 SSH 连接前已解析完成的运行时计划。
pub(crate) struct SshConnectPlan {
    pub profile: HostProfile,
    pub expected_host_key: Option<ExpectedHostKey>,
    pub jump_spec: JumpHostSpec,
}

#[tauri::command]
/// 建立 SSH 会话连接。
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, EngineState>,
    security: State<'_, SecurityState>,
    ai_state: State<'_, AiRuntimeState>,
    profile: HostProfile,
    size: TerminalSize,
) -> Result<Session, EngineError> {
    let plan = resolve_ssh_connect_plan(&app, &security, &profile).await?;
    let on_event = build_event_bridge(app.clone());
    let session = state.engine.connect(
        plan.profile.clone(),
        plan.expected_host_key,
        plan.jump_spec,
        size,
        on_event,
    )?;
    register_remote_session(&ai_state, &session, &plan.profile)?;
    Ok(session)
}

#[tauri::command]
/// 断开 SSH 会话连接。
pub fn ssh_disconnect(
    state: State<EngineState>,
    monitor_state: State<ResourceMonitorState>,
    session_id: String,
) -> Result<(), EngineError> {
    monitor_state.stop(&session_id);
    state.engine.disconnect(&session_id)
}

#[tauri::command]
/// 调整会话终端尺寸。
pub fn ssh_resize(
    state: State<EngineState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), EngineError> {
    state.engine.resize(&session_id, cols, rows)
}

#[tauri::command]
/// 发送终端输入数据。
pub fn ssh_write(
    state: State<EngineState>,
    session_id: String,
    data: String,
) -> Result<(), EngineError> {
    state.engine.write(&session_id, data.into_bytes())
}

#[tauri::command]
/// 发送终端二进制输入数据。
pub fn ssh_write_binary(
    state: State<EngineState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), EngineError> {
    state.engine.write(&session_id, data)
}

#[tauri::command]
/// 显式确认并写入 Host Key 信任记录。
pub fn ssh_host_key_confirm(
    app: AppHandle,
    host: String,
    port: u16,
    key_algorithm: String,
    public_key_base64: String,
) -> Result<(), EngineError> {
    trust_host_key(&app, &host, port, &key_algorithm, &public_key_base64)
}

pub(crate) async fn resolve_ssh_connect_plan(
    app: &AppHandle,
    security: &State<'_, SecurityState>,
    requested_profile: &HostProfile,
) -> Result<SshConnectPlan, EngineError> {
    let resolved_profile = resolve_connect_profile(app, security, requested_profile)?;
    let jump_profiles = resolve_jump_profiles(app, security, &resolved_profile)?;
    let mut jump_spec = JumpHostSpec::default();
    for jump_profile in jump_profiles {
        let expected_host_key = enforce_host_key_policy(app, &jump_profile, &jump_spec).await?;
        jump_spec.hosts.push(JumpHostProfile {
            profile: jump_profile,
            expected_host_key,
        });
    }
    let expected_host_key = enforce_host_key_policy(app, &resolved_profile, &jump_spec).await?;
    Ok(SshConnectPlan {
        profile: resolved_profile,
        expected_host_key,
        jump_spec,
    })
}

async fn enforce_host_key_policy(
    app: &AppHandle,
    profile: &HostProfile,
    jump_spec: &JumpHostSpec,
) -> Result<Option<ExpectedHostKey>, EngineError> {
    let settings = read_session_settings(app)?;
    if settings.host_key_policy == HostKeyPolicy::Off {
        return Ok(None);
    }

    // 连接建立前先做一次 Host Key 预检。
    // ask / strict 的分流都在这里完成，正式握手阶段只负责校验“当前连接拿到的公钥”
    // 是否与本次预检允许通过的公钥一致。
    let probe = probe_host_key(profile, jump_spec).await?;
    let matched = match_host_key(
        app,
        &profile.host,
        profile.port,
        &probe.key_algorithm,
        &probe.public_key_base64,
    )?;

    match (settings.host_key_policy, matched.status) {
        (_, HostKeyMatchStatus::Trusted) => Ok(Some(ExpectedHostKey {
            public_key_base64: probe.public_key_base64,
            fingerprint_sha256: probe.fingerprint_sha256,
        })),
        (HostKeyPolicy::Strict, HostKeyMatchStatus::Unknown) => Err(EngineError::new(
            "ssh_host_key_unknown",
            "Target host is not trusted and the current host key policy blocks the connection",
        )),
        (HostKeyPolicy::Strict, HostKeyMatchStatus::Mismatch) => Err(EngineError::new(
            "ssh_host_key_mismatch",
            "Target host fingerprint does not match the local record; connection blocked",
        )),
        (HostKeyPolicy::Ask, HostKeyMatchStatus::Unknown) => {
            emit_host_key_required(app, profile, &probe, None, "ask")?;
            Err(EngineError::new(
                "ssh_host_key_unknown",
                "First connection to this host; waiting for host key confirmation",
            ))
        }
        (HostKeyPolicy::Ask, HostKeyMatchStatus::Mismatch) => {
            emit_host_key_required(
                app,
                profile,
                &probe,
                matched.previous_fingerprint_sha256,
                "ask",
            )?;
            Err(EngineError::new(
                "ssh_host_key_mismatch",
                "Target host fingerprint does not match the local record; waiting for confirmation",
            ))
        }
        (HostKeyPolicy::Off, _) => Ok(None),
    }
}

fn emit_host_key_required(
    app: &AppHandle,
    profile: &HostProfile,
    probe: &engine::HostKeyProbe,
    previous_fingerprint_sha256: Option<String>,
    policy: &str,
) -> Result<(), EngineError> {
    // 这里不携带 sessionId。
    // ask 模式下本次连接已经被中断，前端收到事件后要么新建连接，要么继续某条既有重连链路。
    app.emit(
        "ssh:host-key-verification-required",
        HostKeyVerificationRequiredPayload {
            profile_id: profile.id.clone(),
            host: profile.host.clone(),
            port: profile.port,
            key_algorithm: probe.key_algorithm.clone(),
            public_key_base64: probe.public_key_base64.clone(),
            fingerprint_sha256: probe.fingerprint_sha256.clone(),
            previous_fingerprint_sha256,
            policy: policy.to_string(),
        },
    )
    .map_err(|err| {
        EngineError::with_detail(
            "ssh_host_key_event_failed",
            "Failed to emit host key confirmation event",
            err.to_string(),
        )
    })
}

fn resolve_connect_profile(
    app: &AppHandle,
    security: &State<'_, SecurityState>,
    requested_profile: &HostProfile,
) -> Result<HostProfile, EngineError> {
    // 连接时必须回读磁盘中的 profile，再按当前安全状态解保护。
    // 这样在用户锁定后，即使前端仍保留旧的明文副本，也不能继续建立 SSH 连接。
    if requested_profile.id.trim().is_empty() {
        return Err(EngineError::new("profile_not_found", "Profile not found"));
    }
    let store = read_ssh_profiles(app)?;
    let encrypted_profile = store
        .profiles
        .into_iter()
        .find(|item| item.id == requested_profile.id)
        .ok_or_else(|| EngineError::new("profile_not_found", "Profile not found"))?;
    let security_config = read_security_config(app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    let secret_store = SecretStore::new(&crypto);
    decrypt_profile_secrets(encrypted_profile, &secret_store)
}

fn resolve_jump_profiles(
    app: &AppHandle,
    security: &State<'_, SecurityState>,
    profile: &HostProfile,
) -> Result<Vec<HostProfile>, EngineError> {
    let ids = profile.jump_profile_ids.clone().unwrap_or_default();
    if ids.len() > 8 {
        return Err(EngineError::with_detail(
            "ssh_jump_depth_exceeded",
            "Jump chain exceeds the maximum depth",
            format!("maxDepth=8 actual={}", ids.len()),
        ));
    }
    let mut seen = HashSet::new();
    seen.insert(profile.id.clone());
    for id in &ids {
        if !seen.insert(id.clone()) {
            return Err(EngineError::new(
                "ssh_jump_cycle",
                "Jump chain contains a cycle",
            ));
        }
    }

    let store = read_ssh_profiles(app)?;
    let security_config = read_security_config(app)?;
    let session = security.current_session();
    let crypto = CryptoService::new(security_config.as_ref(), session.as_ref())?;
    let secret_store = SecretStore::new(&crypto);
    ids.into_iter()
        .map(|id| {
            let encrypted_profile = store
                .profiles
                .iter()
                .find(|item| item.id == id)
                .cloned()
                .ok_or_else(|| {
                    EngineError::new("ssh_jump_profile_missing", "Jump host profile not found")
                })?;
            decrypt_profile_secrets(encrypted_profile, &secret_store)
        })
        .collect()
}
