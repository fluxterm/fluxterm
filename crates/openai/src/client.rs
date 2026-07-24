//! OpenAI HTTP 客户端。

use std::time::{Duration, Instant};

use fluxterm_logging::{LogLevel, create_operation_id, log_event};
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::OpenAiError;
use crate::prompts::build_session_chat_messages;
use crate::types::{
    ChatMessage, OpenAiClientConfig, OpenAiSessionChatInput, OpenAiSessionChatResponse,
    OpenAiSessionChatStreamInput,
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
    complete_chat(config, messages).await
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
    stream_chat_completion(config, messages, on_chunk, is_cancelled).await
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
    complete_chat(config, messages).await.map(|_| ())
}

async fn request_chat_completion(
    config: &OpenAiClientConfig,
    messages: Vec<ChatMessage>,
    json_mode: bool,
) -> Result<ChatCompletionsResponse, OpenAiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .build()
        .map_err(|err| {
            OpenAiError::Request(format!("Failed to create the OpenAI client: {err}"))
        })?;

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

    let body = response.text().await.map_err(|err| {
        OpenAiError::ResponseInvalid(format!("Failed to read the OpenAI response: {err}"))
    })?;
    let json = serde_json::from_str::<Value>(&body).map_err(|err| {
        OpenAiError::ResponseInvalid(format!("Failed to parse the OpenAI response: {err}"))
    })?;
    extract_chat_completion_response(&json)
}

async fn complete_chat(
    config: &OpenAiClientConfig,
    messages: Vec<ChatMessage>,
) -> Result<OpenAiSessionChatResponse, OpenAiError> {
    let operation_id = create_operation_id();
    let started = Instant::now();
    let result = async {
        let response = request_chat_completion(config, messages, false).await?;
        let message = response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| {
                OpenAiError::ResponseInvalid("OpenAI returned no candidate message".to_string())
            })?
            .message;
        Ok(OpenAiSessionChatResponse { message })
    }
    .await;
    match result {
        Ok(response) => {
            log_event!(
                LogLevel::Info,
                "openai.request.succeeded",
                Some(&operation_id),
                json!({
                    "provider": "openaiCompatible",
                    "model": config.model,
                    "status": "succeeded",
                    "durationMs": started.elapsed().as_millis(),
                }),
            );
            Ok(response)
        }
        Err(error) => {
            log_openai_failure(config, &operation_id, started.elapsed(), &error);
            Err(error)
        }
    }
}

#[derive(Clone, Copy)]
enum StreamCompletion {
    Succeeded,
    Cancelled,
}

async fn stream_chat_completion(
    config: &OpenAiClientConfig,
    messages: Vec<ChatMessage>,
    mut on_chunk: impl FnMut(&str) -> Result<(), OpenAiError>,
    is_cancelled: impl Fn() -> bool,
) -> Result<(), OpenAiError> {
    let operation_id = create_operation_id();
    let started = Instant::now();
    let result = stream_chat_completion_inner(config, messages, &mut on_chunk, &is_cancelled).await;
    match result {
        Ok(StreamCompletion::Succeeded) => {
            log_event!(
                LogLevel::Info,
                "openai.request.succeeded",
                Some(&operation_id),
                json!({
                    "provider": "openaiCompatible",
                    "model": config.model,
                    "status": "succeeded",
                    "durationMs": started.elapsed().as_millis(),
                }),
            );
            Ok(())
        }
        Ok(StreamCompletion::Cancelled) => {
            log_event!(
                LogLevel::Info,
                "openai.request.cancelled",
                Some(&operation_id),
                json!({
                    "provider": "openaiCompatible",
                    "model": config.model,
                    "status": "cancelled",
                    "durationMs": started.elapsed().as_millis(),
                }),
            );
            Ok(())
        }
        Err(error) => {
            log_openai_failure(config, &operation_id, started.elapsed(), &error);
            Err(error)
        }
    }
}

