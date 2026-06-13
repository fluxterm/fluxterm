//! SSH 认证逻辑。
use std::path::Path;
use std::sync::Arc;

use russh::MethodKind;
use russh::client::{self, AuthResult};
use russh::keys::{self, PrivateKeyWithHashAlg};
use serde_json::json;

use crate::error::EngineError;
use crate::session::ClientHandler;
use crate::telemetry::{TelemetryLevel, log_telemetry};
use crate::types::{AuthType, HostProfile};

/// SSH 认证用途，用于区分会话连接与资源监控等链路。
#[derive(Clone, Copy)]
pub enum AuthPurpose {
    Session,
    ResourceMonitor,
}

impl AuthPurpose {
    fn start_event(self) -> &'static str {
        match self {
            AuthPurpose::Session => "ssh.session.auth.start",
            AuthPurpose::ResourceMonitor => "ssh.resource_monitor.auth.start",
        }
    }

    fn success_event(self) -> &'static str {
        match self {
            AuthPurpose::Session => "ssh.session.auth.success",
            AuthPurpose::ResourceMonitor => "ssh.resource_monitor.auth.success",
        }
    }

    fn failed_event(self) -> &'static str {
        match self {
            AuthPurpose::Session => "ssh.session.auth.failed",
            AuthPurpose::ResourceMonitor => "ssh.resource_monitor.auth.failed",
        }
    }
}

/// 执行 SSH 认证流程。
pub async fn authenticate(
    session: &mut client::Handle<ClientHandler>,
    profile: &HostProfile,
    purpose: AuthPurpose,
) -> Result<(), EngineError> {
    log_telemetry(
        TelemetryLevel::Info,
        purpose.start_event(),
        None,
        json!({
            "profileId": profile.id,
            "user": profile.username,
            "authType": format!("{:?}", profile.auth_type),
        }),
    );
    let authenticated = match profile.auth_type {
        AuthType::Password => {
            let password = profile
                .password_ref
                .clone()
                .ok_or_else(|| EngineError::new("ssh_auth_failed", "缺少密码"))?;
            let result = session
                .authenticate_password(profile.username.clone(), password)
                .await
                .map_err(|err| {
                    EngineError::with_detail("ssh_auth_failed", "密码认证失败", err.to_string())
                })?;
            match result {
                AuthResult::Success => result,
                AuthResult::Failure {
                    remaining_methods, ..
                } => {
                    if !remaining_methods.contains(&MethodKind::Password) {
                        return Err(EngineError::new("ssh_auth_failed", "目标不支持密码认证"));
                    }
                    return Err(EngineError::new(
                        "ssh_auth_failed",
                        "认证被服务器拒绝，请检查用户名、密码或目标主机登录策略（例如 root 登录权限）",
                    ));
                }
            }
        }
        AuthType::PrivateKey => {
            let key_path = profile
                .private_key_path
                .clone()
                .ok_or_else(|| EngineError::new("ssh_auth_failed", "缺少私钥路径"))?;
            let key = load_key(&key_path, profile.private_key_passphrase_ref.as_deref())?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            let result = session
                .authenticate_publickey(profile.username.clone(), key)
                .await
                .map_err(|err| {
                    EngineError::with_detail("ssh_auth_failed", "密钥认证失败", err.to_string())
                })?;
            match result {
                AuthResult::Success => result,
                AuthResult::Failure {
                    remaining_methods, ..
                } => {
                    if !remaining_methods.contains(&MethodKind::PublicKey) {
                        return Err(EngineError::new("ssh_auth_failed", "目标不支持私钥认证"));
                    }
                    return Err(EngineError::new("ssh_auth_failed", "私钥认证失败"));
                }
            }
        }
        AuthType::Agent => {
            return Err(EngineError::new("ssh_auth_failed", "Agent 认证暂未实现"));
        }
    };

    if !authenticated.success() {
        log_telemetry(
            TelemetryLevel::Warn,
            purpose.failed_event(),
            None,
            json!({
                "profileId": profile.id,
                "user": profile.username,
                "authType": format!("{:?}", profile.auth_type),
                "error": {
                    "code": "ssh_auth_failed",
                    "message": "认证未成功",
                    "detail": Option::<String>::None,
                }
            }),
        );
        return Err(EngineError::new("ssh_auth_failed", "认证未成功"));
    }

    log_telemetry(
        TelemetryLevel::Info,
        purpose.success_event(),
        None,
        json!({
            "profileId": profile.id,
            "user": profile.username,
            "authType": format!("{:?}", profile.auth_type),
        }),
    );
    Ok(())
}

/// 从本地读取密钥文件。
fn load_key(path: &str, passphrase: Option<&str>) -> Result<keys::PrivateKey, EngineError> {
    keys::load_secret_key(Path::new(path), passphrase)
        .map_err(|err| EngineError::with_detail("ssh_auth_failed", "无法读取密钥", err.to_string()))
}
