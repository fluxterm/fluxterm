# FluxTerm RDP 子应用设计

## 1. 文档目标

本文档记录 FluxTerm 当前已经落地的 RDP 实现边界、运行时拆分、通信方式与维护约束。

本文档以仓库当前代码为准，目标是为后续稳固、排障和增量开发提供统一事实来源。

## 2. 当前实现结论

当前 RDP 功能采用以下结构：

1. 主窗口负责 RDP Profile 管理与发起连接
2. `RDP SubApp` 负责会话标签、画面显示、键鼠输入与会话状态展示
3. `src-tauri` 负责 Profile 读取、安全解密、命令编排与会话快照代理
4. `crates/rdp_core` 负责进程内 `IronRDP` 运行时、本地 WebSocket bridge、图像帧广播与输入转发

- `src-tauri` 与 `rdp_core` 运行在同一应用进程内
- 高频画面数据不经过 Tauri 事件总线
- 前端子应用通过本地 loopback WebSocket 直连 `rdp_core` bridge

## 3. 运行单元与职责

### 3.1 主窗口

主窗口当前职责：

- 展示 RDP Profile 列表
- 打开 RDP Profile 配置弹窗
- 在用户双击 Profile 后唤起或聚焦 RDP 子应用
- 向目标子应用发送 `subapp:rdp-connect`

主窗口不负责：

- 持有 RDP runtime
- 直接创建、连接或断开 RDP 会话
- 渲染远端桌面画面

### 3.2 RDP 子应用

RDP 子应用当前职责：

- 消费主窗口下发的 `profileId`
- 重新读取已保存的 Profile 并创建 RDP 会话
- 管理会话标签页与当前活动会话
- 通过 Worker + OffscreenCanvas 渲染远端画面
- 采集键盘、鼠标、滚轮输入并转发给后端
- 展示连接状态、bridge 状态、FPS、分辨率与证书确认 UI

RDP 子应用不负责：

- Profile CRUD
- 长期持久化 Profile 草稿
- 接管主窗口的配置管理职责

### 3.3 `src-tauri`

`src-tauri` 当前职责：

- 读取与写入 RDP Profile / 分组数据
- 处理敏感字段解密与加密
- 对前端暴露 RDP 相关 Tauri command
- 将前端 DTO 转换为 `rdp_core` 运行时参数
- 维护本地 `RdpState` 快照，作为子应用命令调用的代理层

### 3.4 `crates/rdp_core`

`rdp_core` 当前职责：

- 启动和维护单个或多个 `IronRDP` 会话
- 管理会话状态、输入命令与桥接广播
- 在 loopback 地址启动本地 WebSocket bridge
- 以 RGBA 脏矩形或批量脏矩形形式向前端推送画面
- 处理窗口跟随 resize、动态重连激活、光标与基础剪贴板事件

## 4. 通信设计

### 4.1 控制面

前端到 `src-tauri` 的低频控制操作统一走 Tauri command，包括：

- `rdp_profile_*`
- `rdp_session_create`
- `rdp_session_connect`
- `rdp_session_disconnect`
- `rdp_session_resize`
- `rdp_session_send_input`
- `rdp_session_set_clipboard`
- `rdp_session_cert_decide`

### 4.2 图像与状态面

RDP 画面和高频状态通过 `rdp_core` 本地 WebSocket bridge 下发：

- 文本消息：状态、光标、剪贴板、错误、输入确认
- 二进制消息：单脏矩形帧或批量脏矩形帧

这样做的原因：

- 避免高频 RGBA 数据穿过 Tauri invoke / event 链路
- 让 `src-tauri` 保持编排层，而不是热点转发层
- 方便前端 Worker 直接做局部渲染与标签切换

### 4.3 前端渲染链

当前渲染链为：

1. `RdpSubApp.tsx` 创建 Worker 与 OffscreenCanvas
2. `rdp.worker.ts` 维护每个会话对应的 WebSocket、纹理与待渲染帧队列
3. `WebGLRenderer.ts` 负责脏矩形上传、纹理提交与最终绘制
4. 主线程只消费关键状态和指标，不参与像素级解码

