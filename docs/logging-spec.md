# FluxTerm 结构化日志规范

## 1. 目标与边界

日志只用于记录离散的业务结果、运行状态和故障诊断，不承担行为分析、性能指标采集或远程数据上报职责。性能遥测使用独立的数据模型、采集器和传输链路，不得复用日志事件目录或日志输出接口。

本规范覆盖 React Webview、Tauri 命令层、Engine、OpenAI 客户端和 RDP runtime。用户可见的 AppEvent 活动记录仍是独立 UI 模型，不属于日志基础设施。

## 2. 日志所有权

1. 最终结果由掌握真实结果、错误和耗时的最低层记录。
2. 上层只传播错误或同步状态时不得重复记录同一结果。
3. 前端只记录纯 UI 故障；后端拥有的 SSH、SFTP、RDP、Proxy 和 AI 生命周期不在前端重复输出。
4. 错误只在被处理、转换为状态或终止操作的位置记录一次。
5. 循环任务只记录首次失败、恢复或最终结果，不逐轮重复输出。

## 3. 级别

- `debug`：开始、内部阶段、分支决策、协议握手和正常轮询，默认关闭。
- `info`：用户可感知操作的最终成功结果或稳定状态变化。正常操作不记录 `started` INFO。
- `warn`：应用仍可继续运行的连接、认证、网络、校验、回退和用户操作失败。
- `error`：子系统无法继续运行、状态或数据存在损坏风险、后台关键任务异常终止。

## 4. 事件与消息

- 事件名使用小写点分段，格式为 `domain.subject.action.outcome`。
- 操作结果使用 `started/succeeded/failed/cancelled`，状态使用 `connected/disconnected/ready/unsupported` 等稳定词。
- 禁止运行时拼接或自动归一化事件名。
- `message` 与 `error.message` 是稳定英文，不包含运行时变量。
- 每个事件必须登记到 `docs/logging-events.json`，包括固定级别、所有者、消息和字段约束。

## 5. 记录结构

日志正文为 UTF-8 JSON：

```json
{
  "event": "ssh.session.connect.succeeded",
  "message": "SSH session connect succeeded",
  "component": "engine",
  "operationId": "4fd49d24-3ed4-4a86-8668-21f0b5d75fd7",
  "sessionId": "0f758195-d484-4e04-bfb2-507622a5af92",
  "host": "10.0.0.8",
  "user": "root",
  "authType": "password",
  "durationMs": 836
}
```

失败记录必须包含：

```json
{
  "error": {
    "code": "ssh_authentication_failed",
    "message": "SSH authentication failed",
    "detail": "Permission denied"
  }
}
```

`event`、`message`、`component`、`operationId`、`error` 和 `truncated` 是保留字段，业务字段不能覆盖。时间、级别和 Rust target 由日志输出端提供，不在 JSON 正文重复写入。

## 6. 关联规则

- 用户操作入口创建 `operationId`，跨 Webview、Tauri 和 Engine 使用同一值。
- Rust 参数使用 `operation_id`，Tauri/JSON 字段使用 `operationId`。
- `sessionId`、`transferId`、`proxyId` 等实体 ID 用于关联生命周期，不能代替操作 ID。
- 自动启动的资源监控使用独立操作 ID，并通过 `connectionPurpose=resourceMonitor` 表明第二条 SSH 连接。

## 7. 内容安全

允许记录：

- 主机/IP、用户名、端口、协议、认证类型。
- 应用生成的不透明 ID、状态、数量、离散操作耗时和最终传输字节数。

禁止记录：

- 密码、私钥、Passphrase、Token、Cookie、Authorization、API Key。
- 完整路径、文件名、文件内容和目录列表原文。
- 终端输出、输入命令、剪贴板内容。
- AI Prompt、消息、选中文本、终端上下文和响应原文。
- 完整配置对象、原始异常对象和未经清洗的堆栈。
- FPS、周期吞吐、CPU 时间窗口、帧统计等连续性能快照。

## 8. 大小与失败安全

- 单条 JSON 最大 4096 UTF-8 字节。
- 普通字符串最大 512 字节，`error.detail` 最大 1024 字节。
- 超限时先移除错误详情，再按编码大小移除可选业务字段，最终写入 `truncated: true`。
- 对象递归清洗敏感键；循环引用、函数和不可序列化值直接丢弃。
- 非法事件生成受限的 `logging.record.invalid` 警告，日志调用和输出失败不得中断业务。

## 9. 高频路径

- 热循环不得输出 INFO。
- RDP 帧窗口、SFTP 周期吞吐、终端输出批次不写入日志。
- 重复警告必须按状态变化去重；恢复后才允许再次记录同类警告。
- 离散操作的 `durationMs`、总字节数和条目数属于故障上下文，不视为性能遥测。

## 10. 接入与检查

- TypeScript 统一使用 `src/shared/logging` 的结构化函数，禁止 `console.*`。
- Rust 统一使用 `fluxterm-logging` 宏，业务 crate 禁止直接调用 `debug!`、`info!`、`warn!`、`error!`。
- 不提供自由文本或 JSON 字符串兼容入口。
- `pnpm logging:check` 校验事件目录、级别、事件常量、敏感字段、直接日志调用和旧埋点接口。

## 11. 评审清单

1. 是否由正确层记录，是否与上层重复。
2. INFO 是否只表示最终结果或稳定状态。
3. WARN/ERROR 是否按运行影响区分。
4. 是否有稳定错误码和静态英文消息。
5. 是否包含路径、内容、凭据或连续性能数据。
6. 是否贯穿 `operationId`。
7. 是否在事件目录中登记且字段受限。
