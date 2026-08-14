//! FluxTerm 统一结构化日志核心。
//!
//! 本 crate 只负责日志记录的校验、脱敏、大小控制和 `log` facade 路由，
//! 不采集性能指标，也不提供任何外发能力。

use std::cmp::Reverse;

use log::Level;
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// 单条日志正文的最大 UTF-8 字节数。
pub const MAX_RECORD_BYTES: usize = 4 * 1024;
/// 普通字符串字段的最大 UTF-8 字节数。
pub const MAX_STRING_BYTES: usize = 512;
/// 错误详情的最大 UTF-8 字节数。
pub const MAX_ERROR_DETAIL_BYTES: usize = 1024;

const MAX_DEPTH: usize = 6;
const MAX_ARRAY_ITEMS: usize = 32;
const MAX_OBJECT_FIELDS: usize = 64;
const INVALID_EVENT: &str = "logging.record.invalid";
const INVALID_MESSAGE: &str = "Structured log record is invalid";

/// FluxTerm 结构化日志级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    /// 开发诊断信息。
    Debug,
    /// 最终成功结果或稳定状态变化。
    Info,
    /// 应用可继续运行的操作失败或降级。
    Warn,
    /// 子系统不可继续运行或存在状态、数据风险。
    Error,
}

impl LogLevel {
    fn as_log_level(self) -> Level {
        match self {
            Self::Debug => Level::Debug,
            Self::Info => Level::Info,
            Self::Warn => Level::Warn,
            Self::Error => Level::Error,
        }
    }
}

/// 创建跨层操作关联 ID。
pub fn create_operation_id() -> String {
    Uuid::new_v4().to_string()
}

/// 输出结构化日志。
///
/// 调用方应通过 [`log_event!`] 使用本函数，以便自动写入 crate 与模块来源。
pub fn emit(
    level: LogLevel,
    event: &str,
    component: &str,
    target: &str,
    operation_id: Option<&str>,
    fields: Value,
) {
    let payload = build_record(event, component, operation_id, fields);
    let line = serde_json::to_string(&payload).unwrap_or_else(|_| {
        r#"{"event":"logging.record.invalid","message":"Structured log record is invalid","component":"logging","error":{"code":"logging_serialization_failed","message":"Structured log serialization failed"}}"#.to_string()
    });
    log::log!(target: target, level.as_log_level(), "{line}");
}

/// 在调用位置输出结构化日志。
///
/// 支持带操作 ID 的四参数形式，以及不需要操作 ID 的三参数形式。
#[macro_export]
macro_rules! log_event {
    ($level:expr, $event:expr, $operation_id:expr, $fields:expr $(,)?) => {{
        $crate::emit(
            $level,
            $event,
            env!("CARGO_PKG_NAME"),
            module_path!(),
            $operation_id,
            $fields,
        )
    }};
    ($level:expr, $event:expr, $fields:expr $(,)?) => {{
        $crate::emit(
            $level,
            $event,
            env!("CARGO_PKG_NAME"),
            module_path!(),
            None,
            $fields,
        )
    }};
}

/// 构造并清洗结构化日志正文。
pub fn build_record(
    event: &str,
    component: &str,
    operation_id: Option<&str>,
    fields: Value,
) -> Value {
    if !is_valid_event_name(event) {
        return invalid_record(component, "logging_invalid_event");
    }

    let mut payload = Map::new();
    payload.insert("event".to_string(), Value::String(event.to_string()));
    let canonical_message = message_from_event(event);
    payload.insert(
        "message".to_string(),
        Value::String(canonical_message.clone()),
    );
    payload.insert(
        "component".to_string(),
        Value::String(truncate_utf8(component.trim(), MAX_STRING_BYTES)),
    );
    if let Some(value) = operation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload.insert(
            "operationId".to_string(),
            Value::String(truncate_utf8(value, MAX_STRING_BYTES)),
        );
    }

    if let Value::Object(fields) = fields {
        for (index, (key, value)) in fields.into_iter().enumerate() {
            if index >= MAX_OBJECT_FIELDS {
                payload.insert("truncated".to_string(), Value::Bool(true));
                break;
            }
            if is_core_reserved_key(&key) || is_sensitive_key(&key) {
                continue;
            }
            if key == "error" {
                if let Some(error) = sanitize_error(value, &canonical_message) {
                    payload.insert(key, error);
                }
                continue;
            }
            if let Some(value) = sanitize_value(value, &key, 0) {
                payload.insert(key, value);
            }
        }
    }

    enforce_record_limit(&mut payload);
    Value::Object(payload)
}

fn is_valid_event_name(value: &str) -> bool {
    if value.is_empty() || value.starts_with('.') || value.ends_with('.') {
        return false;
    }
    value.split('.').all(|segment| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
    })
}

