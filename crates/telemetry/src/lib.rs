//! FluxTerm 统一埋点 payload 构造工具。
//!
//! 本 crate 只负责事件名归一化、`traceId` 合并和 JSON payload 生成，
//! 具体日志级别路由仍由各业务 crate 的薄封装决定。

use serde_json::{Map, Value};

/// 构造统一埋点 payload。
///
/// `event` 会被归一化为小写点分段；`traceId` 仅在非空时写入；
/// `fields` 中的空 `traceId` 会被忽略，且不会覆盖显式参数中的值。
pub fn build_payload(event: &str, trace_id: Option<&str>, fields: Value) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "event".to_string(),
        Value::String(normalize_event_name(event)),
    );
    if let Some(value) = trace_id {
        insert_trace_id(&mut payload, value);
    }
    if let Value::Object(map) = fields {
        map.into_iter().for_each(|(key, value)| {
            if key == "traceId" {
                if let Value::String(trace_id) = value {
                    insert_trace_id(&mut payload, &trace_id);
                }
            } else {
                payload.insert(key, value);
            }
        });
    }
    Value::Object(payload)
}

/// 将事件名归一化为小写点分段。
pub fn normalize_event_name(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut previous_dot = false;
    for ch in value.trim().chars() {
        let next = if ch == ':' || ch == '_' || ch == '-' || ch == '.' {
            '.'
        } else {
            ch.to_ascii_lowercase()
        };
        if next == '.' {
            if !previous_dot {
                normalized.push(next);
            }
            previous_dot = true;
        } else {
            normalized.push(next);
            previous_dot = false;
        }
    }
    let trimmed = normalized.trim_matches('.');
    if trimmed.is_empty() {
        "runtime.log.update".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 写入非空 `traceId`。
pub fn insert_trace_id(payload: &mut Map<String, Value>, value: &str) {
    let trimmed = value.trim();
    if !trimmed.is_empty() && !payload.contains_key("traceId") {
        payload.insert("traceId".to_string(), Value::String(trimmed.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_event_name_to_dot_segments() {
        assert_eq!(
            normalize_event_name(" remote_edit.open-completed "),
            "remote.edit.open.completed"
        );
        assert_eq!(
            normalize_event_name("proxy.closeAll.start"),
            "proxy.closeall.start"
        );
        assert_eq!(normalize_event_name("..."), "runtime.log.update");
    }

    #[test]
    fn build_payload_omits_empty_trace_id() {
        let payload = build_payload("ssh.connect.start", Some(" "), json!({}));
        assert_eq!(payload.get("traceId"), None);
    }

    #[test]
    fn build_payload_prefers_explicit_trace_id() {
        let payload = build_payload(
            "ssh.connect.start",
            Some("outer"),
            json!({ "traceId": "inner", "sessionId": "s1" }),
        );
        assert_eq!(payload.get("traceId"), Some(&json!("outer")));
        assert_eq!(payload.get("sessionId"), Some(&json!("s1")));
    }
}
