//! AI 会话上下文构建模块。

use std::collections::HashSet;

use engine::EngineError;
use openai::{
    ChatMessage, OpenAiSessionChatInput, OpenAiSessionChatStreamInput, ResponseLanguageStrategy,
    SessionContextSnapshot,
};

use crate::ai::{AiRuntimeState, SessionContextRecord, with_store};
use crate::ai_settings::AiSettings;

/// 会话上下文问答请求。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionChatRequest {
    pub session_id: String,
    pub response_language_strategy: ResponseLanguageStrategy,
    pub ui_language: String,
    pub messages: Vec<ChatMessage>,
}

/// 会话上下文问答流式请求。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionChatStreamRequest {
    pub request_id: String,
    pub session_id: String,
    pub response_language_strategy: ResponseLanguageStrategy,
    pub ui_language: String,
    pub messages: Vec<ChatMessage>,
}

/// 从运行时缓存构建会话上下文问答输入。
pub fn build_session_chat_input(
    state: &AiRuntimeState,
    request: AiSessionChatRequest,
    settings: &AiSettings,
) -> Result<OpenAiSessionChatInput, EngineError> {
    with_store(state, |store| {
        let session = store.sessions.get(&request.session_id).ok_or_else(|| {
            EngineError::new(
                "ai_context_missing",
                "AI context for the current session was not found",
            )
        })?;
        Ok(OpenAiSessionChatInput {
            context: build_session_context_snapshot(
                session,
                settings.session_recent_output_max_snippets,
                settings.session_recent_output_max_chars,
            ),
            response_language_strategy: request.response_language_strategy,
            ui_language: request.ui_language,
            messages: request.messages,
        })
    })
}

/// 从运行时缓存构建流式会话上下文问答输入。
pub fn build_session_chat_stream_input(
    state: &AiRuntimeState,
    request: AiSessionChatStreamRequest,
    settings: &AiSettings,
) -> Result<OpenAiSessionChatStreamInput, EngineError> {
    with_store(state, |store| {
        let session = store.sessions.get(&request.session_id).ok_or_else(|| {
            EngineError::new(
                "ai_context_missing",
                "AI context for the current session was not found",
            )
        })?;
        Ok(OpenAiSessionChatStreamInput {
            request_id: request.request_id,
            context: build_session_context_snapshot(
                session,
                settings.session_recent_output_max_snippets,
                settings.session_recent_output_max_chars,
            ),
            response_language_strategy: request.response_language_strategy,
            ui_language: request.ui_language,
            messages: request.messages,
        })
    })
}

fn build_session_context_snapshot(
    session: &SessionContextRecord,
    recent_output_max_snippets: usize,
    recent_output_max_chars: usize,
) -> SessionContextSnapshot {
    SessionContextSnapshot {
        session_id: session.session_id.clone(),
        session_label: session.session_label.clone(),
        session_kind: session.session_kind.clone(),
        host: session.host.clone(),
        username: session.username.clone(),
        platform: session.platform.clone(),
        shell_name: session.shell_name.clone(),
        session_state: session.session_state.clone(),
        resource_monitor_status: session.resource_monitor_status.clone(),
        host_key_status: session.host_key_status.clone(),
        recent_terminal_output: compact_recent_output(
            &session.recent_terminal_output,
            recent_output_max_snippets,
            recent_output_max_chars,
        ),
    }
}

fn compact_recent_output(
    items: &std::collections::VecDeque<String>,
    max_snippets: usize,
    max_chars: usize,
) -> Vec<String> {
    let mut selected = items
        .iter()
        .rev()
        .take(max_snippets)
        .cloned()
        .collect::<Vec<_>>();
    selected.reverse();
    // 组装层再做一次去重，兜底采集层之前的历史脏数据或非连续重复片段。
    selected = dedup_recent_output(selected);

    while selected
        .iter()
        .map(|item| item.chars().count())
        .sum::<usize>()
        > max_chars
    {
        if selected.is_empty() {
            break;
        }
        selected.remove(0);
    }

    if selected.is_empty() && !items.is_empty() {
        let fallback = items
            .back()
            .map(|item| truncate_chars(item, max_chars))
            .unwrap_or_default();
        return vec![fallback];
    }

    selected
}

fn dedup_recent_output(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(items.len());
    for item in items {
        let key = normalize_recent_output_for_dedup(&item);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        deduped.push(item);
    }
    deduped
}