fn message_from_event(event: &str) -> String {
    event
        .split('.')
        .map(|segment| match segment {
            "ai" => "AI".to_string(),
            "api" => "API".to_string(),
            "rdp" => "RDP".to_string(),
            "sftp" => "SFTP".to_string(),
            "ssh" => "SSH".to_string(),
            "tls" => "TLS".to_string(),
            "ui" => "UI".to_string(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn invalid_record(component: &str, code: &str) -> Value {
    json!({
        "event": INVALID_EVENT,
        "message": INVALID_MESSAGE,
        "component": truncate_utf8(component, MAX_STRING_BYTES),
        "error": {
            "code": code,
            "message": "Structured log record was rejected"
        }
    })
}

fn is_core_reserved_key(key: &str) -> bool {
    matches!(
        key,
        "event" | "message" | "component" | "operationId" | "truncated"
    )
}

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_sensitive_key(key: &str) -> bool {
    matches!(
        normalized_key(key).as_str(),
        "password"
            | "passwordref"
            | "passphrase"
            | "privatekey"
            | "privatekeypassphraseref"
            | "apikey"
            | "token"
            | "cookie"
            | "authorization"
            | "secret"
            | "ciphertext"
            | "user"
            | "username"
            | "domain"
            | "path"
            | "localpath"
            | "remotepath"
            | "filename"
            | "filepath"
            | "terminaloutput"
            | "recentterminaloutput"
            | "terminalinput"
            | "command"
            | "clipboard"
            | "clipboardtext"
            | "messages"
            | "prompt"
            | "selectiontext"
            | "response"
            | "content"
    )
}

fn sanitize_value(value: Value, key: &str, depth: usize) -> Option<Value> {
    if depth >= MAX_DEPTH || is_sensitive_key(key) {
        return None;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Some(value),
        Value::String(value) => Some(Value::String(truncate_utf8(&value, MAX_STRING_BYTES))),
        Value::Array(values) => {
            let values = values
                .into_iter()
                .take(MAX_ARRAY_ITEMS)
                .filter_map(|value| sanitize_value(value, key, depth + 1))
                .collect();
            Some(Value::Array(values))
        }
        Value::Object(values) => {
            let mut sanitized = Map::new();
            for (index, (nested_key, nested_value)) in values.into_iter().enumerate() {
                if index >= MAX_OBJECT_FIELDS {
                    break;
                }
                if is_sensitive_key(&nested_key) || is_core_reserved_key(&nested_key) {
                    continue;
                }
                if let Some(value) = sanitize_value(nested_value, &nested_key, depth + 1) {
                    sanitized.insert(nested_key, value);
                }
            }
            Some(Value::Object(sanitized))
        }
    }
}

fn sanitize_error(value: Value, canonical_message: &str) -> Option<Value> {
    let Value::Object(mut error) = value else {
        return None;
    };
    let code = error
        .remove("code")
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "unknown_error".to_string());
    let provided_message = error
        .remove("message")
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "Operation failed".to_string());
    let detail = error
        .remove("detail")
        .or_else(|| error.remove("details"))
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .or_else(|| (provided_message != canonical_message).then_some(provided_message));

    let mut sanitized = Map::new();
    sanitized.insert(
        "code".to_string(),
        Value::String(truncate_utf8(&code, MAX_STRING_BYTES)),
    );
    sanitized.insert(
        "message".to_string(),
        Value::String(truncate_utf8(canonical_message, MAX_STRING_BYTES)),
    );
    if let Some(detail) = detail {
        sanitized.insert(
            "detail".to_string(),
            Value::String(truncate_utf8(
                &redact_absolute_paths(&detail),
                MAX_ERROR_DETAIL_BYTES,
            )),
        );
    }
    Some(Value::Object(sanitized))
}

fn redact_absolute_paths(value: &str) -> String {
    value
        .split_whitespace()
        .map(|part| {
            let looks_like_windows_path = part.len() > 3
                && part.as_bytes().get(1) == Some(&b':')
                && matches!(part.as_bytes().get(2), Some(b'\\' | b'/'));
            let looks_like_unc_path = part.starts_with(r"\\");
            let looks_like_home_path = part.starts_with("/home/") || part.starts_with("/Users/");
            if looks_like_windows_path || looks_like_unc_path || looks_like_home_path {
                "[REDACTED_PATH]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value[..boundary].to_string()
}

fn encoded_len(payload: &Map<String, Value>) -> usize {
    serde_json::to_vec(payload)
        .map(|value| value.len())
        .unwrap_or(usize::MAX)
}

fn enforce_record_limit(payload: &mut Map<String, Value>) {
    if encoded_len(payload) <= MAX_RECORD_BYTES {
        return;
    }
    payload.insert("truncated".to_string(), Value::Bool(true));

    if let Some(Value::Object(error)) = payload.get_mut("error") {
        error.remove("detail");
    }
    if encoded_len(payload) <= MAX_RECORD_BYTES {
        return;
    }

    let mut removable = payload
        .iter()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "event" | "message" | "component" | "operationId" | "error" | "truncated"
            )
        })
        .map(|(key, value)| {
            (
                key.clone(),
                serde_json::to_vec(value)
                    .map(|value| value.len())
                    .unwrap_or(0),
            )
        })
        .collect::<Vec<_>>();
    removable.sort_by_key(|(_, size)| Reverse(*size));
    for (key, _) in removable {
        payload.remove(&key);
        if encoded_len(payload) <= MAX_RECORD_BYTES {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::thread;

    use super::*;

    #[test]
    fn removes_connection_identity_and_preserves_safe_fields() {
        let record = build_record(
            "ssh.session.connect.succeeded",
            "engine",
            Some("operation-1"),
            json!({
                "host": "10.0.0.8",
                "user": "root",
                "username": "root",
                "domain": "example",
                "passwordRef": "enc:v1:ciphertext",
                "sessionId": "session-1"
            }),
        );
        assert_eq!(record["operationId"], "operation-1");
        assert_eq!(record["host"], "10.0.0.8");
        assert_eq!(record["sessionId"], "session-1");
        assert!(record.get("user").is_none());
        assert!(record.get("username").is_none());
        assert!(record.get("domain").is_none());
        assert!(record.get("passwordRef").is_none());
    }

    #[test]
    fn rejects_reserved_and_sensitive_fields() {
        let record = build_record(
            "settings.persist.failed",
            "fluxterm",
            None,
            json!({
                "event": "overridden",
                "component": "overridden",
                "password": "secret",
                "localPath": "C:\\Users\\someone\\settings.json",
                "fileName": "settings.json"
            }),
        );
        assert_eq!(record["event"], "settings.persist.failed");
        assert_eq!(record["component"], "fluxterm");
        assert!(record.get("password").is_none());
        assert!(record.get("localPath").is_none());
        assert!(record.get("fileName").is_none());
    }

    #[test]
    fn sanitizes_error_and_redacts_absolute_paths() {
        let record = build_record(
            "settings.persist.failed",
            "fluxterm",
            None,
            json!({
                "error": {
                    "code": "settings_write_failed",
                    "message": "Failed to write settings",
                    "detail": "write C:\\Users\\someone\\settings.json failed"
                }
            }),
        );
        assert_eq!(record["error"]["code"], "settings_write_failed");
        assert_eq!(record["error"]["message"], "settings persist failed");
        assert!(
            record["error"]["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("[REDACTED_PATH]"))
        );
    }

    #[test]
    fn truncates_utf8_without_breaking_characters() {
        let value = "终".repeat(MAX_STRING_BYTES);
        let record = build_record(
            "logging.string.truncated",
            "logging",
            None,
            json!({ "value": value }),
        );
        let value = record["value"].as_str().expect("string value");
        assert!(value.len() <= MAX_STRING_BYTES);
        assert!(value.is_char_boundary(value.len()));
    }

    #[test]
    fn enforces_total_record_limit() {
        let record = build_record(
            "logging.record.large",
            "logging",
            None,
            json!({
                "a": "a".repeat(MAX_STRING_BYTES),
                "b": "b".repeat(MAX_STRING_BYTES),
                "c": "c".repeat(MAX_STRING_BYTES),
                "d": "d".repeat(MAX_STRING_BYTES),
                "e": "e".repeat(MAX_STRING_BYTES),
                "f": "f".repeat(MAX_STRING_BYTES),
                "g": "g".repeat(MAX_STRING_BYTES),
                "h": "h".repeat(MAX_STRING_BYTES),
                "i": "i".repeat(MAX_STRING_BYTES)
            }),
        );
        assert!(serde_json::to_vec(&record).expect("encode").len() <= MAX_RECORD_BYTES);
        assert_eq!(record["truncated"], true);
    }

    #[test]
    fn falls_back_for_invalid_event_name() {
        let record = build_record("ssh_connect:start", "engine", None, json!({}));
        assert_eq!(record["event"], INVALID_EVENT);
        assert_eq!(record["error"]["code"], "logging_invalid_event");
    }

    #[test]
    fn record_building_is_thread_safe() {
        let handles = (0..16)
            .map(|index| {
                thread::spawn(move || {
                    build_record(
                        "logging.concurrent.succeeded",
                        "logging",
                        None,
                        json!({ "index": index }),
                    )
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            let record = handle.join().expect("thread");
            assert_eq!(record["event"], "logging.concurrent.succeeded");
        }
    }
}
