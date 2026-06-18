# SSH 代理与跳板链设计说明

本文档记录 SSH 高级连接能力的当前设计。该能力覆盖 SSH Profile 出站代理、系统代理、HTTP/SOCKS5 代理、代理 DNS 策略，以及基于已有 SSH Profile 的多级跳板链。

## 目标

- SSH Profile 可以选择直连、系统代理、手动代理或跳板机连接。
- 手动代理支持 HTTP CONNECT 与 SOCKS5。
- 手动代理密码接入现有 Profile 凭据加密流程。
- 跳板机从已有 SSH Profile 中选择，不在目标 Profile 内嵌跳板服务器明细。
- 正式 SSH 连接、Host Key 预检、SSH 资源监控使用一致的连接构建逻辑。
- OpenSSH 导入继续保留 `ProxyJump` / `ProxyCommand` 原始字段，并尽量将 `ProxyJump` 映射为内部跳板链。

## Profile 字段

`HostProfile` 增加以下连接字段：

- `proxyMode`: `direct`、`system`、`manual`
- `proxyConfig`: 手动代理配置，包含协议、主机、端口、用户名、密码引用和 DNS 查询策略
- `jumpProfileIds`: 多级跳板链，按顺序保存已有 SSH Profile 的 id

`proxyCommand` 与 `proxyJump` 继续保留用于 OpenSSH 导入兼容。当前版本不执行外部 `ProxyCommand`。

## 连接构建

engine 中的 `ssh_transport` 负责将 Profile 转换为可供 `russh::client::connect_stream` 使用的字节流。

直连模式使用 `TcpStream::connect` 连接目标主机。

系统代理模式在连接时读取当前系统代理配置：

- Windows 读取当前用户 Internet Settings 的 `ProxyEnable`、`ProxyServer` 和 `ProxyOverride`
- macOS 使用 `scutil --proxy`
- Linux 使用 `ALL_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY` 及其小写形式

当系统未配置代理或目标为本机地址时回退直连。

手动代理模式根据 `proxyConfig.protocol` 建立代理隧道：

- HTTP 使用 CONNECT，只作为 TCP 隧道，不代理普通 HTTP 请求
- SOCKS5 支持无认证与用户名密码认证

## DNS 策略

手动代理配置提供 `useProxyDns`。

- 启用时，将目标主机名交给 HTTP/SOCKS5 代理，由代理侧解析 DNS
- 关闭时，FluxTerm 在本机解析目标主机，再将 IP 地址交给代理连接

默认值为启用，避免改变代理用户通常期望的远端 DNS 行为。

## 跳板链

目标 Profile 的 `jumpProfileIds` 指向已有 SSH Profile。连接前由 Tauri 命令层读取并解密这些 Profile，生成 `JumpHostSpec`。

跳板链连接流程：

1. 第一跳按自身 Profile 的代理规则建立出站流。
2. 每一跳完成 Host Key 策略处理和 SSH 认证。
3. 上一跳登录成功后，通过 `channel_open_direct_tcpip(next.host, next.port, "127.0.0.1", 0)` 打开到下一跳的 TCP 通道。
4. 在该通道上继续使用 `russh::client::connect_stream` 建立下一段 SSH。
5. 目标会话运行期间保留所有中间跳板 `Handle`，避免中间链路提前释放。

跳板链限制：

- 最大深度为 8
- 阻止目标 Profile 与跳板链中的循环引用
- 缺失跳板 Profile 会返回明确错误

## Host Key 与资源监控

Host Key 预检使用与正式连接相同的代理和跳板链路，避免预检直连但正式连接走代理/跳板导致行为不一致。

SSH 资源监控也使用同一连接计划，并带有连接超时保护。这样同一个 Profile 在终端连接、Host Key 预检和资源监控中的网络行为保持一致。

## 前端交互

SSH 高级页提供一个“代理”选择框：

- 直连
- 系统代理
- 手动代理
- 跳板机

选择手动代理时展示协议、地址、端口、用户名、密码与 DNS 查询策略。选择跳板机时展示按顺序添加的跳板节点，下拉项来自已有 SSH Profile，并排除当前 Profile。

代理配置和跳板机配置不会同时显示。

## 已知限制

- 当前不执行 OpenSSH `ProxyCommand`。
- Linux 系统代理只读取环境变量，没有统一读取桌面环境代理配置。
- macOS 系统代理绕过规则尚未完整映射。
- 代理和跳板链的模拟/集成测试仍需补充。