## 5. 当前状态模型

### 5.1 会话状态

当前会话状态使用以下值：

- `idle`
- `connecting`
- `connected`
- `reconnecting`
- `certificate_prompt`
- `disconnected`
- `error`

### 5.2 RDP 子应用状态展示

RDP 子应用状态栏当前展示：

- 当前状态文案
- 活动会话数量
- 可见呈现 FPS 估算值
- 当前远端分辨率
- bridge 状态

其中 FPS 是“画面提交到当前活动画布后的估算值”，不是宿主窗口最终上屏帧率。

## 6. 维护约束

后续 RDP 相关开发应继续遵守以下约束：

1. Profile 管理入口只保留在主窗口，不回流到子应用
2. 主窗口只发起连接意图，不直接持有 RDP runtime
3. 子应用是唯一的远程桌面运行态 owner
4. `rdp_core` 是 RDP 底层协议、bridge 与会话状态的 source of truth
5. 用户可见文案必须走 `src/i18n`
6. RDP 相关日志统一遵循结构化日志规范，避免 `console.*` 或不可检索自由文本
7. 不允许通过前端补丁掩盖后端、runtime、状态机或生命周期问题

## 7. 主窗口与子应用职责边界

### 7.1 主窗口域

主窗口中的 RDP 相关单元当前包括：

- `RdpWidget`
- `RdpProfileModal`
- `useSubApps`

职责划分如下：

- `RdpWidget` 负责展示已保存的 RDP Profile，并提供选中、双击连接、刷新和配置入口
- `RdpProfileModal` 负责新增、编辑、删除 RDP Profile
- `useSubApps` 负责创建、复用、聚焦 RDP 子应用窗口，并发送 `subapp:rdp-connect`

### 7.2 子应用域

RDP 子应用当前保留以下运行态职责：

- 会话标签栏
- 远程画面视口
- 状态栏指标
- 键盘、鼠标、滚轮输入采集
- 会话切换与关闭
- 证书确认、错误状态、连接状态展示

### 7.3 连接流程

当前双击连接链路为：

1. 用户在主窗口双击某个 RDP Profile
2. 主窗口调用 `useSubApps.connectRdpProfile(profile.id)`
3. `useSubApps` 打开或复用目标子应用窗口
4. 主窗口通过 `BroadcastChannel` 向目标子应用发送 `subapp:rdp-connect`
5. 子应用重新读取 Profile 列表并解析目标 Profile
6. 子应用内部执行 `createRdpSession` 与 `connectRdpSession`

该边界要求：

- 主窗口只负责“管理和发起”
- 子应用只负责“运行和显示”
- 主窗口不能直接持有 RDP 会话 runtime

## 8. 键盘输入策略

RDP 键盘输入当前采用“两段式”策略：

1. 前端负责采集 `keydown` / `keyup`、透传 `code` / `key` / 修饰键状态，并在失焦时补发 `key_up`
2. `rdp_core` 负责把 `KeyboardEvent.code` 映射为 RDP 扫描码，并在运行时判断某次输入应走 Unicode 还是扫描码

具体规则：

- 未按下 `Ctrl` / `Alt` / `Meta` 的单个可打印字符优先走 Unicode
- 控制键、导航键、功能键、小键盘和组合键优先走扫描码
- 扫描码映射表维护在 `crates/rdp_core/src/keyboard.rs`
- Unicode / 扫描码分流逻辑维护在 `crates/rdp_core/src/ironrdp_runtime.rs`

## 9. 当前已知边界

截至当前实现，以下能力已具备：

- 真实远端桌面显示
- 键盘、鼠标、滚轮输入
- 窗口跟随分辨率
- WebSocket bridge 画面传输
- 多会话标签切换
- 基础证书决策入口
- 基础剪贴板事件通路

以下仍是后续演进项，不应误写成已完成能力：

- 完整交互式证书验证体验
- 真实远端剪贴板双向同步
- 更完整的会话重连策略
- 更细粒度的 runtime 操作菜单