fn normalize_recent_output_for_dedup(input: &str) -> String {
    input
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(|line| normalize_whitespace_runs(line.trim()))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_whitespace_runs(input: &str) -> String {
    // 与采集层保持一致，避免“采集去重命中但组装去重失效”的规则漂移。
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(input: &str, limit: usize) -> String {
    if input.chars().count() <= limit {
        return input.to_string();
    }
    input.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiRuntimeState, register_local_session};
    use engine::{Session, SessionState};

    #[test]
    fn build_session_chat_input_requires_session() {
        let state = AiRuntimeState::default();
        let err = build_session_chat_input(
            &state,
            AiSessionChatRequest {
                session_id: "missing".to_string(),
                response_language_strategy: ResponseLanguageStrategy::FollowUserInput,
                ui_language: "zh-CN".to_string(),
                messages: vec![],
            },
            &crate::ai_settings::AiSettings {
                version: 1,
                selection_max_chars: 1_500,
                session_recent_output_max_chars: 1_200,
                session_recent_output_max_snippets: 4,
                selection_recent_output_max_chars: 600,
                selection_recent_output_max_snippets: 2,
                request_cache_ttl_ms: 15_000,
                request_timeout_ms: 20_000,
                debug_logging_enabled: true,
                active_provider_id: String::new(),
                providers: Vec::new(),
            },
        )
        .expect_err("missing session should fail");
        assert_eq!(err.code, "ai_context_missing");
    }

    #[test]
    fn build_session_chat_input_uses_registered_session() {
        let state = AiRuntimeState::default();
        register_local_session(
            &state,
            &Session {
                session_id: "local-1".to_string(),
                profile_id: Some("__local_shell__".to_string()),
                kind: engine::SessionKind::LocalShell,
                state: SessionState::Connected,
                created_at: 0,
                last_error: None,
            },
            "PowerShell",
            Some("PowerShell".to_string()),
        )
        .unwrap();

        let input = build_session_chat_input(
            &state,
            AiSessionChatRequest {
                session_id: "local-1".to_string(),
                response_language_strategy: ResponseLanguageStrategy::FollowUserInput,
                ui_language: "en-US".to_string(),
                messages: vec![ChatMessage {
                    role: "user".to_string(),
                    content: "pwd".to_string(),
                }],
            },
            &crate::ai_settings::default_ai_settings_for_test(),
        )
        .expect("session chat input should build");

        assert_eq!(input.context.session_label, "PowerShell");
        let expected_platform = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "unknown"
        };
        assert_eq!(input.context.platform.as_deref(), Some(expected_platform));
        assert_eq!(input.messages.len(), 1);
    }

    #[test]
    fn build_session_chat_input_applies_recent_output_budget() {
        let state = AiRuntimeState::default();
        register_local_session(
            &state,
            &Session {
                session_id: "local-4".to_string(),
                profile_id: Some("__local_shell__".to_string()),
                kind: engine::SessionKind::LocalShell,
                state: SessionState::Connected,
                created_at: 0,
                last_error: None,
            },
            "PowerShell",
            Some("PowerShell".to_string()),
        )
        .unwrap();

        crate::ai::record_terminal_output_for_test(&state, "local-4", "12345");
        crate::ai::record_terminal_output_for_test(&state, "local-4", "67890");
        crate::ai::record_terminal_output_for_test(&state, "local-4", "abcde");

        let input = build_session_chat_input(
            &state,
            AiSessionChatRequest {
                session_id: "local-4".to_string(),
                response_language_strategy: ResponseLanguageStrategy::FollowUserInput,
                ui_language: "zh-CN".to_string(),
                messages: vec![],
            },
            &crate::ai_settings::AiSettings {
                version: 1,
                selection_max_chars: 1_500,
                session_recent_output_max_chars: 10,
                session_recent_output_max_snippets: 2,
                selection_recent_output_max_chars: 600,
                selection_recent_output_max_snippets: 2,
                request_cache_ttl_ms: 15_000,
                request_timeout_ms: 20_000,
                debug_logging_enabled: true,
                active_provider_id: String::new(),
                providers: Vec::new(),
            },
        )
        .expect("session chat input should build");

        assert_eq!(
            input.context.recent_terminal_output,
            vec!["67890".to_string(), "abcde".to_string()]
        );
    }

    #[test]
    fn build_session_chat_input_dedups_recent_output() {
        let state = AiRuntimeState::default();
        register_local_session(
            &state,
            &Session {
                session_id: "local-5".to_string(),
                profile_id: Some("__local_shell__".to_string()),
                kind: engine::SessionKind::LocalShell,
                state: SessionState::Connected,
                created_at: 0,
                last_error: None,
            },
            "PowerShell",
            Some("PowerShell".to_string()),
        )
        .unwrap();

        crate::ai::record_terminal_output_for_test(&state, "local-5", "PS C:\\>");
        crate::ai::record_terminal_output_for_test(&state, "local-5", " PS   C:\\> \r\n");
        crate::ai::record_terminal_output_for_test(&state, "local-5", "dir");

        let input = build_session_chat_input(
            &state,
            AiSessionChatRequest {
                session_id: "local-5".to_string(),
                response_language_strategy: ResponseLanguageStrategy::FollowUserInput,
                ui_language: "zh-CN".to_string(),
                messages: vec![],
            },
            &crate::ai_settings::AiSettings {
                version: 1,
                selection_max_chars: 1_500,
                session_recent_output_max_chars: 1_200,
                session_recent_output_max_snippets: 4,
                selection_recent_output_max_chars: 600,
                selection_recent_output_max_snippets: 2,
                request_cache_ttl_ms: 15_000,
                request_timeout_ms: 20_000,
                debug_logging_enabled: true,
                active_provider_id: String::new(),
                providers: Vec::new(),
            },
        )
        .expect("session chat input should build");

        assert_eq!(
            input.context.recent_terminal_output,
            vec!["PS C:\\>".to_string(), "dir".to_string()]
        );
    }
}
