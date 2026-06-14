//! SSH Host Key 预检能力。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::{self, HashAlg, PublicKeyBase64};
use tokio::time::timeout;

use crate::error::EngineError;
use crate::types::HostProfile;

/// Host Key 预检结果。
#[derive(Debug, Clone)]
pub struct HostKeyProbe {
    pub key_algorithm: String,
    pub public_key_base64: String,
    pub fingerprint_sha256: String,
}

/// Host Key 预检的连接超时秒数。
/// 目标不可达或端口未开放时，避免前端长时间无响应。
const SSH_HOST_KEY_PROBE_TIMEOUT_SECS: u64 = 8;
const SSH_HOST_KEY_PROBE_TIMEOUT: &str = "error.ssh.hostKey.probeTimeout";
const SSH_HOST_KEY_PROBE_LOCK_FAILED: &str = "error.ssh.hostKey.probeLockFailed";
const SSH_HOST_KEY_PROBE_FAILED: &str = "error.ssh.hostKey.probeFailed";

#[derive(Clone)]
struct ProbeHandler {
    key: Arc<Mutex<Option<keys::PublicKey>>>,
}

impl client::Handler for ProbeHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let mut guard = self
            .key
            .lock()
            .map_err(|_| anyhow::anyhow!("host key probe lock poisoned"))?;
        *guard = Some(server_public_key.clone());
        Ok(false)
    }
}

/// 预检目标主机的 Host Key。
pub async fn probe_host_key(profile: &HostProfile) -> Result<HostKeyProbe, EngineError> {
    let addr = format!("{}:{}", profile.host, profile.port);
    let config = Arc::new(client::Config::default());
    let key = Arc::new(Mutex::new(None));

    let connect_result = timeout(
        Duration::from_secs(SSH_HOST_KEY_PROBE_TIMEOUT_SECS),
        client::connect(
            config,
            addr,
            ProbeHandler {
                key: Arc::clone(&key),
            },
        ),
    )
    .await
    .map_err(|_| {
        EngineError::with_detail(
            "ssh_host_key_probe_failed",
            "Unable to fetch the target host key before the connection timed out",
            format!(
                "host={} port={} timeout={}s",
                profile.host, profile.port, SSH_HOST_KEY_PROBE_TIMEOUT_SECS
            ),
        )
        .with_message_key(SSH_HOST_KEY_PROBE_TIMEOUT)
    })?;

    let captured = key
        .lock()
        .map_err(|_| {
            EngineError::localized(
                "ssh_host_key_probe_failed",
                "Host key probe state is unavailable",
                SSH_HOST_KEY_PROBE_LOCK_FAILED,
            )
        })?
        .clone();

    if let Some(public_key) = captured {
        return Ok(HostKeyProbe {
            key_algorithm: public_key.algorithm().to_string(),
            public_key_base64: public_key.public_key_base64(),
            fingerprint_sha256: public_key.fingerprint(HashAlg::Sha256).to_string(),
        });
    }

    connect_result.map_err(|err| {
        EngineError::with_detail(
            "ssh_host_key_probe_failed",
            "Unable to fetch the target host key",
            err.to_string(),
        )
        .with_message_key(SSH_HOST_KEY_PROBE_FAILED)
    })?;

    Err(EngineError::localized(
        "ssh_host_key_probe_failed",
        "Unable to fetch the target host key",
        SSH_HOST_KEY_PROBE_FAILED,
    ))
}
