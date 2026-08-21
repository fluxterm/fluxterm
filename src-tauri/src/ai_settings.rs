//! 终端 AI 助手配置读取与持久化。

const AI_SETTINGS_INVALID_CODE: &str = "ai_settings_invalid";
const AI_SETTINGS_PARSE_FAILED_CODE: &str = "ai_settings_parse_failed";

use std::collections::{HashMap, HashSet};
use std::fs;

use fluxterm_engine::EngineError;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::config_paths::resolve_ai_settings_path;
use crate::security::{CryptoService, SecretStore};
use crate::security_store::read_security_config;
use crate::state::SecurityState;
use crate::utils::write_atomic;

const DEFAULT_SELECTION_MAX_CHARS: usize = 1_500;
const DEFAULT_SESSION_RECENT_OUTPUT_MAX_CHARS: usize = 1_200;
const DEFAULT_SESSION_RECENT_OUTPUT_MAX_SNIPPETS: usize = 4;
const DEFAULT_SELECTION_RECENT_OUTPUT_MAX_CHARS: usize = 600;
const DEFAULT_SELECTION_RECENT_OUTPUT_MAX_SNIPPETS: usize = 2;
const DEFAULT_REQUEST_CACHE_TTL_MS: u64 = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 20_000;
const CURRENT_AI_SETTINGS_VERSION: u32 = 1;

/// 终端 AI 助手落盘结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub version: u32,
    #[serde(default = "default_selection_max_chars")]
    pub selection_max_chars: usize,
    #[serde(default = "default_session_recent_output_max_chars")]
    pub session_recent_output_max_chars: usize,
    #[serde(default = "default_session_recent_output_max_snippets")]
    pub session_recent_output_max_snippets: usize,
    #[serde(default = "default_selection_recent_output_max_chars")]
    pub selection_recent_output_max_chars: usize,
    #[serde(default = "default_selection_recent_output_max_snippets")]
    pub selection_recent_output_max_snippets: usize,
    #[serde(default = "default_request_cache_ttl_ms")]
    pub request_cache_ttl_ms: u64,
    #[serde(default = "default_request_timeout_ms")]
    pub request_timeout_ms: u64,
    #[serde(default)]
    pub active_provider_id: String,
    #[serde(default)]
    pub providers: Vec<AiProviderSettings>,
}

impl AiSettings {
    /// 返回当前激活的 AI 接入配置。
    pub fn active_provider(&self) -> Option<&AiProviderSettings> {
        self.providers
            .iter()
            .find(|provider| provider.id == self.active_provider_id)
    }
}

/// 单个 AI 接入配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderSettings {
    pub id: String,
    #[serde(default)]
    pub mode: AiProviderMode,
    #[serde(default)]
    pub vendor: AiProviderVendor,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AiProviderMode {
    #[default]
    Preset,
    Compatible,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AiProviderVendor {
    Openai,
    Deepseek,
    Qwen,
    Moonshot,
    #[default]
    Custom,
}

/// 返回给前端设置页的 AI 配置视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsView {
    pub version: u32,
    pub selection_max_chars: usize,
    pub session_recent_output_max_chars: usize,
    pub session_recent_output_max_snippets: usize,
    pub selection_recent_output_max_chars: usize,
    pub selection_recent_output_max_snippets: usize,
    pub request_cache_ttl_ms: u64,
    pub request_timeout_ms: u64,
    pub active_provider_id: String,
    pub providers: Vec<AiProviderView>,
}

/// 前端可见的接入配置视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderView {
    pub id: String,
    pub mode: AiProviderMode,
    pub vendor: AiProviderVendor,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key_configured: bool,
}

/// 前端保存 AI 配置时使用的输入结构。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsSaveInput {
    pub selection_max_chars: usize,
    pub session_recent_output_max_chars: usize,
    pub session_recent_output_max_snippets: usize,
    pub selection_recent_output_max_chars: usize,
    pub selection_recent_output_max_snippets: usize,
    pub request_cache_ttl_ms: u64,
    pub request_timeout_ms: u64,
    pub active_provider_id: String,
    pub providers: Vec<AiProviderInput>,
}

/// 前端保存单个接入时使用的输入结构。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInput {
    pub id: String,
    #[serde(default)]
    pub mode: AiProviderMode,
    #[serde(default)]
    pub vendor: AiProviderVendor,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key: SecretFieldUpdate,
}

/// 受保护字段的更新策略。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", tag = "mode")]
pub enum SecretFieldUpdate {
    Keep,
    Replace { value: String },
    Clear,
}

