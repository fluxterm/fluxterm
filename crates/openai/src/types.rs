//! OpenAI crate 对外数据类型。

use serde::{Deserialize, Serialize};

/// 对话消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// OpenAI 客户端配置。
#[derive(Debug, Clone)]
pub struct OpenAiClientConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u64,
}

/// 会话上下文快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextSnapshot {
    pub session_id: String,
    pub session_label: String,
    pub session_kind: String,
    pub host: Option<String>,
    pub username: Option<String>,
    pub platform: Option<String>,
    pub shell_name: Option<String>,
    pub session_state: String,
    pub resource_monitor_status: Option<String>,
    pub host_key_status: Option<String>,
    pub recent_terminal_output: Vec<String>,
}

/// AI 响应语言策略。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseLanguageStrategy {
    FollowUi,
    FollowUserInput,
}

/// 会话上下文问答输入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiSessionChatInput {
    pub context: SessionContextSnapshot,
    pub response_language_strategy: ResponseLanguageStrategy,
    pub ui_language: String,
    pub messages: Vec<ChatMessage>,
}

/// 终端选中文本解释输入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiSelectionExplainInput {
    pub context: SessionContextSnapshot,
    pub response_language_strategy: ResponseLanguageStrategy,
    pub ui_language: String,
    pub selection_text: String,
}

/// 会话上下文问答输出。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiSessionChatResponse {
    pub message: ChatMessage,
}

/// 会话上下文问答流式输入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiSessionChatStreamInput {
    pub request_id: String,
    pub context: SessionContextSnapshot,
    pub response_language_strategy: ResponseLanguageStrategy,
    pub ui_language: String,
    pub messages: Vec<ChatMessage>,
}
