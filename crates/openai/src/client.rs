//! OpenAI HTTP 客户端。

use std::time::Duration;

use reqwest::StatusCode;
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::OpenAiError;
use crate::prompts::{build_selection_explain_messages, build_session_chat_messages};
use crate::telemetry::{TelemetryLevel, log_telemetry};
use crate::types::{
    ChatMessage, OpenAiClientConfig, OpenAiSelectionExplainInput, OpenAiSessionChatInput,
    OpenAiSessionChatResponse, OpenAiSessionChatStreamInput,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: String,
}

/// 执行会话上下文问答。
pub async fn chat_session(
    config: &OpenAiClientConfig,
    input: OpenAiSessionChatInput,
) -> Result<OpenAiSessionChatResponse, OpenAiError> {
    let messages = build_session_chat_messages(&input);
    complete_chat(config, messages, "session_chat").await
}

/// 基于终端选中文本执行解释。
pub async fn explain_selection(
    config: &OpenAiClientConfig,
    input: OpenAiSelectionExplainInput,
) -> Result<OpenAiSessionChatResponse, OpenAiError> {
    let messages = build_selection_explain_messages(&input);
    complete_chat(config, messages, "selection_explain").await
}

/// 以流式方式执行会话上下文问答。
pub async fn chat_session_stream(
    config: &OpenAiClientConfig,
    input: OpenAiSessionChatStreamInput,
    on_chunk: impl FnMut(&str) -> Result<(), OpenAiError>,
    is_cancelled: impl Fn() -> bool,
) -> Result<(), OpenAiError> {
    let messages = build_session_chat_messages(&OpenAiSessionChatInput {
        context: input.context,
        response_language_strategy: input.response_language_strategy,
        ui_language: input.ui_language,
        messages: input.messages,
    });
    stream_chat_completion(
        config,
        messages,
        "session_chat_stream",
        on_chunk,
        is_cancelled,
    )
    .await
}

/// 测试当前 OpenAI-compatible 接入是否可用。
pub async fn test_connection(config: &OpenAiClientConfig) -> Result<(), OpenAiError> {
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "Reply with exactly OK.".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: "connection test".to_string(),
        },
    ];
    complete_chat(config, messages, "connection_test")
        .await
        .map(|_| ())
}

async fn request_chat_completion(
    config: &OpenAiClientConfig,
    messages: Vec<ChatMessage>,
    json_mode: bool,
) -> Result<ChatCompletionsResponse, OpenAiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .build()
        .map_err(|err| OpenAiError::Request(format!("无法创建 OpenAI 客户端: {err}")))?;

    let base = config.base_url.trim_end_matches('/');
    let endpoint = build_chat_completions_endpoint(base);
    let request = ChatCompletionsRequest {
        model: config.model.clone(),
        messages,
        response_format: json_mode.then(|| ResponseFormat {
            kind: "json_object".to_string(),
        }),
    };

    let request_builder = client.post(endpoint).json(&request);
    let response = attach_bearer_auth(request_builder, &config.api_key)
        .send()
        .await
        .map_err(map_transport_error)?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let message = extract_error_message(&body);
        return match status {
            StatusCode::TOO_MANY_REQUESTS => Err(OpenAiError::RateLimited(message)),
            _ => Err(OpenAiError::Http(status.as_u16(), message)),
        };
    }

    let body = response
        .text()
        .await
        .map_err(|err| OpenAiError::ResponseInvalid(format!("无法读取 OpenAI 响应: {err}")))?;
    let json = serde_json::from_str::<Value>(&body)
        .map_err(|err| OpenAiError::ResponseInvalid(format!("无法解析 OpenAI 响应: {err}")))?;
    extract_chat_completion_response(&json)
}

