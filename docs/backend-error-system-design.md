# 后端错误体系设计

## 1. 目标与范围

本文档定义 FluxTerm 后端错误体系的结构和开发规范，覆盖以下范围：

- Rust 错误构造与序列化。
- Tauri 边界错误传输。
- 前端错误归一化与诊断上下文。
- 用户界面的国际化错误提示。
- 命名、测试和静态检查规则。

错误体系以稳定机器标识、可读英文兜底消息和显式翻译键为核心，使业务控制、日志诊断和用户提示各自保持清晰职责。

## 2. 错误信息分层

| 信息 | 职责 | 主要使用方 |
| --- | --- | --- |
| `code` | 稳定机器标识 | 业务分支、日志、诊断 |
| `message` | 英文兜底消息 | 翻译不可用时的用户提示、日志 |
| `messageKey` | 国际化资源键 | 用户界面翻译 |
| `messageVars` | 翻译模板变量 | 用户界面翻译 |
| `details` | 后端诊断细节 | 日志、问题排查 |
| `diagnostic` | 前端运行时上下文 | 日志、问题排查 |

`code`、`message` 和 `messageKey` 分别承担机器识别、语言无关的可读兜底、用户界面翻译职责。用户提示由 `messageKey` 和 `message` 决定，业务控制由 `code` 决定。

## 3. Tauri 错误载荷

Rust 后端发送给前端的错误使用以下结构：

```ts
type BackendErrorPayload = {
  code: string;
  message: string;
  messageKey?: string;
  messageVars?: Record<string, string | number>;
  details?: string;
};
```

字段定义：

| 字段 | 必填 | 定义 |
| --- | --- | --- |
| `code` | 是 | 符合错误码命名规则的稳定标识 |
| `message` | 是 | 能独立说明失败原因的英文消息 |
| `messageKey` | 否 | 同时存在于中英文语言包的翻译键 |
| `messageVars` | 否 | 值为字符串或数字的翻译变量 |
| `details` | 否 | 非敏感的后端诊断细节 |

协议字段名称固定为 camelCase：`messageKey`、`messageVars` 和 `details`。

Tauri 拒绝值支持标准对象和该对象的 JSON 字符串形式。JSON 字符串解析完成后，内部对象按照同一份 `BackendErrorPayload` 结构校验。

## 4. 命名规则

### 4.1 错误码

错误码使用小写蛇形命名，段数按语义确定：

```text
^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$
```

示例：

```text
ssh_auth_failed
sftp_transfer_task_create_failed
remote_edit_upload_conflict
```

每一段以小写字母开头，后续字符为小写字母或数字，各段使用下划线连接。

### 4.2 翻译键

翻译键使用点分 lowerCamelCase 命名，至少包含两个语义段：

```text
^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$
```

示例：

```text
error.ssh.operationFailed
error.ssh.auth.rejected
error.remoteEdit.uploadConflict
```

每一段以小写字母开头，后续字符为字母或数字，各段使用点连接。

### 4.3 Rust 常量

错误码常量使用 `_CODE` 后缀，翻译键常量使用 `_KEY` 后缀：

```rust
const SSH_AUTH_FAILED_CODE: &str = "ssh_auth_failed";
const SSH_AUTH_REJECTED_KEY: &str = "error.ssh.auth.rejected";
```

常量按照领域就近管理：

- 单文件使用的常量定义为该文件的私有常量。
- 同一领域跨文件使用的常量定义在领域模块中，并通过 `pub(crate)` 暴露。
- 错误码复用现有领域常量，翻译键复用与错误语义一致的领域常量。

## 5. Rust 错误模型

后端统一使用 `EngineError`：

```rust
pub struct EngineError {
    pub code: String,
    pub message: String,
    pub message_key: Option<String>,
    pub message_vars: Option<Box<MessageVars>>,
    pub details: Option<String>,
}
```

`EngineError` 负责向 Tauri 边界序列化错误。Serde 将 Rust 字段序列化为 `messageKey`、`messageVars` 和 `details`。

### 5.1 领域级错误

领域级通用提示使用 `EngineError::new`：

```rust
const SSH_CONNECT_FAILED_CODE: &str = "ssh_connect_failed";

let error = EngineError::new(
    SSH_CONNECT_FAILED_CODE,
    "Failed to establish SSH connection",
);
```

`EngineError::new` 根据错误码前缀设置领域级默认 `messageKey`。

### 5.2 具体错误提示

需要向用户表达具体原因或操作建议时，使用 `EngineError::localized`：

```rust
const SSH_AUTH_FAILED_CODE: &str = "ssh_auth_failed";
const SSH_AUTH_REJECTED_KEY: &str = "error.ssh.auth.rejected";

let error = EngineError::localized(
    SSH_AUTH_FAILED_CODE,
    "SSH authentication was rejected by the server",
    SSH_AUTH_REJECTED_KEY,
);
```

已有 `EngineError` 可以通过 `with_message_key` 设置具体翻译键。同一个错误码的各产生路径使用同一个具体翻译键，英文 `message` 保留各路径的诊断上下文。

### 5.3 翻译变量

翻译变量使用 `MessageVars` 和 `MessageVar` 构造：

```rust
let vars = MessageVars::from([
    ("host".to_string(), MessageVar::from("127.0.0.1")),
    ("attempt".to_string(), MessageVar::from(2_u64)),
]);

let error = EngineError::new(CONNECTION_FAILED_CODE, "Connection failed")
    .with_message_vars(vars);
```

`MessageVar` 是封闭的标量类型，值域为：

- `String`
- JSON 数字

该类型定义同时约束序列化结果和翻译模板输入。

### 5.4 后端诊断细节

