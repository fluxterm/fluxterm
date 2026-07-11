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
frontend (React/Vite)  --->  tauri (Rust)  --->  engine (Rust)
```

## 模块说明

### `crates/engine`

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

### `src-tauri`

桌面 GUI 外壳。

- 连接前端与 `engine`
- 向前端暴露 Rust 命令接口
- 管理窗口能力权限与原生窗口行为

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

## 安全性考虑

- SSH 主机身份校验由应用独立维护
- SSH 连接与资源监控连接遵循统一主机校验策略
- 敏感凭据采用最小化明文暴露原则
- SFTP 操作范围限定在明确目标路径

## 平台说明

- Windows 与 macOS 为首要支持平台，优先保证测试覆盖与体验一致性
- Linux 兼容性设计需避免平台特化假设

## 文档索引

- `docs/window-app-model.md`：窗口模型、生命周期协议与目录归属
- `docs/terminal-split-workspace-design.md`：终端拆分工作区与会话重建策略
- `docs/security-crypto-refactor-design.md`：加密模块与凭据存储设计
- `docs/serial-design.md`：串口 Widget、运行时、二进制事件与调试台设计
