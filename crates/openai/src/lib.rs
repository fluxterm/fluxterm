//! OpenAI 能力 crate。
//!
//! 职责：
//! - 封装 OpenAI Chat Completions 请求
//! - 维护终端会话问答与选中文本解释的 prompt 模板
//! - 提供与 Tauri 无关的请求/响应类型

pub mod client;
pub mod error;
pub mod prompts;
pub mod types;

pub use crate::client::{chat_session, chat_session_stream, test_connection};
pub use crate::error::OpenAiError;
pub use crate::types::{
    ChatMessage, OpenAiClientConfig, OpenAiSessionChatInput, OpenAiSessionChatResponse,
    OpenAiSessionChatStreamInput, ResponseLanguageStrategy, SessionContextSnapshot,
};
