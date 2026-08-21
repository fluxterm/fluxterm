//! AI 能力命令。

const AI_EVENT_EMIT_FAILED_CODE: &str = "ai_event_emit_failed";
const AI_REQUEST_FAILED_CODE: &str = "ai_request_failed";

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use engine::EngineError;
use openai::OpenAiSessionChatResponse;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::{
    AiRuntimeState, cancel_chat_stream, context, finish_chat_stream, get_cached_response,
    read_active_provider_config, read_provider_config_by_id, register_chat_stream,
    store_cached_response,
};
use crate::ai_settings::{
    AiSettingsSaveInput, AiSettingsView, read_ai_settings, read_ai_settings_view,
    save_ai_settings_input,
};

/// 读取终端 AI 助手配置。
#[tauri::command]
pub fn ai_settings_get(app: AppHandle) -> Result<AiSettingsView, EngineError> {
    read_ai_settings_view(&app)
}

/// 保存终端 AI 助手配置。
#[tauri::command]
pub fn ai_settings_save(
    app: AppHandle,
    settings: AiSettingsSaveInput,
) -> Result<AiSettingsView, EngineError> {
    save_ai_settings_input(&app, settings)
}

/// 测试当前 AI 接入是否可用。
#[tauri::command]
pub async fn ai_provider_test(
    app: AppHandle,
    provider_id: Option<String>,
) -> Result<(), EngineError> {
    let config = read_provider_config_by_id(&app, provider_id.as_deref())?;
    openai::test_connection(&config)
        .await
        .map_err(map_openai_error)
}