async fn complete_chat(
    config: &OpenAiClientConfig,
    messages: Vec<ChatMessage>,
    request_type: &str,
) -> Result<OpenAiSessionChatResponse, OpenAiError> {
    log_request(config, request_type, &messages);
    match request_chat_completion(config, messages, false).await {
        Ok(response) => {
            let message = response
                .choices
                .into_iter()
                .next()
                .ok_or_else(|| OpenAiError::ResponseInvalid("OpenAI 未返回候选消息".to_string()))?
                .message;
            log_response(config, request_type, &message);
            Ok(OpenAiSessionChatResponse { message })
        }
        Err(error) => {
            log_error(config, request_type, &error);
            Err(error)
        }
    }
}

async fn stream_chat_completion(
    config: &OpenAiClientConfig,
    messages: Vec<ChatMessage>,
    request_type: &str,
    mut on_chunk: impl FnMut(&str) -> Result<(), OpenAiError>,
    is_cancelled: impl Fn() -> bool,
) -> Result<(), OpenAiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .build()
        .map_err(|err| OpenAiError::Request(format!("无法创建 OpenAI 客户端: {err}")))?;

    if config.debug_logging_enabled {
        log_system_prompt_summary(request_type, &messages);
    }

    let base = config.base_url.trim_end_matches('/');
    let endpoint = build_chat_completions_endpoint(base);
    let request = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true
    });

    if config.debug_logging_enabled {
        log_telemetry(
            TelemetryLevel::Debug,
            "openai.request.start",
            None,
            json!({
                "requestType": request_type,
                "model": config.model,
                "messageStats": build_message_stats(&messages),
            }),
        );
    }

    let request_builder = client.post(endpoint).json(&request);
    let mut response = attach_bearer_auth(request_builder, &config.api_key)
        .send()
        .await
        .map_err(map_transport_error)?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let message = extract_error_message(&body);
        return match status {
            StatusCode::TOO_MANY_REQUESTS => Err(OpenAiError::RateLimited(message)),
            _ => Err(OpenAiError::Http(status.as_u16(), message)),
        };
    }

    let mut buffer = String::new();
    let mut final_content = String::new();
    while let Some(chunk) = response.chunk().await.map_err(map_transport_error)? {
        if is_cancelled() {
            if config.debug_logging_enabled {
                log_telemetry(
                    TelemetryLevel::Debug,
                    "openai.response.cancelled",
                    None,
                    json!({
                        "requestType": request_type,
                        "cancelled": true,
                    }),
                );
            }
            return Ok(());
        }
        let text = String::from_utf8_lossy(&chunk).replace("\r\n", "\n");
        buffer.push_str(&text);
        while let Some(delimiter) = buffer.find("\n\n") {
            let event = buffer[..delimiter].to_string();
            buffer.drain(..delimiter + 2);
            if let Some(piece) = parse_stream_event(&event)? {
                final_content.push_str(&piece);
                on_chunk(&piece)?;
            }
        }
    }

    if !buffer.trim().is_empty()
        && let Some(piece) = parse_stream_event(buffer.trim())?
    {
        final_content.push_str(&piece);
        on_chunk(&piece)?;
    }

    log_response(
        config,
        request_type,
        &ChatMessage {
            role: "assistant".to_string(),
            content: final_content,
        },
    );
    Ok(())
}

fn log_request(config: &OpenAiClientConfig, request_type: &str, messages: &[ChatMessage]) {
    if !config.debug_logging_enabled {
        return;
    }
    log_system_prompt_summary(request_type, messages);
    log_telemetry(
        TelemetryLevel::Debug,
        "openai.request.start",
        None,
        json!({
            "requestType": request_type,
            "model": config.model,
            "messageStats": build_message_stats(messages),
        }),
    );
}

fn log_system_prompt_summary(request_type: &str, messages: &[ChatMessage]) {
    let Some(stats) = build_system_prompt_stats(messages) else {
        return;
    };
    log_telemetry(
        TelemetryLevel::Debug,
        "openai.request.summary",
        None,
        json!({
            "requestType": request_type,
            "systemPromptChars": stats.system_prompt_chars,
            "systemPromptHeadLines": stats.system_prompt_head_lines,
            "recentOutputChars": stats.recent_output_chars,
        }),
    );
}