pub fn read_ai_settings(app: &AppHandle) -> Result<AiSettings, EngineError> {
    let path = resolve_ai_settings_path(app)?;
    if !path.exists() {
        return Ok(default_ai_settings());
    }
    let content = fs::read_to_string(&path).map_err(|err| {
        EngineError::with_detail(
            "ai_settings_read_failed",
            "Failed to read the terminal AI settings file",
            err.to_string(),
        )
    })?;
    let raw_value: serde_json::Value = serde_json::from_str(&content).map_err(|err| {
        EngineError::with_detail(
            AI_SETTINGS_PARSE_FAILED_CODE,
            "Failed to parse the terminal AI settings file",
            err.to_string(),
        )
    })?;
    let version = raw_value
        .get("version")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    match version {
        1 => {
            let settings: AiSettings = serde_json::from_value(raw_value).map_err(|err| {
                EngineError::with_detail(
                    AI_SETTINGS_PARSE_FAILED_CODE,
                    "Failed to parse the terminal AI settings file",
                    err.to_string(),
                )
            })?;
            validate_ai_settings(settings)
        }
        _ => Err(EngineError::new(
            AI_SETTINGS_PARSE_FAILED_CODE,
            "The terminal AI settings file version is unsupported",
        )),
    }
}

pub fn write_ai_settings(app: &AppHandle, settings: AiSettings) -> Result<AiSettings, EngineError> {
    let validated = validate_ai_settings(settings)?;
    let path = resolve_ai_settings_path(app)?;
    let content = serde_json::to_string_pretty(&validated).map_err(|err| {
        EngineError::with_detail(
            "ai_settings_serialize_failed",
            "Failed to serialize the terminal AI settings",
            err.to_string(),
        )
    })?;
    write_atomic(path, &content)?;
    Ok(validated)
}

pub fn read_ai_settings_view(app: &AppHandle) -> Result<AiSettingsView, EngineError> {
    let settings = read_ai_settings(app)?;
    Ok(build_settings_view(settings))
}

pub fn save_ai_settings_input(
    app: &AppHandle,
    input: AiSettingsSaveInput,
) -> Result<AiSettingsView, EngineError> {
    let current = read_ai_settings(app)?;
    let crypto = load_ai_crypto(app)?;
    let secret_store = SecretStore::new(&crypto);
    let next = build_ai_settings_from_input(current, input, &secret_store)?;
    let saved = write_ai_settings(app, next)?;
    Ok(build_settings_view(saved))
}

fn default_selection_max_chars() -> usize {
    DEFAULT_SELECTION_MAX_CHARS
}

fn default_session_recent_output_max_chars() -> usize {
    DEFAULT_SESSION_RECENT_OUTPUT_MAX_CHARS
}

fn default_session_recent_output_max_snippets() -> usize {
    DEFAULT_SESSION_RECENT_OUTPUT_MAX_SNIPPETS
}

fn default_selection_recent_output_max_chars() -> usize {
    DEFAULT_SELECTION_RECENT_OUTPUT_MAX_CHARS
}

fn default_selection_recent_output_max_snippets() -> usize {
    DEFAULT_SELECTION_RECENT_OUTPUT_MAX_SNIPPETS
}

fn default_request_cache_ttl_ms() -> u64 {
    DEFAULT_REQUEST_CACHE_TTL_MS
}

fn default_request_timeout_ms() -> u64 {
    DEFAULT_REQUEST_TIMEOUT_MS
}

fn default_ai_settings() -> AiSettings {
    AiSettings {
        version: CURRENT_AI_SETTINGS_VERSION,
        selection_max_chars: default_selection_max_chars(),
        session_recent_output_max_chars: default_session_recent_output_max_chars(),
        session_recent_output_max_snippets: default_session_recent_output_max_snippets(),
        selection_recent_output_max_chars: default_selection_recent_output_max_chars(),
        selection_recent_output_max_snippets: default_selection_recent_output_max_snippets(),
        request_cache_ttl_ms: default_request_cache_ttl_ms(),
        request_timeout_ms: default_request_timeout_ms(),
        active_provider_id: String::new(),
        providers: Vec::new(),
    }
}