/// 基于当前会话上下文执行问答。
#[tauri::command]
pub async fn ai_session_chat(
    state: State<'_, AiRuntimeState>,
    app: AppHandle,
    request: context::AiSessionChatRequest,
) -> Result<OpenAiSessionChatResponse, EngineError> {
    let settings = read_ai_settings(&app)?;
    let config = read_active_provider_config(&app)?;
    let input = context::build_session_chat_input(&state, request, &settings)?;
    let cache_key = build_cache_key("session_chat", &input)?;
    if let Some(content) = get_cached_response(&state, &cache_key)? {
        return Ok(OpenAiSessionChatResponse {
            message: openai::ChatMessage {
                role: "assistant".to_string(),
                content,
            },
        });
    }
    let response = openai::chat_session(&config, input)
        .await
        .map_err(map_openai_error)?;
    store_cached_response(
        &state,
        cache_key,
        response.message.content.clone(),
        settings.request_cache_ttl_ms,
    )?;
    Ok(response)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChatChunkPayload {
    request_id: String,
    session_id: String,
    content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChatDonePayload {
    request_id: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChatErrorPayload {
    request_id: String,
    session_id: String,
    error: EngineError,
}

/// 启动会话上下文问答流式输出。
#[tauri::command]
pub async fn ai_session_chat_stream_start(
    app: AppHandle,
    state: State<'_, AiRuntimeState>,
    request: context::AiSessionChatStreamRequest,
) -> Result<(), EngineError> {
    let settings = read_ai_settings(&app)?;
    let config = read_active_provider_config(&app)?;
    let stream_request_id = request.request_id.clone();
    let input = context::build_session_chat_stream_input(&state, request, &settings)?;
    let cache_key = build_cache_key(
        "session_chat",
        &openai::OpenAiSessionChatInput {
            context: input.context.clone(),
            response_language_strategy: input.response_language_strategy.clone(),
            ui_language: input.ui_language.clone(),
            messages: input.messages.clone(),
        },
    )?;
    if let Some(content) = get_cached_response(&state, &cache_key)? {
        app.emit(
            "ai:chat-chunk",
            AiChatChunkPayload {
                request_id: input.request_id.clone(),
                session_id: input.context.session_id.clone(),
                content,
            },
        )
        .map_err(|err| {
            EngineError::with_detail(
                AI_EVENT_EMIT_FAILED_CODE,
                "Failed to emit the AI streaming event",
                err.to_string(),
            )
        })?;
        app.emit(
            "ai:chat-done",
            AiChatDonePayload {
                request_id: input.request_id,
                session_id: input.context.session_id,
            },
        )
        .map_err(|err| {
            EngineError::with_detail(
                AI_EVENT_EMIT_FAILED_CODE,
                "Failed to emit the AI streaming event",
                err.to_string(),
            )
        })?;
        return Ok(());
    }
    let cancelled = register_chat_stream(&state, &stream_request_id)?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 后端负责把模型增量文本转成前端事件，前端只按 requestId 追加当前 assistant 消息。
        let request_id = input.request_id.clone();
        let session_id = input.context.session_id.clone();
        let emit_handle = app_handle.clone();
        let mut streamed_content = String::new();
        let result = openai::chat_session_stream(
            &config,
            input,
            |content: &str| {
                streamed_content.push_str(content);
                emit_handle
                    .emit(
                        "ai:chat-chunk",
                        AiChatChunkPayload {
                            request_id: request_id.clone(),
                            session_id: session_id.clone(),
                            content: content.to_string(),
                        },
                    )
                    .map_err(|err| OpenAiToEngineError::from_emit(err).into_openai())?;
                Ok(())
            },
            || cancelled.load(std::sync::atomic::Ordering::SeqCst),
        )
        .await;

        let state_handle = app_handle.state::<AiRuntimeState>();
        let _ = finish_chat_stream(&state_handle, &request_id);
        match result {
            Ok(()) => {
                if !cancelled.load(std::sync::atomic::Ordering::SeqCst)
                    && !streamed_content.is_empty()
                {
                    let _ = store_cached_response(
                        &state_handle,
                        cache_key,
                        streamed_content.clone(),
                        settings.request_cache_ttl_ms,
                    );
                }
                let _ = app_handle.emit(
                    "ai:chat-done",
                    AiChatDonePayload {
                        request_id,
                        session_id,
                    },
                );
            }
            Err(error) => {
                let _ = app_handle.emit(
                    "ai:chat-error",
                    AiChatErrorPayload {
                        request_id,
                        session_id,
                        error: map_openai_error(error),
                    },
                );
            }
        }
    });
    Ok(())
}

/// 取消会话上下文问答流式输出。
#[tauri::command]
pub fn ai_session_chat_stream_cancel(
    state: State<'_, AiRuntimeState>,
    request_id: String,
) -> Result<bool, EngineError> {
    cancel_chat_stream(&state, &request_id)
}

fn build_cache_key(label: &str, value: &impl Serialize) -> Result<String, EngineError> {
    let serialized = serde_json::to_string(value).map_err(|err| {
        EngineError::with_detail(
            "ai_cache_key_invalid",
            "Failed to generate the AI request cache key",
            err.to_string(),
        )
    })?;
    let mut hasher = DefaultHasher::new();
    label.hash(&mut hasher);
    serialized.hash(&mut hasher);
    Ok(format!("{label}:{}", hasher.finish()))
}

fn map_openai_error(error: openai::OpenAiError) -> EngineError {
    match error {
        openai::OpenAiError::Config(message) => EngineError::new("ai_unavailable", message),
        openai::OpenAiError::Timeout(message) => EngineError::new("ai_timeout", message),
        openai::OpenAiError::RateLimited(message) => EngineError::new("ai_rate_limited", message),
        openai::OpenAiError::ResponseInvalid(message) => {
            EngineError::new("ai_response_invalid", message)
        }
        openai::OpenAiError::Request(message) => EngineError::new(AI_REQUEST_FAILED_CODE, message),
        openai::OpenAiError::Http(_, message) => EngineError::new(AI_REQUEST_FAILED_CODE, message),
    }
}

struct OpenAiToEngineError(EngineError);

impl OpenAiToEngineError {
    fn from_emit(error: tauri::Error) -> Self {
        Self(EngineError::with_detail(
            AI_EVENT_EMIT_FAILED_CODE,
            "Failed to emit the AI streaming event",
            error.to_string(),
        ))
    }

    fn into_openai(self) -> openai::OpenAiError {
        openai::OpenAiError::Request(self.0.message)
    }
}