async fn stream_chat_completion_inner(
    config: &OpenAiClientConfig,
    messages: Vec<ChatMessage>,
    on_chunk: &mut impl FnMut(&str) -> Result<(), OpenAiError>,
    is_cancelled: &impl Fn() -> bool,
) -> Result<StreamCompletion, OpenAiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .build()
        .map_err(|err| {
            OpenAiError::Request(format!("Failed to create the OpenAI client: {err}"))
        })?;

    let base = config.base_url.trim_end_matches('/');
    let endpoint = build_chat_completions_endpoint(base);
    let request = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true
    });

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
    while let Some(chunk) = response.chunk().await.map_err(map_transport_error)? {
        if is_cancelled() {
            return Ok(StreamCompletion::Cancelled);
        }
        let text = String::from_utf8_lossy(&chunk).replace("\r\n", "\n");
        buffer.push_str(&text);
        while let Some(delimiter) = buffer.find("\n\n") {
            let event = buffer[..delimiter].to_string();
            buffer.drain(..delimiter + 2);
            if let Some(piece) = parse_stream_event(&event)? {
                on_chunk(&piece)?;
            }
        }
    }

    if !buffer.trim().is_empty()
        && let Some(piece) = parse_stream_event(buffer.trim())?
    {
        on_chunk(&piece)?;
    }

    Ok(StreamCompletion::Succeeded)
}

fn log_openai_failure(
    config: &OpenAiClientConfig,
    operation_id: &str,
    duration: Duration,
    error: &OpenAiError,
) {
    log_event!(
        LogLevel::Warn,
        "openai.request.failed",
        Some(operation_id),
        json!({
            "provider": "openaiCompatible",
            "model": config.model,
            "status": "failed",
            "durationMs": duration.as_millis(),
            "error": {
                "code": openai_error_code(error),
                "message": "OpenAI request failed",
            }
        }),
    );
}

fn openai_error_code(error: &OpenAiError) -> &'static str {
    match error {
        OpenAiError::Config(_) => "openai_config_invalid",
        OpenAiError::Request(_) => "openai_request_failed",
        OpenAiError::RateLimited(_) => "openai_rate_limited",
        OpenAiError::Timeout(_) => "openai_timeout",
        OpenAiError::Http(_, _) => "openai_http_error",
        OpenAiError::ResponseInvalid(_) => "openai_response_invalid",
    }
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
        return OpenAiError::Timeout("OpenAI request timed out".to_string());
    }
    OpenAiError::Request(format!("OpenAI request failed: {err}"))
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
        .unwrap_or_else(|| "OpenAI request failed".to_string())
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
        .ok_or_else(|| {
            OpenAiError::ResponseInvalid("OpenAI response is missing choices".to_string())
        })?;

    let parsed = choices
        .iter()
        .map(extract_choice)
        .collect::<Result<Vec<_>, _>>()?;

    if parsed.is_empty() {
        return Err(OpenAiError::ResponseInvalid(
            "OpenAI returned no candidate message".to_string(),
        ));
    }

    Ok(ChatCompletionsResponse { choices: parsed })
}

fn extract_choice(value: &Value) -> Result<Choice, OpenAiError> {
    let message = value.get("message").ok_or_else(|| {
        OpenAiError::ResponseInvalid("OpenAI response is missing message".to_string())
    })?;
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
                    "OpenAI response contains no readable content".to_string(),
                ));
            }
            Ok(content)
        }
        Some(Value::Null) | None => Err(OpenAiError::ResponseInvalid(
            "OpenAI response is missing content".to_string(),
        )),
        Some(other) => Err(OpenAiError::ResponseInvalid(format!(
            "OpenAI response content type is unsupported: {}",
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
        let json = serde_json::from_str::<Value>(payload).map_err(|err| {
            OpenAiError::ResponseInvalid(format!(
                "Failed to parse the streaming response event: {err}"
            ))
        })?;
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
            "OpenAI streaming response content type is unsupported: {}",
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
}
