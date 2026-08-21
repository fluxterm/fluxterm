# 终端 AI 助手设计

本设计受 [终端 AI 助手上下文规范](./ai-context-contract.md) 约束。凡涉及上下文边界、状态归属与 AI 输入裁剪，应以该规范为准。

## 目标

FluxTerm 当前的 AI 能力围绕终端工作流展开，范围限定为以下两类：

1. 终端会话上下文问答
2. 将终端中选中的文本发送给 AI

两类能力均以“当前终端会话”为核心。

## 当前能力边界

### 终端会话上下文问答

AI 面板中的问答能力仅在存在活动会话时可用。

问答上下文由后端统一组装，当前包括：

- 会话名称
- 主机
- 用户名
- 会话状态
- 资源监控状态
- 主机身份状态
- 最近终端输出片段

前端仅发送：

- 当前 `sessionId`
- 当前轮消息历史
- 问答响应语言策略
- 当前界面语言

前端不拼接 Prompt，也不构造会话摘要。

### 发送选中文本给 AI

该能力面向终端中的局部内容解释场景。

交互原则：

- 用户在终端中选中文本
- 通过右键菜单将选中文本发送给 AI
- AI 在当前会话上下文基础上解释该段内容

选中文本进入模型前由后端统一裁剪，裁剪上限由终端域 AI 配置控制，而非固化在前端。

## 模块划分

### 独立 crate

- `crates/openai` (`fluxterm-openai`)

职责：

- OpenAI 兼容接口请求
- 终端会话问答 Prompt 模板
- 请求与响应类型
- 响应解析
- 模型请求错误映射

该 crate 不依赖 Tauri，也不读取应用状态。

### `src-tauri`

- `src-tauri/src/ai/mod.rs`
- `src-tauri/src/ai/context.rs`
- `src-tauri/src/ai_settings.rs`
- `src-tauri/src/commands/ai.rs`

职责：

- 读取 OpenAI 配置
- 维护终端会话上下文缓存
- 将会话状态转换为 AI 可消费的结构化输入
- 暴露 Tauri AI 命令
- 读取终端域 AI 配置

### 前端

- `src/features/ai/types.ts`
- `src/features/ai/core/commands.ts`
- `src/features/ai/hooks/useAiState.ts`
- `src/components/terminal/ai/AiPanel.tsx`

职责：

- 展示 AI 面板
- 发起会话上下文问答请求
- 订阅流式问答事件
- 展示返回结果
- 管理最小对话状态

## 接口设计

### 会话上下文问答

后端命令：

- `ai_session_chat`
- `ai_session_chat_stream_start`
- `ai_session_chat_stream_cancel`

前端事件：

- `ai:chat-chunk`
- `ai:chat-done`
- `ai:chat-error`

前端请求：

```ts
type AiSessionChatRequest = {
  sessionId: string;
  responseLanguageStrategy: "follow_user_input" | "follow_ui";
  uiLanguage: "zh" | "en";
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
};
```

前端响应：

```ts
type AiSessionChatResponse = {
  message: {
    role: "assistant" | "user" | "system";
    content: string;
  };
};
```

约束：

- 无活动会话时不允许发起会话问答
- Prompt 模板仅由后端维护
- 最近输出片段由后端统一裁剪
- 当前实现采用流式返回，assistant 内容通过事件增量追加
- 切换会话或清空对话时，前端需要取消当前流式请求

### 选中文本发送给 AI

该能力建议使用独立命令，而非复用普通问答输入。

建议请求：

```ts
type AiExplainSelectionRequest = {
  sessionId: string;
  responseLanguageStrategy: "follow_ui";
  uiLanguage: "zh" | "en";
  selectionText: string;
};
```

建议响应：

```ts
type AiExplainSelectionResponse = {
  message: {
    role: "assistant";
    content: string;
  };
};
```

约束：

- `selectionText` 由前端显式提供
- 会话上下文由后端补齐
- 选中文本需要按配置裁剪长度

