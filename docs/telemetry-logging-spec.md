# Telemetry / 埋点日志规范

## 1. 目标与范围

### 1.1 目标

定义 FluxTerm 全栈埋点日志的事件命名、字段模型、内容安全、接入入口与自动检查规则，使日志稳定支持：

1. 故障排查与回放
2. 行为分析与质量评估
3. 稳定性指标与告警

### 1.2 适用范围

本规范适用于以下埋点输出：

1. 前端 Webview（React/TS，`@tauri-apps/plugin-log`）
2. Tauri 命令层（Rust）
3. Engine 运行时（Rust）
4. OpenAI 客户端与 AI 辅助功能日志
5. RDP runtime、Bridge 与 SubApp 运行日志
6. SubApp 与 Main 的跨窗口生命周期日志

禁止新增 `console.*`。需要输出运行期信息时必须接入统一 telemetry 入口。

## 2. 事件命名规范

### 2.1 命名格式

统一使用小写点分段：

`domain.action.result`

说明：

1. `domain`：业务域，例如 `proxy`、`ssh`、`sftp`、`subapp`、`layout`
2. `action`：动作，例如 `create`、`close`、`update`、`sync`、`connect`
3. `result`：结果，例如 `start`、`success`、`failed`
4. 复杂流程可增加中间分段，例如 `ssh.connect.session.created`

示例：

1. `proxy.create.start`
2. `proxy.create.success`
3. `proxy.create.failed`
4. `subapp.launch.success`

### 2.2 命名约束

1. 仅允许小写英文、数字与点号分段，不使用空格、下划线、连字符或驼峰
2. 同一动作优先保持 `start / success / failed` 成组语义
3. 状态型事件使用稳定阶段词，例如 `unsupported`、`persisted`、`ready`
4. 允许多段事件名，例如 `rdp.runtime.frame.perf.snapshot`
5. 不得引入同义重复命名，例如 `proxy.open.success` 与 `proxy.create.success`

## 3. 事件级别与分类

### 3.1 日志级别

1. `info`：正常业务路径与状态摘要
2. `warn`：可恢复异常，例如重试、校验失败、冲突或依赖短暂不可用
3. `error`：不可恢复异常，例如崩溃、关键链路中断或数据损坏风险
4. `debug`：开发调试日志，默认关闭或采样

### 3.2 事件类型

1. 业务事件：用户操作及其结果
2. 运行时事件：后台状态变化
3. 生命周期事件：窗口、会话与子应用的启动关闭
4. 错误事件：异常与失败

## 4. 字段模型规范

### 4.1 强制字段

所有事件必须包含：

1. `event`：事件名（`domain.action.result`）

埋点 payload 禁止包含 `ts`、`source`、`level`。

### 4.2 公共字段

1. `traceId`：链路追踪 ID，仅在需要跨层关联且有实际值时输出
2. `sessionId`：会话 ID
3. `subappId`：子应用 ID
4. `widgetKey`：组件 Key
5. `durationMs`：耗时
6. `attempt`：重试次数

### 4.3 失败事件字段

失败事件必须包含：

1. `error.code`：机器可识别错误码
2. `error.message`：可读错误信息
3. `error.detail`：脱敏后的短摘要

### 4.4 业务扩展字段

业务字段必须满足：

1. 使用小写驼峰命名
2. 不与公共字段重名
3. 含义稳定，不随 UI 文案变化而变化
4. 优先记录摘要字段，例如 `keyCount`、`widgetCount`、`contentChars`、`messageCount`
5. 不记录 `ts`、`source`、`level`；这些字段由日志前缀提供

## 5. 脱敏与安全规范

### 5.1 禁止直接记录

1. 密码、私钥、API Key、Token、Cookie、Authorization 明文
2. 完整用户输入内容
3. 本地敏感路径全量信息
4. OpenAI 请求的完整 `messages`
5. OpenAI 响应的完整 `message`
6. AI selection 的 `selectionText`
7. 近期终端输出原文或 `recentTerminalOutput`
8. settings、layout、quickbar、session settings 的完整配置 payload

### 5.2 允许记录

允许记录以下摘要或低敏字段：

1. 用户名
2. 主机或 IP
3. 端口、协议与状态码
4. 文本长度、消息数量、角色列表、配置键数量、分组数量等摘要

### 5.3 脱敏规则

1. 凭据字段统一使用 `***` 或哈希摘要
2. 长文本字段必须先摘要化，不直接进入 payload
3. 错误栈不进入用户可见日志
4. `error.detail` 仅允许短摘要，不记录凭据、Token、完整终端输出或完整本地路径
5. AI 与 OpenAI 相关日志默认只输出摘要，不提供完整内容日志开关

## 6. 链路关联规范

### 6.1 `traceId` 规则

1. 需要跨层排查的 UI 操作创建 `traceId`
2. Tauri invoke 参数中透传 `traceId`
3. Engine 回调继续透传 `traceId`
4. 同一用户动作在全链路内使用同一个 `traceId`
5. 没有实际值时不输出 `traceId: null`

