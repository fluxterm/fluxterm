# FluxTerm SFTP/RDP 性能遥测规范

## 1. 系统定位

性能遥测用于观察 SFTP 传输和 RDP 会话的运行表现，与结构化日志保持独立。完整系统由三部分组成：

- FluxTerm 遥测构建负责采集和发送指标。
- [fluxterm-pulse-protocol 0.1.0](https://github.com/fluxterm/fluxterm-pulse-protocol/tree/0.1.0) 定义线协议、流模型和指标目录。
- [FluxTerm Pulse Server](https://github.com/fluxterm/fluxterm-pulse-server) 负责接收、持久化、Dashboard 展示和分析导出。

标准 FluxTerm 构建不包含遥测功能。开发者使用以下命令生成遥测构建：

```powershell
pnpm dev:telemetry
pnpm build:telemetry
pnpm build:fast:telemetry
```

## 2. 启用配置

遥测构建在启动时从 Tauri app config 目录读取 `performance-telemetry.json`：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "destination": "192.168.1.20:43190",
  "intervalMs": 1000,
  "domains": ["sftp", "rdp"]
}
```

- 配置文件不存在或 `enabled` 为 `false` 时，遥测保持关闭。
- 配置仅在启动时读取，修改后重启 FluxTerm 生效。
- `intervalMs` 支持 `250–60000` 毫秒。
- `domains` 可以启用 `sftp`、`rdp` 或两者。
- `destination` 使用数字形式的回环地址、RFC1918 IPv4 或 ULA IPv6 地址。
- 配置采用严格 JSON，字段或取值无效时记录一次告警并继续启动应用。

首次启用时，同一目录会生成 `performance-telemetry-device.json`，保存安装级随机 `deviceId`。每次进程启动生成新的 `instanceId`。

## 3. 性能流模型

每个 SFTP 任务或 RDP 会话对应一条独立性能流：

| 流类型                  | 业务含义             |
| ----------------------- | -------------------- |
| `sftpUploadFile`        | 单个文件上传         |
| `sftpUploadDirectory`   | 单个目录上传         |
| `sftpUploadBatch`       | 两个及以上根路径上传 |
| `sftpDownloadFile`      | 单个文件下载         |
| `sftpDownloadDirectory` | 目录下载             |
| `rdpSession`            | RDP 会话             |

SFTP 流使用三个性能参数：

- `chunkSizeBytes`：实际分块大小。
- `requestWindow`：任务允许的在途请求窗口。
- `workerCount`：任务使用的文件 Worker 数。

RDP 流记录初始分辨率和八项体验开关。流类型本身已经表达 SFTP 的方向和任务形态。

流关闭结果包括 `succeeded`、`failed`、`cancelled`、`partial` 和 `disconnected`。

## 4. 协议与指标

协议使用 UTF-8 JSON 和 `schemaVersion: 1`，包含三类生命周期消息：

- `performance.stream.opened`
- `performance.metrics.snapshot`
- `performance.stream.closed`

单个 UDP 数据报最大为 1200 字节。指标快照只在完整指标之间拆分，并通过 `batchId`、`partIndex` 和 `partCount` 表达同一窗口的分片。`sequence` 在每条流内按数据报递增，Pulse Server 据此识别丢包、乱序和恢复流。

指标采用三种聚合类型：

- `gauge`：窗口最后值或高水位。
- `counterDelta`：窗口内增量。
- `histogram`：固定桶的样本分布。

指标名称、类型、单位、属性和直方图边界以 [机器可读指标目录](./performance-metrics.json) 为准。`pnpm performance-telemetry:check` 会校验本地目录与协议库保持一致。

## 5. 身份与数据范围

流元数据包含：

- 安装级 `deviceId`、可选设备名和进程级 `instanceId`。
- 目标 host 和 port。
- SSH 或 RDP 业务 `sessionId`。
- SFTP 任务的 `transferId`。

指标属性只使用低基数运行分类。遥测内容聚焦于性能数字，不采集用户名、凭据、路径、文件名、终端内容、剪贴板内容或 AI 内容。

设备、目标和业务关联会随生命周期消息发送，使 Pulse Server 在丢失打开消息时仍能恢复流身份。

## 6. 运行边界

发送端使用无确认、无重试的 UDP 尽力投递，适合开发者控制的受信任网络。Pulse Server 未启动、队列已满、单批数据无效或 UDP 发送失败时，FluxTerm 业务继续正常运行；发送状态可通过内部状态命令和结构化运行日志观察。

Pulse Server 按窗口原样存储有效指标，并提供设备、目标、业务域筛选，以及 SFTP 与 RDP 的独立分析导出。丢失或乱序窗口保持为数据空洞，不自动补零。
