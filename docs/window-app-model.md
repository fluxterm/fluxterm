# 窗口与应用模型设计（Main / Widget / SubApp）

## 1. 目标

本规范定义 FluxTerm 的运行单元边界、窗口生命周期、通信契约与目录归属。

该文档是窗口模型的唯一细则来源；`ARCHITECTURE_V1.md` 保留高层总览。

## 2. 运行单元定义

### 2.1 Main（主窗口）

- 对应 Tauri `main` 窗口
- 负责全局编排，包括布局、会话、主题、语言、窗口注册与回收
- 负责发起与销毁 Widget / SubApp 窗口

### 2.2 Widget（组件）

- 可在主窗口布局中展示，也可浮动到独立窗口
- 浮动窗口是独立 Webview，不假设与主窗口共享 React 运行时状态
- 依赖主窗口运行时状态的 Widget 应遵循“快照 + 动作代理”模式
- 术语统一使用 `Widget` 表达组件运行单元

### 2.3 SubApp（子应用）

- 仅在独立 Tauri 窗口中运行，不进入主窗口布局容器
- 生命周期由 Main 统一管理
- 子应用可拥有自己的菜单栏与工作流，但不承载主窗口布局语义

## 3. 判定规则：Widget 还是 SubApp

优先归类为 Widget：

1. 需要与主窗口布局共存，支持停靠或浮动
2. 功能是主窗口某个领域能力的投影与入口
3. 强依赖当前活动会话或主窗口上下文

优先归类为 SubApp：

1. 功能是独立工作流，需要在独立窗口中完成
2. 需要独立导航、菜单或窗口级交互
3. 不适合作为主窗口布局中的停靠组件

## 4. 生命周期与通信

### 4.1 单一事实源

1. Main 持有窗口编排与生命周期真相
2. Widget 浮动窗口消费快照，不直接维护主业务真相
3. SubApp 可维护自身业务状态，但窗口生命周期由 Main 协调

### 4.2 Widget 协议

沿用 `docs/floating-panel-snapshot-pattern.md`：

1. Main 广播最小快照
2. 浮动 Widget 请求并消费快照
3. 用户动作通过消息代理回 Main 执行

### 4.3 SubApp 协议

- `subapp:launch`：Main -> SubApp，启动事件
- `subapp:ready`：SubApp -> Main，窗口就绪
- `subapp:focused`：Main -> SubApp，窗口聚焦语义
- `subapp:close-request`：Main / SubApp 双向关闭请求
- `subapp:closed`：SubApp -> Main，窗口已关闭
- `subapp:main-shutdown`：Main 关闭前广播，触发子窗口联动回收
- `subapp:appearance-sync`：Main -> SubApp，实时同步 `locale / theme / background / alpha`

### 4.4 应用锁屏协议

1. 应用锁屏状态由 Tauri 进程内状态持有，程序完全退出后恢复为未锁定
2. 所有 Webview 通过 `lock-screen://changed` 事件同步状态，并在首次查询完成前按锁屏态遮挡内容
3. 只有 Main 可以发起锁定、解锁和修改锁屏密码；Widget 浮窗与 SubApp 仅展示锁定提示
4. 锁定时各窗口保留标题栏、拖动与系统窗控，隐藏业务菜单并遮挡业务区
5. 锁屏不卸载业务运行单元，也不改变连接、传输或凭据加密会话

## 5. 标题栏与外观一致性

1. SubApp 标题栏行为与 Main 保持一致，包括拖拽、双击最大化与窗口控制按钮
2. SubApp 标题栏品牌区与 Main 保持一致，包括品牌名与 Logo
3. SubApp 与 Main 共用主题、背景图与全局透明度
4. Main 外观变更后，SubApp 通过 `subapp:appearance-sync` 实时生效
5. Main 与 SubApp 的差异应体现在菜单内容，而非视觉体系与窗口行为

## 6. 入口与菜单规则

1. Main 标题栏提供子应用入口菜单，命名为“应用”
2. 该菜单用于 SubApp 的启动、聚焦与关闭，不承载 Widget 切换
3. 子应用内部菜单采用 i18n key 驱动，并支持实时语言切换

### 6.1 平台差异规则（macOS / Windows / Linux）

1. App 级菜单（macOS 顶部系统菜单）仅由 Main 窗口安装与维护；`widget-*` 与 `subapp-*` 不得安装或覆盖
2. Widget 浮窗与 SubApp 的菜单归属遵循“Main 单一事实源”
3. macOS 下，Widget 浮窗与 SubApp 优先使用原生标题栏，以保持窗口拖拽、系统窗控与平台习惯一致
4. Windows / Linux 下可继续使用当前窗口壳策略，但必须保持 Main 作为菜单编排与生命周期真相

## 7. 前端目录归属

```text
src
├─ main/                 # 主窗口壳层与全局编排
├─ features/             # 领域能力与状态（窗口形态无关）
├─ widgets/              # Widget 适配层
├─ subapps/              # SubApp 壳层与入口
├─ hooks/                # 默认 Hook 入口
├─ constants/            # 常量唯一入口
├─ components/ui/        # 跨运行单元通用 UI
└─ shared/               # 严格白名单的跨域通用模块
```

约束：

1. 业务逻辑优先放置于 `features`
2. `widgets` 不依赖 `subapps` 内部实现，`subapps` 不反向依赖 `widgets` 内部实现
3. 非通用业务代码不得进入 `shared`
4. Hook 归属规则为：可明确判定运行单元则下沉，否则放在 `src/hooks`
5. 常量统一放在 `src/constants`

## 8. 反模式清单

1. 将 SubApp 功能先塞入主窗口停靠区，再在后期抽离
2. 浮动 Widget 直接复用主窗口运行时状态并假设共享
3. 通过 UI 临时补丁替代对后端或状态源问题的修正
4. 在多份文档中重复描述同一窗口细则，导致版本漂移
