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

const SSH_AUTH_FAILED_CODE: &str = "ssh_auth_failed";

const SSH_AUTH_MISSING_PASSWORD_KEY: &str = "error.ssh.auth.missingPassword";
const SSH_AUTH_PASSWORD_FAILED_KEY: &str = "error.ssh.auth.passwordFailed";
const SSH_AUTH_PASSWORD_UNSUPPORTED_KEY: &str = "error.ssh.auth.passwordUnsupported";
const SSH_AUTH_REJECTED_KEY: &str = "error.ssh.auth.rejected";
const SSH_AUTH_MISSING_PRIVATE_KEY: &str = "error.ssh.auth.missingPrivateKey";
const SSH_AUTH_PUBLIC_KEY_FAILED_KEY: &str = "error.ssh.auth.publicKeyFailed";
const SSH_AUTH_PUBLIC_KEY_UNSUPPORTED_KEY: &str = "error.ssh.auth.publicKeyUnsupported";
const SSH_AUTH_PUBLIC_KEY_REJECTED_KEY: &str = "error.ssh.auth.publicKeyRejected";
const SSH_AUTH_AGENT_UNSUPPORTED_KEY: &str = "error.ssh.auth.agentUnsupported";
const SSH_AUTH_NOT_AUTHENTICATED_KEY: &str = "error.ssh.auth.notAuthenticated";
const SSH_AUTH_KEY_READ_FAILED_KEY: &str = "error.ssh.auth.keyReadFailed";

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
                    SSH_AUTH_FAILED_CODE,
                    "SSH password is missing",
                    SSH_AUTH_MISSING_PASSWORD_KEY,
                )
            })?;
            let result = session
                .authenticate_password(profile.username.clone(), password)
                .await
                .map_err(|err| {
                    EngineError::with_detail(
                        SSH_AUTH_FAILED_CODE,
                        "SSH password authentication failed",
                        err.to_string(),
                    )
                    .with_message_key(SSH_AUTH_PASSWORD_FAILED_KEY)
                })?;
            match result {
                AuthResult::Success => result,
                AuthResult::Failure {
                    remaining_methods, ..
                } => {
                    if !remaining_methods.contains(&MethodKind::Password) {
                        return Err(EngineError::new(
                            SSH_AUTH_FAILED_CODE,
                            "The server does not support password authentication",
                        )
                        .with_message_key(SSH_AUTH_PASSWORD_UNSUPPORTED_KEY));
                    }
                    return Err(EngineError::localized(
                        SSH_AUTH_FAILED_CODE,
                        "SSH authentication was rejected by the server",
                        SSH_AUTH_REJECTED_KEY,
                    ));
                }
            }
        }
        AuthType::PrivateKey => {
            let key_path = profile.private_key_path.clone().ok_or_else(|| {
                EngineError::localized(
                    SSH_AUTH_FAILED_CODE,
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
                        SSH_AUTH_FAILED_CODE,
                        "SSH public key authentication failed",
                        err.to_string(),
                    )
                    .with_message_key(SSH_AUTH_PUBLIC_KEY_FAILED_KEY)
                })?;
            match result {
                AuthResult::Success => result,
                AuthResult::Failure {
                    remaining_methods, ..
                } => {
                    if !remaining_methods.contains(&MethodKind::PublicKey) {
                        return Err(EngineError::new(
                            SSH_AUTH_FAILED_CODE,
                            "The server does not support public key authentication",
                        )
                        .with_message_key(SSH_AUTH_PUBLIC_KEY_UNSUPPORTED_KEY));
                    }
                    return Err(EngineError::localized(
                        SSH_AUTH_FAILED_CODE,
                        "SSH public key authentication was rejected by the server",
                        SSH_AUTH_PUBLIC_KEY_REJECTED_KEY,
                    ));
                }
            }
        }
        AuthType::Agent => {
            return Err(EngineError::localized(
                SSH_AUTH_FAILED_CODE,
                "SSH agent authentication is not supported yet",
                SSH_AUTH_AGENT_UNSUPPORTED_KEY,
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
                    "messageKey": SSH_AUTH_NOT_AUTHENTICATED_KEY,
                    "detail": Option::<String>::None,
                }
            }),
        );
        return Err(EngineError::localized(
            SSH_AUTH_FAILED_CODE,
            "SSH authentication did not complete",
            SSH_AUTH_NOT_AUTHENTICATED_KEY,
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
            SSH_AUTH_FAILED_CODE,
            "Unable to read SSH private key",
            err.to_string(),
        )
        .with_message_key(SSH_AUTH_KEY_READ_FAILED_KEY)
    })
}