fn validate_ai_settings(mut settings: AiSettings) -> Result<AiSettings, EngineError> {
    settings.version = CURRENT_AI_SETTINGS_VERSION;
    if settings.selection_max_chars == 0 {
        return Err(EngineError::new(
            AI_SETTINGS_INVALID_CODE,
            "selectionMaxChars in the terminal AI settings must be greater than zero",
        ));
    }
    if settings.session_recent_output_max_chars == 0
        || settings.session_recent_output_max_snippets == 0
        || settings.selection_recent_output_max_chars == 0
        || settings.selection_recent_output_max_snippets == 0
        || settings.request_cache_ttl_ms == 0
        || settings.request_timeout_ms == 0
    {
        return Err(EngineError::new(
            AI_SETTINGS_INVALID_CODE,
            "Context budgets, cache TTL, and request timeout in the terminal AI settings must be greater than zero",
        ));
    }

    let mut seen_ids = HashSet::new();
    for provider in &mut settings.providers {
        provider.id = provider.id.trim().to_string();
        provider.name = provider.name.trim().to_string();
        provider.base_url = provider.base_url.trim().to_string();
        provider.model = provider.model.trim().to_string();
        provider.api_key_ref = provider
            .api_key_ref
            .take()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if provider.id.is_empty() {
            return Err(EngineError::new(
                AI_SETTINGS_INVALID_CODE,
                "AI provider configuration id is required",
            ));
        }
        if !seen_ids.insert(provider.id.clone()) {
            return Err(EngineError::new(
                AI_SETTINGS_INVALID_CODE,
                "AI provider configuration ids must be unique",
            ));
        }
    }

    settings.active_provider_id = settings.active_provider_id.trim().to_string();
    if settings.providers.is_empty() {
        settings.active_provider_id.clear();
    } else if !settings.active_provider_id.is_empty()
        && !settings
            .providers
            .iter()
            .any(|provider| provider.id == settings.active_provider_id)
    {
        // 允许“未接入”状态；当激活项指向已不存在的旧 id 时自动降级为未接入。
        settings.active_provider_id.clear();
    }

    Ok(settings)
}

fn build_settings_view(settings: AiSettings) -> AiSettingsView {
    AiSettingsView {
        version: settings.version,
        selection_max_chars: settings.selection_max_chars,
        session_recent_output_max_chars: settings.session_recent_output_max_chars,
        session_recent_output_max_snippets: settings.session_recent_output_max_snippets,
        selection_recent_output_max_chars: settings.selection_recent_output_max_chars,
        selection_recent_output_max_snippets: settings.selection_recent_output_max_snippets,
        request_cache_ttl_ms: settings.request_cache_ttl_ms,
        request_timeout_ms: settings.request_timeout_ms,
        active_provider_id: settings.active_provider_id,
        providers: settings
            .providers
            .into_iter()
            .map(|provider| AiProviderView {
                id: provider.id,
                mode: provider.mode,
                vendor: provider.vendor,
                name: provider.name,
                base_url: provider.base_url,
                model: provider.model,
                api_key_configured: provider.api_key_ref.is_some(),
            })
            .collect(),
    }
}

fn build_ai_settings_from_input(
    current: AiSettings,
    input: AiSettingsSaveInput,
    secret_store: &SecretStore<'_>,
) -> Result<AiSettings, EngineError> {
    let current_provider_map = current
        .providers
        .iter()
        .map(|provider| (provider.id.clone(), provider.clone()))
        .collect::<HashMap<_, _>>();
    let mut next_providers = Vec::with_capacity(input.providers.len());
    for provider in input.providers {
        let current_provider = current_provider_map.get(&provider.id);
        let api_key_ref = match provider.api_key {
            SecretFieldUpdate::Keep => current_provider.and_then(|item| item.api_key_ref.clone()),
            SecretFieldUpdate::Clear => None,
            SecretFieldUpdate::Replace { value } => {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    current_provider.and_then(|item| item.api_key_ref.clone())
                } else {
                    secret_store.protect_optional_string(Some(trimmed))?
                }
            }
        };
        next_providers.push(AiProviderSettings {
            id: provider.id,
            mode: provider.mode,
            vendor: provider.vendor,
            name: provider.name,
            base_url: provider.base_url,
            model: provider.model,
            api_key_ref,
        });
    }

    validate_ai_settings(AiSettings {
        version: CURRENT_AI_SETTINGS_VERSION,
        selection_max_chars: input.selection_max_chars,
        session_recent_output_max_chars: input.session_recent_output_max_chars,
        session_recent_output_max_snippets: input.session_recent_output_max_snippets,
        selection_recent_output_max_chars: input.selection_recent_output_max_chars,
        selection_recent_output_max_snippets: input.selection_recent_output_max_snippets,
        request_cache_ttl_ms: input.request_cache_ttl_ms,
        request_timeout_ms: input.request_timeout_ms,
        active_provider_id: input.active_provider_id,
        providers: next_providers,
    })
}

fn load_ai_crypto(app: &AppHandle) -> Result<CryptoService, EngineError> {
    let security_config = read_security_config(app)?;
    let security = app.state::<SecurityState>();
    let session = security.current_session();
    CryptoService::load(app, security_config.as_ref(), session.as_ref())
}

#[cfg(test)]
pub fn default_ai_settings_for_test() -> AiSettings {
    default_ai_settings()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ai_settings_are_blank_until_user_configures_provider() {
        let settings = default_ai_settings();
        assert_eq!(settings.version, 1);
        assert_eq!(settings.selection_max_chars, 1_500);
        assert!(settings.active_provider_id.is_empty());
        assert!(settings.providers.is_empty());
    }
}
