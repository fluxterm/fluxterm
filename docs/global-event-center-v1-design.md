# 全局事件中心 V1 设计

## 1. 设计目标

全局事件中心用于统一展示 FluxTerm 中用户可感知的运行活动，并为后续模块接入提供结构化事件模型。

V1 聚焦主窗口内的基础事件能力：

1. 提供统一的 `AppEvent` 事件模型。
2. 展示当前会话状态摘要。
3. 展示会话与传输相关的最近活动。
4. 支持主窗口与浮动 Widget 之间的快照同步。
5. 为 Tunnel、Proxy、Remote Edit、RDP、AI、Security 等模块预留接入规范。

## 2. 设计原则

1. 结构化事件是事实，i18n 文案是展示。
2. 主窗口持有事件状态事实源，Widget 只消费快照。
3. 事件中心记录用户关心的运行活动，不记录高频底层噪音。
4. 事件类型、来源、级别和状态必须可被机器稳定识别。
5. 模块接入事件中心时，只记录生命周期事件，不记录连续进度 tick。

## 3. 事件模型

全局事件中心使用 `AppEvent` 表达运行活动。

```ts
export type AppEventScope =
  | "session"
  | "sftp"
  | "tunnel"
  | "proxy"
  | "remote-edit"
  | "rdp"
  | "ai"
  | "security"
  | "system";

export type AppEventLevel = "info" | "success" | "warning" | "error";

export type AppEventStatus =
  | "started"
  | "running"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled"
  | "state_changed";

export type AppEvent = {
  id: string;
  timestamp: number;
  scope: AppEventScope;
  type: string;
  level: AppEventLevel;
  status?: AppEventStatus;
  sessionId?: string | null;
  profileId?: string | null;
  resourceId?: string | null;
  titleKey: TranslationKey;
  messageKey?: TranslationKey;
  vars?: Record<string, string | number | boolean | null>;
  details?: Record<string, unknown>;
};
```

字段规范：

1. `id`：事件唯一标识。
2. `timestamp`：事件发生时间，使用毫秒时间戳。
3. `scope`：事件所属模块。
4. `type`：稳定事件类型，使用 `<scope>.<action>[.<result>]` 格式。
5. `level`：展示级别，用于颜色、筛选和摘要。
6. `status`：生命周期状态，用于表示开始、成功、失败、取消等结果。
7. `sessionId / profileId / resourceId`：事件关联对象。
8. `titleKey / messageKey / vars`：展示层 i18n 字段。
9. `details`：结构化调试信息，不作为主展示文案依赖。

## 4. 事件创建

事件必须通过统一创建工具生成，确保 `id`、`timestamp` 和默认级别一致。

```ts
export type CreateAppEventInput = Omit<
  AppEvent,
  "id" | "timestamp" | "level"
> & {
  id?: string;
  timestamp?: number;
  level?: AppEventLevel;
};

export function createAppEvent(input: CreateAppEventInput): AppEvent;
```

创建规则：

1. 未提供 `id` 时自动生成唯一 ID。
2. 未提供 `timestamp` 时使用当前时间。
3. 未提供 `level` 时默认为 `info`。
4. 业务代码应提供稳定的 `scope`、`type` 和 `titleKey`。
5. 错误事件应提供 `level: "error"` 和 `status: "failed"`。

## 5. 事件状态源

主窗口维护全局事件列表，并对 Widget 提供渲染快照。

状态规则：

1. `useSessionStateCore` 持有 `appEvents`。
2. `appendAppEvent` 是事件写入入口。
3. 事件列表保留最近固定数量的事件。
4. 事件列表持久化到 `fluxterm.appEvents`。
5. Widget 不直接维护事件事实源。

## 6. V1 展示范围

V1 事件中心展示以下事件：

1. 会话连接中。
2. 会话已连接。
3. 会话已断开。
4. 会话连接失败。
5. SFTP 不可用。
6. SFTP 上传开始、成功、失败、取消、部分成功。
7. SFTP 下载开始、成功、失败、取消、部分成功。

展示分工：

1. 事件 Widget 展示会话活动和 SFTP 可用性事件。
2. 传输 Widget 展示 SFTP 上传/下载生命周期事件和当前传输进度。
3. SFTP 进度 tick 只用于传输进度 UI，不进入事件列表。

## 7. Widget UI

事件 Widget 由状态摘要和最近活动列表组成。

状态摘要：

1. 会话状态。
2. 断开原因。
3. 自动重连信息。

最近活动列表：

1. 事件时间。
2. 事件级别。
3. 事件标题。
4. 事件补充文案。

空状态：

1. 无事件时展示空状态文案。
2. 空状态不影响顶部状态摘要展示。

## 8. 浮动窗口同步

事件 Widget 和传输 Widget 遵循主窗口快照同步模式。

事件 Widget 快照：

```ts
type FloatingEventsSnapshot = {
  sessionState: SessionStateUi;
  sessionReason: DisconnectReason | null;
  reconnectInfo: { attempt: number; delayMs: number } | null;
  events: AppEvent[];
};
```

传输 Widget 快照：

```ts
type FloatingTransfersSnapshot = {
  activeSessionId: string | null;
  progress: SftpProgress | null;
  busyMessage: string | null;
  events: AppEvent[];
};
```

同步规则：

1. 主窗口广播最小可渲染快照。
2. 浮动 Widget 启动后主动请求快照。
3. 浮动 Widget 的用户动作通过消息代理回主窗口执行。
4. BroadcastChannel 名称和消息类型保持稳定。

## 9. 模块接入规范

模块接入事件中心时应遵循以下规则：

1. 只记录用户可感知的生命周期事件。
2. 不记录高频输出、采样、输入或进度 tick。
3. 每个事件必须包含稳定 `scope` 和 `type`。
4. 事件应尽量关联 `sessionId`、`profileId` 或业务资源 ID。
5. 详情字段只放调试辅助信息，不承载主展示文案。

建议事件类型：

1. `session.connecting`
2. `session.connected`
3. `session.disconnected`
4. `session.error`
5. `sftp.upload.started`
6. `sftp.upload.success`
7. `sftp.upload.failed`
8. `sftp.upload.cancelled`
9. `sftp.download.started`
10. `sftp.download.success`
11. `sftp.download.failed`
12. `sftp.download.cancelled`
13. `tunnel.started`
14. `tunnel.stopped`
15. `proxy.started`
16. `proxy.stopped`
17. `remote-edit.synced`
18. `remote-edit.failed`
19. `rdp.connected`
20. `rdp.disconnected`
21. `ai.failed`
22. `security.state_changed`

## 10. 后续扩展

后续版本可以在不改变事件模型的前提下扩展以下能力：

1. 模块筛选。
2. 级别筛选。
3. 当前会话 / 全部会话切换。
4. 事件详情展开。
5. 事件导出。
6. 诊断包生成。

## 11. 验收标准

V1 完成后应满足：

1. 事件模型统一使用 `AppEvent`。
2. 事件写入统一使用 `appendAppEvent`。
3. 事件 Widget 使用 `AppEvent[]` 渲染最近活动。
4. 传输 Widget 使用 `AppEvent[]` 渲染传输历史。
5. 浮动事件和浮动传输 Widget 快照使用 `events: AppEvent[]`。
6. 源码统一使用全局事件模型。
7. `pnpm format` 和 `pnpm check` 通过。