### 6.2 Span 字段

复杂流程允许增加：

1. `spanId`
2. `parentSpanId`

用于拆解长链路，例如 `connect -> auth -> open channel -> ready`。

## 7. 采样与性能约束

### 7.1 高频事件采样

以下事件必须采样或聚合输出：

1. 高频连接状态刷新事件
2. 高频终端输出类事件

策略：

1. `warn / error` 默认全量记录
2. 高频 `info` 事件按时间窗口聚合，例如 `1s` 一次
3. `debug` 默认关闭

### 7.2 大小与频率限制

1. 单条日志不得超过 `4KB`
2. 单实例日志速率必须有上限
3. 禁止在热循环中无条件拼接大字符串

## 8. 事件字典

维护 `event -> 字段 -> 含义` 字典，新增事件时同步登记。

## 9. 内容摘要策略

### 9.1 Settings / Layout / QuickBar

配置类 debug 日志不得记录完整配置对象，应转换为摘要字段：

1. `keyCount`：配置键数量
2. `groupCount`：分组数量
3. `widgetCount`：组件数量
4. `enabledFlags` 或单独布尔字段：关键开关状态

### 9.2 OpenAI / AI Selection

OpenAI 请求与响应日志只允许记录：

1. `requestType`
2. `model`
3. `messageCount`
4. `roles`
5. `contentChars`
6. `systemPromptChars`
7. `systemPromptHeadLines`
8. `recentOutputChars`
9. `selectionChars`
10. `responseChars`
11. `responseRole`

不得记录完整 prompt、完整终端输出、完整选中文本、完整响应文本。

### 9.3 RDP Runtime

RDP runtime 日志统一通过 `crates/rdp_core/src/telemetry.rs` wrapper 输出，业务模块禁止直接使用 `tracing::{debug, info, warn, error}` 或同名日志宏。高频图形更新只能输出聚合窗口，例如 `rdp.runtime.frame.perf.snapshot`。

## 10. 代码接入规范

### 10.1 前端（TS）

1. 统一通过 `src/shared/logging/telemetry.ts` 输出，不得散落硬编码日志入口
2. 同一动作保持 `start / success / failed` 语义完整
3. `failed` 事件必须携带 `error.code` 与 `error.message`
4. 新增结构化埋点必须调用 `logTelemetry(level, event, fields)`
5. `debug/info/warn/error(message)` 只允许处理已有字符串入口，不作为新代码接入方式
6. 禁止新增 `console.*`

### 10.2 Rust（Tauri / Engine / OpenAI / RDP）

1. 统一使用结构化日志（JSON）
2. 禁止 `format!("{:?}", sensitive)` 输出敏感对象
3. 错误日志应使用统一错误码
4. payload 构造统一复用 `fluxterm-telemetry`
5. 各 crate 只保留本地 wrapper 负责 `debug/info/warn/error` 级别路由
6. `traceId` 仅在非空字符串时输出

## 11. 自动化检查

`pnpm check` 会运行 `pnpm telemetry:check`，检查以下约束：

1. telemetry event 字符串不得包含 `:`、`_`、`-` 或驼峰
2. 禁止新增 `console.*`
3. 禁止 telemetry payload 写入 `ts/source/level`
4. 禁止 OpenAI / AI telemetry 中出现完整 `messages/message/selectionText/recentTerminalOutput`
5. 禁止 `crates/rdp_core` 业务模块直接使用日志宏，必须走统一 wrapper

## 12. 评审清单

### 12.1 新增事件 Checklist

1. 事件命名是否符合 `domain.action.result`
2. 是否包含强制字段 `event`
3. 失败事件是否具备标准错误字段
4. 是否存在敏感信息泄露
5. 高频路径是否具备采样或聚合策略
6. 大内容是否已转换为摘要字段
7. Rust payload 是否复用 `fluxterm-telemetry`

### 12.2 PR Review 必查项

1. 是否新增未登记事件名
2. 是否引入同义重复事件
3. 是否缺失 `start / success / failed` 成组语义
4. 是否以不可检索自由文本替代结构化字段
5. 是否绕过统一日志入口

## 13. Proxy 域示例

### 13.1 控制面事件

1. `proxy.create.start`
2. `proxy.create.success`
3. `proxy.create.failed`
4. `proxy.close.start`
5. `proxy.close.success`
6. `proxy.close.failed`
7. `proxy.close.all.start`
8. `proxy.close.all.success`
9. `proxy.close.all.failed`
10. `proxy.list.success`
11. `proxy.list.failed`

### 13.2 运行时事件

1. `proxy.runtime.update`
2. `proxy.connection.open`
3. `proxy.connection.close`
4. `proxy.connection.failed`

### 13.3 字段

1. `proxyId`
2. `protocol`
3. `bindHost`
4. `bindPort`
5. `activeConnections`
6. `bytesIn`
7. `bytesOut`
8. `error.code / error.message / error.detail`
