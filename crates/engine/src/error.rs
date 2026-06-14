//! 引擎错误类型定义。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// 引擎错误类型，统一携带错误码、兜底消息、翻译键与可选细节。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineError {
    pub code: String,
    pub message: String,
    #[serde(
        rename = "messageKey",
        alias = "message_key",
        skip_serializing_if = "Option::is_none"
    )]
    pub message_key: Option<String>,
    #[serde(
        rename = "messageVars",
        alias = "message_vars",
        skip_serializing_if = "Option::is_none"
    )]
    pub message_vars: Option<Box<Value>>,
    #[serde(rename = "details", alias = "detail")]
    pub detail: Option<String>,
}

impl EngineError {
    /// 创建仅包含错误码与消息的错误。
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            message_key: None,
            message_vars: None,
            detail: None,
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
        Self {
            code: code.into(),
            message: message.into(),
            message_key: None,
            message_vars: None,
            detail: Some(detail.into()),
        }
    }

    /// 附加前端翻译键。
    pub fn with_message_key(mut self, message_key: impl Into<String>) -> Self {
        self.message_key = Some(message_key.into());
        self
    }

    /// 附加前端翻译变量。
    pub fn with_message_vars(mut self, message_vars: Value) -> Self {
        self.message_vars = Some(Box::new(message_vars));
        self
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(detail) => write!(f, "{}: {} ({detail})", self.code, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for EngineError {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::EngineError;

    #[test]
    fn serializes_localized_fields_with_compat_details_name() {
        let error = EngineError::with_detail(
            "ssh_auth_failed",
            "SSH authentication was rejected by the server",
            "Permission denied",
        )
        .with_message_key("error.ssh.auth.rejected")
        .with_message_vars(json!({ "host": "127.0.0.1" }));

        let value = serde_json::to_value(error).expect("serialize engine error");

        assert_eq!(value["code"], "ssh_auth_failed");
        assert_eq!(
            value["message"],
            "SSH authentication was rejected by the server"
        );
        assert_eq!(value["messageKey"], "error.ssh.auth.rejected");
        assert_eq!(value["messageVars"]["host"], "127.0.0.1");
        assert_eq!(value["details"], "Permission denied");
        assert!(value.get("detail").is_none());
    }

    #[test]
    fn deserializes_legacy_detail_alias() {
        let error: EngineError = serde_json::from_value(json!({
            "code": "ssh_auth_failed",
            "message": "SSH authentication failed",
            "detail": "legacy detail"
        }))
        .expect("deserialize engine error");

        assert_eq!(error.detail.as_deref(), Some("legacy detail"));
    }
}
