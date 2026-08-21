//! 引擎错误类型定义。
use serde::Serialize;
use serde_json::Number;
use std::{collections::BTreeMap, fmt};

const AI_OPERATION_FAILED_KEY: &str = "error.ai.operationFailed";
const BACKEND_OPERATION_FAILED_KEY: &str = "error.backend.operationFailed";
const PROXY_OPERATION_FAILED_KEY: &str = "error.proxy.operationFailed";
const RDP_OPERATION_FAILED_KEY: &str = "error.rdp.operationFailed";
const REMOTE_EDIT_OPERATION_FAILED_KEY: &str = "error.remoteEdit.operationFailed";
const SECURITY_OPERATION_FAILED_KEY: &str = "error.security.operationFailed";
const SERIAL_OPERATION_FAILED_KEY: &str = "error.serial.operationFailed";
const SESSION_OPERATION_FAILED_KEY: &str = "error.session.operationFailed";
const SFTP_OPERATION_FAILED_KEY: &str = "error.sftp.operationFailed";
const SSH_OPERATION_FAILED_KEY: &str = "error.ssh.operationFailed";
const SYSTEM_OPERATION_FAILED_KEY: &str = "error.system.operationFailed";

/// 错误翻译变量允许使用的标量值。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum MessageVar {
    String(String),
    Number(Number),
}

impl MessageVar {
    /// 当变量为字符串时返回其内容。
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            Self::Number(_) => None,
        }
    }
}

impl From<String> for MessageVar {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for MessageVar {
    fn from(value: &str) -> Self {
        Self::String(value.to_string())
    }
}

impl From<i64> for MessageVar {
    fn from(value: i64) -> Self {
        Self::Number(value.into())
    }
}

impl From<u64> for MessageVar {
    fn from(value: u64) -> Self {
        Self::Number(value.into())
    }
}

/// 错误翻译变量集合。
pub type MessageVars = BTreeMap<String, MessageVar>;

/// 引擎错误类型，统一携带错误码、兜底消息、翻译键与可选细节。
#[derive(Debug, Clone, Serialize)]
pub struct EngineError {
    pub code: String,
    pub message: String,
    #[serde(rename = "messageKey", skip_serializing_if = "Option::is_none")]
    pub message_key: Option<String>,
    #[serde(rename = "messageVars", skip_serializing_if = "Option::is_none")]
    pub message_vars: Option<Box<MessageVars>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl EngineError {
    /// 创建仅包含错误码与消息的错误。
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        let code = code.into();
        debug_assert!(is_valid_error_code(&code), "invalid error code: {code}");
        Self {
            message_key: Some(default_message_key(&code).to_string()),
            code,
            message: message.into(),
            message_vars: None,
            details: None,
        }
    }

    /// 创建包含错误码、兜底消息与前端翻译键的错误。
    pub fn localized(
        code: impl Into<String>,
        message: impl Into<String>,
        message_key: impl Into<String>,
    ) -> Self {
        Self::new(code, message).with_message_key(message_key)
    }

    /// 创建包含详细信息的错误。
    pub fn with_detail(
        code: impl Into<String>,
        message: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        let code = code.into();
        debug_assert!(is_valid_error_code(&code), "invalid error code: {code}");
        Self {
            message_key: Some(default_message_key(&code).to_string()),
            code,
            message: message.into(),
            message_vars: None,
            details: Some(detail.into()),
        }
    }

    /// 附加前端翻译键。
    pub fn with_message_key(mut self, message_key: impl Into<String>) -> Self {
        let message_key = message_key.into();
        debug_assert!(
            is_valid_message_key(&message_key),
            "invalid message key: {message_key}"
        );
        self.message_key = Some(message_key);
        self
    }

    /// 附加前端翻译变量。
    pub fn with_message_vars(mut self, message_vars: MessageVars) -> Self {
        self.message_vars = Some(Box::new(message_vars));
        self
    }
}

/// 判断错误码是否符合小写蛇形命名。
fn is_valid_error_code(value: &str) -> bool {
    !value.is_empty()
        && value.split('_').all(|segment| {
            !segment.is_empty()
                && segment.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_lowercase() || (index > 0 && byte.is_ascii_digit())
                })
        })
}

/// 判断翻译键是否符合点分 lowerCamelCase 命名。
fn is_valid_message_key(value: &str) -> bool {
    let mut segments = value.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    let mut segment_count = 1;
    let valid_segment = |segment: &str| {
        segment.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() && (index > 0 || byte.is_ascii_lowercase())
        }) && !segment.is_empty()
    };
    if !valid_segment(first) {
        return false;
    }
    for segment in segments {
        segment_count += 1;
        if !valid_segment(segment) {
            return false;
        }
    }
    segment_count >= 2
}

/// 根据稳定错误码提供跨 Tauri 边界使用的默认翻译键。
fn default_message_key(code: &str) -> &'static str {
    if code.starts_with("serial_") {
        SERIAL_OPERATION_FAILED_KEY
    } else if code.starts_with("sftp_") {
        SFTP_OPERATION_FAILED_KEY
    } else if code.starts_with("ssh_") {
        SSH_OPERATION_FAILED_KEY
    } else if code.starts_with("proxy_") {
        PROXY_OPERATION_FAILED_KEY
    } else if code.starts_with("rdp_") {
        RDP_OPERATION_FAILED_KEY
    } else if code.starts_with("remote_edit_") {
        REMOTE_EDIT_OPERATION_FAILED_KEY
    } else if code.starts_with("ai_") {
        AI_OPERATION_FAILED_KEY
    } else if code.starts_with("security_")
        || code.starts_with("crypto_")
        || code.starts_with("secret_")
    {
        SECURITY_OPERATION_FAILED_KEY
    } else if code.starts_with("local_")
        || code.starts_with("file_")
        || code.starts_with("config_")
        || code.starts_with("data_")
        || code.starts_with("profile_")
    {
        SYSTEM_OPERATION_FAILED_KEY
    } else if code.starts_with("session_") {
        SESSION_OPERATION_FAILED_KEY
    } else {
        BACKEND_OPERATION_FAILED_KEY
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.details {
            Some(detail) => write!(f, "{}: {} ({detail})", self.code, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for EngineError {}

#[cfg(test)]
mod tests {
    use super::{EngineError, MessageVar, MessageVars};

    #[test]
    fn serializes_localized_fields() {
        let error = EngineError::with_detail(
            "ssh_test_auth_failed",
            "SSH authentication was rejected by the server",
            "Permission denied",
        )
        .with_message_key("error.ssh.auth.rejected")
        .with_message_vars(MessageVars::from([
            ("host".to_string(), MessageVar::from("127.0.0.1")),
            ("attempt".to_string(), MessageVar::from(2_u64)),
        ]));

        let value = serde_json::to_value(error).expect("serialize engine error");

        assert_eq!(value["code"], "ssh_test_auth_failed");
        assert_eq!(
            value["message"],
            "SSH authentication was rejected by the server"
        );
        assert_eq!(value["messageKey"], "error.ssh.auth.rejected");
        assert_eq!(value["messageVars"]["host"], "127.0.0.1");
        assert_eq!(value["messageVars"]["attempt"], 2);
        assert_eq!(value["details"], "Permission denied");
        assert!(value.get("detail").is_none());
    }

    #[test]
    fn assigns_default_message_key_by_error_domain() {
        let error = EngineError::new("serial_test_open_failed", "Failed to open serial port");
        assert_eq!(
            error.message_key.as_deref(),
            Some("error.serial.operationFailed")
        );
        let value = serde_json::to_value(error).expect("serialize engine error");
        assert!(value.get("details").is_none());
    }
}
