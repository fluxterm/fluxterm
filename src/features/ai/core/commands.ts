import { invokeTauriCommand } from "@/shared/tauri/commands";
import type {
  AiSettingsSaveInput,
  AiSettingsView,
  AiChatDonePayload,
  AiChatErrorPayload,
  AiChatChunkPayload,
  AiSessionChatRequest,
  AiSessionChatResponse,
  AiSessionChatStreamRequest,
} from "@/features/ai/types";
import { subscribeTauri } from "@/shared/tauri/events";

/** 读取终端域 AI 配置。 */
export function aiSettingsGet() {
  return invokeTauriCommand<AiSettingsView>("ai_settings_get");
}

/** 保存终端域 AI 配置。 */
export function aiSettingsSave(settings: AiSettingsSaveInput) {
  return invokeTauriCommand<AiSettingsView>("ai_settings_save", { settings });
}

/** 测试指定 AI 接入；未传入时测试当前激活接入。 */
export function aiProviderTest(providerId?: string) {
  return invokeTauriCommand<void>("ai_provider_test", { providerId });
}

/** 发起会话上下文问答。 */
export function aiSessionChat(request: AiSessionChatRequest) {
  return invokeTauriCommand<AiSessionChatResponse>("ai_session_chat", {
    request,
  });
}

/** 启动流式会话上下文问答。 */
export function aiSessionChatStreamStart(request: AiSessionChatStreamRequest) {
  return invokeTauriCommand<void>("ai_session_chat_stream_start", { request });
}

/** 取消流式会话上下文问答。 */
export function aiSessionChatStreamCancel(requestId: string) {
  return invokeTauriCommand<boolean>("ai_session_chat_stream_cancel", {
    requestId,
  });
}

/** 订阅 AI 流式输出片段。 */
export function onAiChatChunk(handler: (payload: AiChatChunkPayload) => void) {
  return subscribeTauri<AiChatChunkPayload>("ai:chat-chunk", (event) =>
    handler(event.payload),
  );
}

/** 订阅 AI 流式输出完成事件。 */
export function onAiChatDone(handler: (payload: AiChatDonePayload) => void) {
  return subscribeTauri<AiChatDonePayload>("ai:chat-done", (event) =>
    handler(event.payload),
  );
}

/** 订阅 AI 流式输出失败事件。 */
export function onAiChatError(handler: (payload: AiChatErrorPayload) => void) {
  return subscribeTauri<AiChatErrorPayload>("ai:chat-error", (event) =>
    handler(event.payload),
  );
}