底层错误信息通过 `EngineError::with_detail` 写入 `details`：

```rust
let error = EngineError::with_detail(
    SFTP_INIT_FAILED_CODE,
    "Failed to initialize SFTP session",
    source.to_string(),
);
```

`message` 独立表达错误含义，`details` 补充非敏感的底层诊断信息。凭据、密钥和完整命令参数由其所属的安全存储或受保护上下文管理。

## 6. 领域级默认翻译键

未显式指定具体翻译键时，`EngineError` 根据错误码前缀选择默认键：

| 错误码前缀 | 默认翻译键 |
| --- | --- |
| `serial_` | `error.serial.operationFailed` |
| `sftp_` | `error.sftp.operationFailed` |
| `ssh_` | `error.ssh.operationFailed` |
| `proxy_` | `error.proxy.operationFailed` |
| `rdp_` | `error.rdp.operationFailed` |
| `remote_edit_` | `error.remoteEdit.operationFailed` |
| `ai_` | `error.ai.operationFailed` |
| `security_`、`crypto_`、`secret_` | `error.security.operationFailed` |
| `local_`、`file_`、`config_`、`data_`、`profile_` | `error.system.operationFailed` |
| `session_` | `error.session.operationFailed` |
| 其他前缀 | `error.backend.operationFailed` |

认证拒绝、主机密钥异常、协议能力和资源状态等需要用户采取特定动作的错误使用具体翻译键。

## 7. 前端错误模型

前端使用 `AppError` 统一表示后端错误和 JavaScript 运行时异常：

```ts
class AppError extends Error {
  code: string;
  messageKey?: string;
  messageVars?: Record<string, string | number>;
  details?: string;
  diagnostic?: unknown;
  source: "tauri" | "frontend";
}
```

字段来源：

- `code`、`messageKey`、`messageVars` 和 `details` 来自标准后端载荷或前端归一化默认值。
- `diagnostic` 保存命令名、参数键、原始拒绝值和 JavaScript stack 等运行时上下文。
- `source` 标识错误来自 Tauri 边界或前端运行时。

`normalizeToAppError` 依次处理：

1. `AppError` 实例。
2. JSON 字符串形式的对象。
3. 标准 `BackendErrorPayload` 对象。
4. JavaScript `Error`。
5. 普通字符串、未知对象和其他运行时值。

未知对象通过独立的文本提取逻辑生成可读兜底消息；标准后端载荷始终使用第 3 节定义的字段结构。

## 8. Tauri 命令调用

前端业务代码通过 `invokeTauriCommand` 调用 Tauri 命令：

```ts
const result = await invokeTauriCommand<ResultType>("command_name", payload);
```

`src/shared/tauri/commands.ts` 持有底层 Tauri `invoke` 调用，并统一完成以下工作：

- 捕获命令拒绝值。
- 调用 `normalizeToAppError`。
- 将命令名和参数键写入 `diagnostic`。
- 保留标准后端错误载荷中的业务字段。

Tauri 事件使用同一份 `BackendErrorPayload` 类型，并复用错误归一化和翻译逻辑。

## 9. 用户提示与业务控制

`translateAppError` 按以下顺序生成用户提示：

1. `messageKey` 格式有效且存在于语言包时，使用该键和 `messageVars` 翻译。
2. 其余情况返回英文 `message`。

展示逻辑只依赖 `messageKey`、`messageVars` 和 `message`。`code` 用于业务分支、日志和诊断。

SSH 主机密钥确认、SFTP 能力识别和隧道状态处理等控制流程通过稳定错误码选择后续操作，再通过统一翻译流程生成提示。

## 10. 语言包

具体翻译键同时定义在中文和英文语言包中，同一键的两种语言使用完全一致的变量占位符：

```ts
// zh-CN
"error.ssh.hostKeyChanged": "主机 {host} 的密钥已变更",

// en-US
"error.ssh.hostKeyChanged": "The host key for {host} has changed",
```

后端 `message` 使用英文，面向用户的本地化文案维护在语言包中。

## 11. 静态检查

`pnpm runtime-message:check` 校验以下内容：

- 错误码符合小写蛇形命名。
- 翻译键符合点分 lowerCamelCase 命名。
- 错误码常量使用 `_CODE` 后缀。
- 翻译键常量使用 `_KEY` 后缀。
- 重复错误码通过领域常量复用。
- Rust 错误构造中的具体翻译键同时存在于中英文语言包。
- 中英文翻译模板的变量占位符一致。
- 前端 Tauri 命令经由 `invokeTauriCommand` 调用。
- 后端运行时消息使用英文。

检查脚本从明确的错误构造上下文采集翻译键，包括 `_KEY` 常量、`EngineError::localized` 的第三个参数和 `with_message_key` 的第一个参数。

`MessageVar` 类型和前端运行时归一化共同校验 `messageVars` 的值域。

## 12. 新增错误流程

新增或修改错误时执行以下步骤：

1. 在所属领域复用或定义 `_CODE` 常量。
2. 编写能独立说明失败原因的英文 `message`。
3. 根据用户交互语义选择领域级默认键或具体 `_KEY` 常量。
4. 在中英文语言包中定义具体翻译并对齐变量占位符。
5. 使用 `MessageVars` 传递字符串或数字变量。
6. 使用 `details` 保存非敏感的底层诊断信息。
7. 前端通过 `invokeTauriCommand` 调用命令。
8. 前端通过 `translateAppError` 生成展示文案。
9. 为新增契约或控制分支补充相邻测试。

完成后运行：

```bash
pnpm format
pnpm check
cargo fmt
cargo test --workspace
cargo clippy --all-targets --all-features -- -D warnings
```