## OpenAI 标准接入配置

当前终端 AI 助手提供一种接入形态：

- OpenAI 标准接入

此处的“OpenAI”指 OpenAI-compatible 接口，而非绑定单一服务提供方。

因此：

- DeepSeek 可以通过该接口接入
- 本地 Ollama 的 OpenAI-compatible 接口也可通过该接口接入

配置入口划分为两个分区：

- `AI助手`
- `OpenAI`

职责边界：

- `AI助手` 管理终端 AI 助手本地能力配置，以及当前启用的 OpenAI 接入
- `OpenAI` 管理多个 OpenAI-compatible 接入项的新增、编辑与测试

当前产品入口：

- 一级“配置”菜单中提供 `AI助手`
- 打开后在配置弹窗左侧导航中切换 `AI助手` 与 `OpenAI`

前端不直接请求模型接口，也不保存密文字段的可读明文。

## 终端域 AI 配置

终端 AI 助手本地配置文件路径：

- `<resolve_config_root_dir(app)>/ai/ai.json`

当前使用的配置项：

```json
{
  "version": 1,
  "selectionMaxChars": 1500,
  "sessionRecentOutputMaxChars": 1200,
  "sessionRecentOutputMaxSnippets": 4,
  "selectionRecentOutputMaxChars": 600,
  "selectionRecentOutputMaxSnippets": 2,
  "requestCacheTtlMs": 15000,
  "activeOpenAiConfigId": "default",
  "openaiConfigs": [
    {
      "id": "default",
      "name": "默认 OpenAI",
      "baseUrl": "",
      "model": "",
      "apiKeyRef": "enc:v1:..."
    }
  ]
}
```

约束：

- 配置由后端读取并应用
- 前端不维护独立长度限制副本
- 会话问答与选中文本解释的最近输出预算分别独立控制
- 短时间内相同请求由后端内存缓存复用，以减少重复消耗
- 前端设置页直接读写该配置文件，不再维护单独副本
- `activeOpenAiConfigId` 由 `AI助手` 分区维护
- `openaiConfigs[].name`、`openaiConfigs[].baseUrl`、`openaiConfigs[].model` 与 `openaiConfigs[].apiKeyRef` 由 `OpenAI` 分区维护
- `apiKeyRef` 使用既有 `enc:v1:` 加密方案保存
- 日志仅记录提供方、模型、请求状态、耗时和稳定错误码；不得记录消息、Prompt、终端上下文、选中文本或响应原文
- 当前仍可通过 `OPENAI_TIMEOUT_MS` 控制统一请求超时
- 当前激活接入的 `baseUrl` 与 `model` 任一缺失时，AI 助手不可用，前端显示配置提示

## 当前实现

当前已落地：

- 独立 `fluxterm-openai` crate（目录为 `crates/openai`）
- `ai_session_chat` 命令
- `ai_session_chat_stream_start` 与 `ai_session_chat_stream_cancel` 命令
- `ai_explain_selection` 命令
- 会话上下文运行时缓存
- AI 面板最小问答界面
- 终端右键菜单中的“发送给 AI”入口
- 会话问答流式输出
- 选中文本按界面语言输出
- 会话问答按用户输入语言输出
- 前端设置页中的终端 AI 可控配置
- 独立的 `AI助手` 分区
- 独立的 `OpenAI` 配置分区
- 多个 OpenAI-compatible 接入项的切换、删除与编辑
- API Key 加密保存
- `OpenAI` 分区中的接入测试按钮

## 验收标准

1. AI 功能仅围绕终端会话工作流展开
2. 会话问答必须依赖当前活动会话
3. 前端不直接拼接 Prompt，也不直接请求模型
4. 后端统一维护会话上下文并裁剪最近输出
5. 终端选中文本发送给 AI 时，仍需复用当前会话上下文
6. 会话问答的 assistant 响应必须通过流式事件逐步渲染
