# FluxTerm 路线图

本文档记录 FluxTerm 的主要能力方向与阶段性优先级，仅面向后续规划内容。已发布能力以 `CHANGELOG.md` 为准。

## 当前规划

### P1 SSH Profile 高级连接能力

目标：为所有 SSH Profile 提供更完整的连接配置能力，使手动添加与导入生成的配置在连接行为上保持一致，并逐步支持跳板机、代理、主机密钥校验与多密钥等高级能力。

当前进展：

- 已支持 SSH 建连代理模式：直连、系统代理、手动 HTTP 代理、手动 SOCKS5 代理
- 已支持手动代理认证信息保存，并接入现有 Profile 凭据加密流程
- 已支持“使用代理执行 DNS 查询”开关，允许在代理侧或本机侧解析目标主机
- 已支持从已有 SSH Profile 选择多级跳板机，并按顺序构建跳板链
- 已将正式 SSH 连接、Host Key 预检、SSH 资源监控统一到同一套 transport 构建逻辑
- 已支持 OpenSSH `ProxyJump` 原始字段保存，并尽量映射为 FluxTerm 内部跳板链
- 已保留 OpenSSH `ProxyCommand` 原始字段，但当前不执行外部命令
- 设计说明见 `docs/ssh-proxy-transport-design.md`

下一步：

- 补充 HTTP CONNECT、SOCKS5、系统代理解析和跳板链的模拟/集成测试
- 继续完善 OpenSSH 高级字段：多 `IdentityFile`、`UserKnownHostsFile`、`StrictHostKeyChecking`、`AddKeysToAgent`
- 评估 `ProxyCommand` 的安全模型与是否允许执行外部命令
- 补充系统代理绕过规则在 macOS/Linux 上的更完整支持
- 在 UI 中继续打磨跳板链编辑、代理清理和异常提示体验

### P2 串口功能

目标：基于 `tokio-serial` 增加串口连接能力，支持本地串口设备调试与终端交互。

当前进展：

- 已基于 `tokio-serial` 接入端口枚举、异步收发、主动断开与设备异常状态
- 已增加独立串口 Widget、Profile 分组和独立存储；端口发现集中在配置弹窗
- 已将会话类型统一为 SSH、本地 Shell、串口；串口复用主工作区标签与 Pane，但使用专属监视器而非 xterm.js
- 已支持终端/监视器双视图、文本/HEX 收发、时间戳、换行、本地回显、发送历史和日志保存
- 已支持 UTF-8 与 GB18030 文本编码，HEX 视图保留原始字节
- 设计说明见 `docs/serial-design.md`

下一步：

- 补充 Windows、macOS、Linux 的真实设备与虚拟串口对回归
- 根据使用反馈评估周期发送、宏命令和协议帧解析
- 评估 VID/PID/序列号设备身份匹配与端口迁移恢复

### P3 远程桌面功能

目标：基于 `IronRDP` 增加远程桌面访问能力，扩展 FluxTerm 的远程运维场景。

下一步：

- 已确认使用 `SubApp` 承载
- 当前实现已落地为 `src-tauri` 编排 + `crates/rdp_core` 进程内 runtime + 本地 WebSocket bridge
- 主窗口继续负责 Profile 管理与发起连接，RDP 子应用继续负责运行态与画面显示
- 当前阶段优先稳固基础能力，包括国际化、telemetry、注释收敛、文档同步与冗余清理
- 按 `docs/rdp-subapp-design.md` 持续推进实施与记录进度
