# FluxTerm 架构 v1

## 概述

FluxTerm 是一款面向 SSH 与 SFTP 工作流的现代桌面终端。当前平台优先级以 Windows 与 macOS 为主，Linux 作为持续兼容目标。

## 架构目标

- 提供稳定的 SSH 连接与交互式终端会话
- 提供本地串口设备调试与终端交互能力
- 提供一致的 SFTP 传输与基础文件管理能力
- 保持连接与会话逻辑的单一核心引擎实现
- 维持统一视觉体系，并支持跨窗口一致性
- 采用模块化架构，确保职责清晰、边界稳定、易于维护

## 总体架构

```text
frontend (React/Vite)  --->  tauri (Rust)  --->  fluxterm-engine (Rust)
```

## 模块说明

### `crates/engine` (`fluxterm-engine`)

核心连接与文件传输引擎。

- SSH 客户端：认证、会话与终端 I/O
- 串口客户端：设备枚举、原始字节收发与会话生命周期
- SFTP 客户端：列出、上传、下载、重命名与删除
- 会话生命周期、重试与超时抽象

#### SFTP 传输执行模型

- 批量上传与下载采用流水线模型：`Scanner -> TaskQueue -> WorkerPool -> ProgressAggregator`
- 扫描与传输并行执行，降低全量预扫描对首帧响应的影响
- 文件级并发与窗口化读取用于改善高延迟链路表现
- 远端目录按需创建并缓存去重，减少重复往返

### `crates/rdp_core`（`fluxterm-rdp-core`）

RDP 协议任务独占解码画面与每个桥接连接的图形发送状态。控制事件使用广播通道，RGBA 图形使用单批次消费确认与有界脏区域累计；等待时不复制旧像素。新连接和尺寸变化使用带代次、序号的完整快照，Worker 与主线程渲染器共用验证规则。键鼠控制仍经 Tauri 命令转发。详见 `docs/rdp-subapp-design.md` 与 `docs/rdp-performance-test.md`。

图形输入支持传统更新与 RDPEGFX 通道。AVC420 使用 OpenH264 软件解码，每个表面独立保存参考帧；合成结果写入同一权威 RGBA 画面并复用背压链路。IronRDP 固定到单一上游提交，认证兼容、图形区域及尺寸处理补丁在 `vendor/` 中维护，来源与更新规则见 `vendor/README.md`。

### `src-tauri`

桌面 GUI 外壳。

- 连接前端与 `fluxterm-engine`
- 向前端暴露 Rust 命令接口
- 管理窗口能力权限与原生窗口行为

### `crates/logging`

跨 Rust crate 复用的结构化日志核心。

- 负责事件校验、保留字段、脱敏、大小限制和错误结构
- 通过 `log` facade 接入 Tauri 日志输出端

### `frontend`

React 前端采用“领域能力 + 运行单元壳层”结构：

- `src/features`：会话、终端、SFTP、AI 等领域能力
- `src/main`：主窗口壳层，负责布局编排、菜单与窗口管理
- `src/widgets`：可停靠、可浮动的 Widget 适配层
- `src/subapps`：独立子应用窗口壳层与入口
- `src/components/ui`：跨运行单元复用的基础 UI 组件

通用约束：

- 业务逻辑优先沉淀在 `features`
- 常量统一放置于 `src/constants`
- Hook 默认位于 `src/hooks`，运行单元专属 Hook 下沉到对应目录
- 运行单元术语统一为 `Main / Widget / SubApp`

## 数据流

1. 用户通过 SSH、本地 Shell 或串口入口发起终端会话。
2. Main 按显式会话类型调用对应运行时，并将会话附着到统一工作区；SSH/本地 Shell 挂载 xterm，串口挂载结构化监视器。
3. SSH 与本地 Shell 输出使用文本事件；串口通过二进制安全事件保留原始字节。
4. SSH 专属的 SFTP、隧道和资源监控能力仅在 SSH 会话中启用。

## 配置与存储

- 配置根目录由 `src-tauri/src/config_paths.rs` 解析
- 应用运行数据存放于 `app_data_dir`
- 凭据采用本地 Provider 加密存储
- SSH 与 RDP 可复用凭据按协议类型隔离保存在统一密码管理器中，Profile 通过 `credentialId` 动态引用