fn build_system_prompt_stats(messages: &[ChatMessage]) -> Option<SystemPromptStats> {
    let system_prompt = messages
        .iter()
        .find(|message| message.role == "system")
        .map(|message| message.content.as_str())?;
    let normalized = system_prompt.replace("\r\n", "\n").replace('\r', "\n");
    let (head, recent_output) = normalized
        .split_once("\nRecent output:\n")
        .unwrap_or((normalized.as_str(), ""));
    Some(SystemPromptStats {
        system_prompt_chars: normalized.chars().count(),
        system_prompt_head_lines: head.lines().count(),
        recent_output_chars: recent_output.chars().count(),
    })
}

#[derive(Debug, PartialEq, Eq)]
struct SystemPromptStats {
    system_prompt_chars: usize,
    system_prompt_head_lines: usize,
    recent_output_chars: usize,
}

fn build_message_stats(messages: &[ChatMessage]) -> Value {
    let roles = messages
        .iter()
        .map(|message| message.role.as_str())
        .collect::<Vec<_>>();
    let content_chars = messages
        .iter()
        .map(|message| message.content.chars().count())
        .sum::<usize>();
    let system_prompt_chars = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.chars().count())
        .sum::<usize>();
    let user_content_chars = messages
        .iter()
        .filter(|message| message.role == "user")
        .map(|message| message.content.chars().count())
        .sum::<usize>();
    let recent_output_chars = build_system_prompt_stats(messages)
        .map(|stats| stats.recent_output_chars)
        .unwrap_or_default();
    json!({
        "messageCount": messages.len(),
        "roles": roles,
        "contentChars": content_chars,
        "systemPromptChars": system_prompt_chars,
        "recentOutputChars": recent_output_chars,
        "selectionChars": user_content_chars,
    })
}

fn log_response(config: &OpenAiClientConfig, request_type: &str, message: &ChatMessage) {
    if !config.debug_logging_enabled {
        return;
    }
    log_telemetry(
        TelemetryLevel::Debug,
        "openai.response.success",
        None,
        json!({
            "requestType": request_type,
            "responseRole": message.role,
            "responseChars": message.content.chars().count(),
        }),
    );
}

fn log_error(config: &OpenAiClientConfig, request_type: &str, error: &OpenAiError) {
    if !config.debug_logging_enabled {
        return;
    }
    log_telemetry(
        TelemetryLevel::Debug,
        "openai.request.failed",
        None,
        json!({
            "requestType": request_type,
            "error": {
                "code": "openai_request_failed",
                "message": error.to_string(),
                "detail": Option::<String>::None,
            }
        }),
    );
}

fn attach_bearer_auth(request: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        return request;
    }
    request.bearer_auth(api_key)
}

fn build_chat_completions_endpoint(base: &str) -> String {
    // 兼容用户填写 base_url 是否包含 /v1，避免生成 /v1/v1 路径导致 404。
    if base.ends_with("/v1") {
        return format!("{base}/chat/completions");
    }
    format!("{base}/v1/chat/completions")
}

fn map_transport_error(err: reqwest::Error) -> OpenAiError {
    if err.is_timeout() {
        return OpenAiError::Timeout("OpenAI 请求超时".to_string());
    }
    OpenAiError::Request(format!("OpenAI 请求失败: {err}"))
}

fn extract_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")?
                .get("message")?
                .as_str()
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| "OpenAI 请求失败".to_string())
}

#[derive(Debug)]
struct ChatCompletionsResponse {
    choices: Vec<Choice>,
}

#[derive(Debug)]
struct Choice {
    message: ChatMessage,
}

fn extract_chat_completion_response(json: &Value) -> Result<ChatCompletionsResponse, OpenAiError> {
    let choices = json
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| OpenAiError::ResponseInvalid("OpenAI 响应缺少 choices".to_string()))?;

    let parsed = choices
        .iter()
        .map(extract_choice)
        .collect::<Result<Vec<_>, _>>()?;

    if parsed.is_empty() {
        return Err(OpenAiError::ResponseInvalid(
            "OpenAI 未返回候选消息".to_string(),
        ));
    }

    Ok(ChatCompletionsResponse { choices: parsed })
}

