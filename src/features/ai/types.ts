import type { Locale } from "@/i18n";
import type { EngineErrorView } from "@/types";

export type AiResponseLanguageStrategy = "follow_ui" | "follow_user_input";

export type AiProviderMode = "preset" | "compatible";

export type AiProviderVendor =
  | "openai"
  | "deepseek"
  | "qwen"
  | "moonshot"
  | "custom";

/** 终端域 AI 配置。 */
export type AiSettingsView = {
  version: 1;
  selectionMaxChars: number;
  sessionRecentOutputMaxChars: number;
  sessionRecentOutputMaxSnippets: number;
  selectionRecentOutputMaxChars: number;
  selectionRecentOutputMaxSnippets: number;
  requestCacheTtlMs: number;
  requestTimeoutMs: number;
  debugLoggingEnabled: boolean;
  activeProviderId: string;
  providers: AiProviderView[];
};

export type AiProviderView = {
  id: string;
  mode: AiProviderMode;
  vendor: AiProviderVendor;
  name: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
};

/** 加密字段更新策略。 */
export type SecretFieldUpdate =
  | { mode: "keep" }
  | { mode: "replace"; value: string }
  | { mode: "clear" };

/** 保存终端域 AI 配置时使用的输入结构。 */
export type AiSettingsSaveInput = {
  selectionMaxChars: number;
  sessionRecentOutputMaxChars: number;
  sessionRecentOutputMaxSnippets: number;
  selectionRecentOutputMaxChars: number;
  selectionRecentOutputMaxSnippets: number;
  requestCacheTtlMs: number;
  requestTimeoutMs: number;
  debugLoggingEnabled: boolean;
  activeProviderId: string;
  providers: AiProviderInput[];
};

export type AiProviderInput = {
  id: string;
  mode: AiProviderMode;
  vendor: AiProviderVendor;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: SecretFieldUpdate;
};

/** AI 对话消息。 */
export type AiChatMessage = {
  id?: string;
  role: "system" | "user" | "assistant";
  content: string;
  source?: "selection" | "chat";
};

/** 会话上下文问答请求。 */
export type AiSessionChatRequest = {
  sessionId: string;
  responseLanguageStrategy: AiResponseLanguageStrategy;
  uiLanguage: Locale;
  messages: AiChatMessage[];
};

/** 会话上下文问答流式请求。 */
export type AiSessionChatStreamRequest = {
  requestId: string;
  sessionId: string;
  responseLanguageStrategy: AiResponseLanguageStrategy;
  uiLanguage: Locale;
  messages: AiChatMessage[];
};

/** 会话上下文问答响应。 */
export type AiSessionChatResponse = {
  message: AiChatMessage;
};

/** 终端选中文本解释请求。 */
export type AiExplainSelectionRequest = {
  sessionId: string;
  responseLanguageStrategy: AiResponseLanguageStrategy;
  uiLanguage: Locale;
  selectionText: string;
};

/** AI 流式输出片段事件。 */
export type AiChatChunkPayload = {
  requestId: string;
  sessionId: string;
  content: string;
};

/** AI 流式输出完成事件。 */
export type AiChatDonePayload = {
  requestId: string;
  sessionId: string;
};

/** AI 流式输出失败事件。 */
export type AiChatErrorPayload = {
  requestId: string;
  sessionId: string;
  error: EngineErrorView;
};
