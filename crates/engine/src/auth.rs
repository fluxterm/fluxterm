//! SSH 认证逻辑。
use std::path::Path;
use std::sync::Arc;

use russh::MethodKind;
use russh::client::{self, AuthResult};
use russh::keys::{self, PrivateKeyWithHashAlg};
use serde_json::json;

use fluxterm_logging::{LogLevel, log_event};

use crate::error::EngineError;
use crate::session::ClientHandler;
use crate::types::{AuthType, HostProfile};

const SSH_AUTH_MISSING_PASSWORD: &str = "error.ssh.auth.missingPassword";
const SSH_AUTH_PASSWORD_FAILED: &str = "error.ssh.auth.passwordFailed";
const SSH_AUTH_PASSWORD_UNSUPPORTED: &str = "error.ssh.auth.passwordUnsupported";
const SSH_AUTH_REJECTED: &str = "error.ssh.auth.rejected";
const SSH_AUTH_MISSING_PRIVATE_KEY: &str = "error.ssh.auth.missingPrivateKey";
const SSH_AUTH_PUBLIC_KEY_FAILED: &str = "error.ssh.auth.publicKeyFailed";
const SSH_AUTH_PUBLIC_KEY_UNSUPPORTED: &str = "error.ssh.auth.publicKeyUnsupported";
const SSH_AUTH_PUBLIC_KEY_REJECTED: &str = "error.ssh.auth.publicKeyRejected";
const SSH_AUTH_AGENT_UNSUPPORTED: &str = "error.ssh.auth.agentUnsupported";
const SSH_AUTH_NOT_AUTHENTICATED: &str = "error.ssh.auth.notAuthenticated";
const SSH_AUTH_KEY_READ_FAILED: &str = "error.ssh.auth.keyReadFailed";

/// SSH 认证用途，用于区分会话连接与资源监控等链路。
#[derive(Clone, Copy)]
pub enum AuthPurpose {
    Session,
    Jump,
    ResourceMonitor,
}

impl AuthPurpose {
    fn connection_purpose(self) -> &'static str {
        match self {
            AuthPurpose::Session => "session",
            AuthPurpose::Jump => "jumpHost",
            AuthPurpose::ResourceMonitor => "resourceMonitor",
        }
    }
}

/// 执行 SSH 认证流程。
pub async fn authenticate(
    session: &mut client::Handle<ClientHandler>,
    profile: &HostProfile,
    purpose: AuthPurpose,
    operation_id: Option<&str>,
) -> Result<(), EngineError> {
    log_event!(
        LogLevel::Debug,
        "ssh.authentication.started",
        operation_id,
        json!({
            "profileId": profile.id,
            "host": profile.host,
            "user": profile.username,
            "authType": format!("{:?}", profile.auth_type),
            "connectionPurpose": purpose.connection_purpose(),
        }),
    );
    let authenticated = match profile.auth_type {
        AuthType::Password => {
            let password = profile.password_ref.clone().ok_or_else(|| {
                EngineError::localized(
                    "ssh_auth_failed",
                    "SSH password is missing",
                    SSH_AUTH_MISSING_PASSWORD,
                )
            })?;
            let result = session
                .authenticate_password(profile.username.clone(), password)
                .await
                .map_err(|err| {
                    EngineError::with_detail(
                        "ssh_auth_failed",
                        "SSH password authentication failed",
                        err.to_string(),
                    )
                    .with_message_key(SSH_AUTH_PASSWORD_FAILED)
                })?;
            match result {
                AuthResult::Success => result,
                AuthResult::Failure {
                    remaining_methods, ..
                } => {
                    if !remaining_methods.contains(&MethodKind::Password) {
                        return Err(EngineError::new(
                            "ssh_auth_failed",
                            "The server does not support password authentication",
                        )
                        .with_message_key(SSH_AUTH_PASSWORD_UNSUPPORTED));
                    }
                    return Err(EngineError::localized(
                        "ssh_auth_failed",
                        "SSH authentication was rejected by the server",
                        SSH_AUTH_REJECTED,
                    ));
                }
            }
        }
        AuthType::PrivateKey => {
            let key_path = profile.private_key_path.clone().ok_or_else(|| {
                EngineError::localized(
                    "ssh_auth_failed",
                    "SSH private key path is missing",
                    SSH_AUTH_MISSING_PRIVATE_KEY,
                )
            })?;
            let key = load_key(&key_path, profile.private_key_passphrase_ref.as_deref())?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            let result = session
                .authenticate_publickey(profile.username.clone(), key)
                .await
                .map_err(|err| {
                    EngineError::with_detail(
                        "ssh_auth_failed",
                        "SSH public key authentication failed",
                        err.to_string(),
                    )
                    .with_message_key(SSH_AUTH_PUBLIC_KEY_FAILED)
                })?;
            match result {
                AuthResult::Success => result,
                AuthResult::Failure {
                    remaining_methods, ..
                } => {
                    if !remaining_methods.contains(&MethodKind::PublicKey) {
                        return Err(EngineError::new(
                            "ssh_auth_failed",
                            "The server does not support public key authentication",
                        )
                        .with_message_key(SSH_AUTH_PUBLIC_KEY_UNSUPPORTED));
                    }
                    return Err(EngineError::localized(
                        "ssh_auth_failed",
                        "SSH public key authentication was rejected by the server",
                        SSH_AUTH_PUBLIC_KEY_REJECTED,
                    ));
                }
            }
        }
        AuthType::Agent => {
            return Err(EngineError::localized(
                "ssh_auth_failed",
                "SSH agent authentication is not supported yet",
                SSH_AUTH_AGENT_UNSUPPORTED,
            ));
        }
    };

    if !authenticated.success() {
        log_event!(
            LogLevel::Debug,
            "ssh.authentication.failed",
            operation_id,
            json!({
                "profileId": profile.id,
                "host": profile.host,
                "user": profile.username,
                "authType": format!("{:?}", profile.auth_type),
                "connectionPurpose": purpose.connection_purpose(),
                "error": {
                    "code": "ssh_auth_failed",
                    "message": "SSH authentication did not complete",
                    "messageKey": SSH_AUTH_NOT_AUTHENTICATED,
                    "detail": Option::<String>::None,
                }
            }),
        );
        return Err(EngineError::localized(
            "ssh_auth_failed",
            "SSH authentication did not complete",
            SSH_AUTH_NOT_AUTHENTICATED,
        ));
    }

    log_event!(
        LogLevel::Debug,
        "ssh.authentication.succeeded",
        operation_id,
        json!({
            "profileId": profile.id,
            "host": profile.host,
            "user": profile.username,
            "authType": format!("{:?}", profile.auth_type),
            "connectionPurpose": purpose.connection_purpose(),
        }),
    );
    Ok(())
}

/// 从本地读取密钥文件。
fn load_key(path: &str, passphrase: Option<&str>) -> Result<keys::PrivateKey, EngineError> {
    keys::load_secret_key(Path::new(path), passphrase).map_err(|err| {
        EngineError::with_detail(
            "ssh_auth_failed",
            "Unable to read SSH private key",
            err.to_string(),
        )
        .with_message_key(SSH_AUTH_KEY_READ_FAILED)
    })
}