fn extract_choice(value: &Value) -> Result<Choice, OpenAiError> {
    let message = value
        .get("message")
        .ok_or_else(|| OpenAiError::ResponseInvalid("OpenAI 响应缺少 message".to_string()))?;
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("assistant")
        .to_string();
    let content = extract_message_content(message)?;
    Ok(Choice {
        message: ChatMessage { role, content },
    })
}

fn extract_message_content(message: &Value) -> Result<String, OpenAiError> {
    match message.get("content") {
        Some(Value::String(text)) => Ok(text.clone()),
        Some(Value::Array(items)) => {
            let content = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<String>();
            if content.trim().is_empty() {
                return Err(OpenAiError::ResponseInvalid(
                    "OpenAI 响应缺少可读内容".to_string(),
                ));
            }
            Ok(content)
        }
        Some(Value::Null) | None => Err(OpenAiError::ResponseInvalid(
            "OpenAI 响应缺少 content".to_string(),
        )),
        Some(other) => Err(OpenAiError::ResponseInvalid(format!(
            "OpenAI 响应 content 类型不受支持: {}",
            other
        ))),
    }
}

fn parse_stream_event(event: &str) -> Result<Option<String>, OpenAiError> {
    let mut content = String::new();
    for line in event.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if !line.starts_with("data:") {
            continue;
        }
        let payload = line.trim_start_matches("data:").trim();
        if payload == "[DONE]" {
            return Ok(None);
        }
        let json = serde_json::from_str::<Value>(payload)
            .map_err(|err| OpenAiError::ResponseInvalid(format!("无法解析流式响应事件: {err}")))?;
        if let Some(delta) = extract_stream_delta_content(&json)? {
            content.push_str(&delta);
        }
    }
    if content.is_empty() {
        return Ok(None);
    }
    Ok(Some(content))
}

fn extract_stream_delta_content(json: &Value) -> Result<Option<String>, OpenAiError> {
    let Some(choice) = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return Ok(None);
    };
    let Some(delta) = choice.get("delta") else {
        return Ok(None);
    };
    match delta.get("content") {
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(Value::Array(items)) => {
            let content = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<String>();
            if content.is_empty() {
                return Ok(None);
            }
            Ok(Some(content))
        }
        Some(Value::Null) | None => Ok(None),
        Some(other) => Err(OpenAiError::ResponseInvalid(format!(
            "OpenAI 流式响应 content 类型不受支持: {}",
            other
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_string_content_from_openai_compatible_response() {
        let json = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "ok"
                    }
                }
            ]
        });

        let response = extract_chat_completion_response(&json).expect("response should parse");

        assert_eq!(response.choices[0].message.content, "ok");
    }

    #[test]
    fn extracts_text_blocks_from_array_content() {
        let json = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": [
                            { "type": "text", "text": "hello " },
                            { "type": "text", "text": "world" }
                        ]
                    }
                }
            ]
        });

        let response = extract_chat_completion_response(&json).expect("response should parse");

        assert_eq!(response.choices[0].message.content, "hello world");
    }

    #[test]
    fn parses_stream_event_content() {
        let event = r#"data: {"choices":[{"delta":{"content":"hello "}}]}

data: {"choices":[{"delta":{"content":"world"}}]}"#;

        let content = parse_stream_event(event)
            .expect("event should parse")
            .expect("content should exist");

        assert_eq!(content, "hello world");
    }

    #[test]
    fn builds_system_prompt_stats_without_content_preview() {
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "line1\nline2\nRecent output:\na\nb\nc".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: "hello".to_string(),
            },
        ];

        let stats = build_system_prompt_stats(&messages).expect("stats should exist");
        assert_eq!(
            stats,
            SystemPromptStats {
                system_prompt_chars: 31,
                system_prompt_head_lines: 2,
                recent_output_chars: 5,
            }
        );
    }
}
