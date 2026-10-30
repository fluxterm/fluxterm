# 终端拆分工作区设计

## 文档目标

本文档描述当前已落地的终端拆分工作区实现，用于维护、排障与后续演进参考。

## 当前模型

当前终端区域采用：

1. 单根工作区树模型
2. Pane 作为可拆分区域
3. 每个 Pane 顶部配置独立工作区栏
4. Pane 内可承载多个会话，并支持区域内排序
5. 全局不提供额外的顶层总工作区栏

## 核心状态模型

### 工作区状态

工作区状态定义在 `src/types.ts`：

```ts
type SessionPaneNode =
  | {
      kind: "leaf";
      paneId: string;
      sessionIds: string[];
      activeSessionId: string | null;
    }
  | {
      kind: "split";
      axis: "horizontal" | "vertical";
      ratio: number;
      first: SessionPaneNode;
      second: SessionPaneNode;
    };

type SessionWorkspaceState = {
  root: SessionPaneNode | null;
  activePaneId: string | null;
};
```

语义说明：

1. `root` 是唯一的终端工作区根节点
2. `leaf` 表示实际可见的终端区域
3. `leaf.sessionIds` 表示区域内会话列表
4. `leaf.activeSessionId` 表示区域当前活动会话
5. `split` 表示区域拆分节点，`ratio` 保存分割比例
6. `activePaneId` 表示当前全局活动区域

### 活动会话派生

当前不单独存储“独立活动 tab”。`activeSessionId` 由工作区状态派生：

1. 定位 `activePaneId` 对应的 leaf
2. 读取该 leaf 的 `activeSessionId`
3. 若为空，则回退到该 leaf 最后一个会话

相关逻辑位于 `src/features/session/core/workspaceReducer.ts` 的 `getActiveSessionIdFromWorkspace()`。

## 分层职责

### 会话状态层

入口：

- `src/features/session/hooks/useSessionStateCore.ts`
- `src/features/session/hooks/useSessionWorkspace.ts`
- `src/features/session/core/workspaceReducer.ts`

职责：

1. 管理 SSH / 本地 Shell 连接生命周期
2. 管理会话与工作区树的附着关系
3. 维护 Pane 拆分、区域聚焦、区域内会话排序与区域收缩
4. 对 UI 暴露 Pane 级操作接口

### 终端运行时层

入口：

- `src/hooks/useTerminalRuntimeCore.ts`

职责：

1. 为每个 `sessionId` 管理一个 xterm 实例
2. 处理终端输出、输入、搜索、复制与链接菜单
3. 将终端实例与布局容器生命周期分离，split 后迁移原实例的显示宿主并保留内容
4. 监听每个终端容器尺寸变化并执行 `fit / resize`

### UI 编排层

入口：

- `src/components/terminal/sessions/TerminalPanel.tsx`
- `src/components/terminal/sessions/TerminalPaneTree.tsx`
- `src/components/terminal/sessions/useTerminalMenus.tsx`
- `src/components/terminal/sessions/TerminalSearchBar.tsx`

职责：

1. 将工作区树渲染为实际 split 布局
2. 为每个 Pane 渲染工作区栏
3. 处理区域内会话右键菜单、拖拽排序与搜索栏显示

## 关键交互语义

### 新建会话

新建会话不总是创建新区域，而是：

1. 若工作区为空，则创建根 leaf
2. 若工作区已存在，则优先附着到当前活动区域

### 拆分区域

拆分行为由 `splitActivePane()` 驱动。

规则如下：

1. 仅对当前活动区域执行拆分
2. 复制当前活动会话的连接来源：
   - 本地 Shell：创建新的本地 Shell 会话
   - SSH 会话：基于同一 Profile 创建新的 SSH 会话
3. 原区域成为 split 的第一子节点
4. 新区域成为 split 的第二子节点
5. 新区域自动成为活动区域

方向语义：

1. `horizontal` 表示左右拆分
2. `vertical` 表示上下拆分

### 区域工作区栏

每个 leaf Pane 顶部包含一条 `terminal-header` 工作区栏，负责：

1. 展示区域内会话列表
2. 切换区域当前活动会话
3. 区域内会话拖拽排序
4. 当前会话右键菜单
5. 当前会话关闭按钮

### 区域内关闭语义

右键菜单中的以下操作仅对当前区域生效：

1. 关闭当前会话
2. 关闭其他会话
3. 关闭右侧会话
4. 关闭全部会话

关闭链路：

1. 根据 `paneId` 找到区域内的 `sessionIds`
2. 调用现有 `disconnectSession()`
3. reducer 通过 `detach-session` 从工作区树移除会话
4. 若 leaf 最后一个会话被关闭，则删除该 leaf
5. 若 split 某一侧清空，则自动折叠为剩余子树

## 工作区树变换规则

### `attach-session`

1. 首个会话创建根 leaf
2. 新增会话附着到目标 Pane 或当前活动 Pane

### `activate-session`

1. 根据 `sessionId` 找到所在 leaf
2. 将该 leaf 设为活动区域
3. 将该会话设为该 leaf 的活动会话

### `focus-pane`

1. 切换当前活动区域
2. 保留该区域现有活动会话
3. 若该区域没有显式活动会话，则回退到最后一个会话

### `split-pane`

1. 找到目标 leaf
2. 使用 split 节点替换原 leaf
3. 原 leaf 成为第一子节点
4. 新建 leaf 成为第二子节点
5. 新 leaf 成为活动区域

### `detach-session`

1. 从对应 leaf 的 `sessionIds` 中移除目标会话
2. leaf 为空时删除该 leaf
3. split 某一侧为空时，直接提升另一侧子树
4. 重新选择仍存在的活动区域

### `reorder-pane-sessions`

1. 仅在当前 Pane 内部调整 `sessionIds` 顺序
2. 不跨区域移动会话
3. 不影响其他 Pane

### `resize-split`

1. split 比例存储在父 split 节点上
2. 当前实现通过句柄定位到该 split 下任意一个叶子 Pane，再向上更新对应 split 的 `ratio`
3. 比例限制在 `0.2 ~ 0.8`

## 终端运行时设计

### xterm 实例与 session 的关系

当前为一对一关系：

1. 每个 `sessionId` 对应一个 xterm bundle
2. bundle 内包含：
   - `terminal`
   - `fitAddon`
   - `searchAddon`
   - `webglAddon`
   - `host / container`
   - `disposables`

### 容器挂载与实例生命周期

当 React 将某个 `sessionId` 容器挂载到 DOM 时：

1. 调用 `registerTerminalContainer(sessionId, element)`
2. 若已有 bundle，将其 `.terminal-runtime` 节点移入新容器；不重复创建实例或执行 `open()`
3. 若尚不存在 bundle，则合并异步创建请求；加载完成后检查会话有效性，并使用最新容器创建实例
4. 在布局稳定后处理 `fit / focus / resize` 和刷新；旧实例或旧挂载代次的延迟任务失效

容器卸载时：

1. 取消对应尺寸观察
2. 将终端显示宿主从 DOM 移除，保留 xterm、插件、缓冲区及输出队列
3. 只有会话从 sessions 移除或整个终端运行时退出时才销毁 bundle；断线但保留标签不销毁

### split 后内容保留

拆分和区域收缩只改变显示宿主所在的容器，同一 `sessionId` 始终复用原 xterm 实例。

因此：

1. 历史输出、备用屏幕、插件状态及待排空输出保留在原实例中
2. 暂时脱离 DOM 的实例继续接收串行输出，不回放历史、不主动滚动到底部
3. `sessionBuffersRef` 只为尚未创建实例的会话保留有界尾部输出，首次创建后消费并清空

“保存会话”读取 xterm 当前保留的缓冲区；历史范围受回滚行数设置限制，不维护无限增长的原始输出副本。

异步创建任务在会话关闭或运行时退出后失效。未连接到文档或尺寸为零的容器不发送 PTY resize；恢复显示后重新同步。尺寸观察回调必须匹配当前宿主，防止旧容器事件干扰新布局。

### 尺寸同步

当前并非仅观察活动会话，而是每个终端容器都独立挂载 `ResizeObserver`。

该设计用于覆盖：

1. split 后非活动区域尺寸变化但未及时 `fit` 的场景
2. 需要重新聚焦后才恢复显示的场景

### 保存会话

保存流程：

1. UI 根据当前操作的 `sessionId` 调用 `getSessionBufferText(sessionId)`
2. 运行时优先从 xterm buffer 导出文本
3. 若 xterm 当前不存在，则回退到 `sessionBuffersRef`
4. 上层使用 Tauri 的保存对话框与文件写入能力完成落盘

当前导出为纯文本，不保留 ANSI 样式。

## UI 结构

### `TerminalPanel`

职责：

1. 解析会话名称与状态
2. 为 `sessionId` 提供稳定的 terminal 容器 ref
3. 连接 Pane 树、菜单与搜索栏

### `TerminalPaneTree`

职责：

1. 递归渲染 split / leaf
2. 渲染区域工作区栏
3. 渲染每个会话对应的 `terminal-container`
4. 处理区域内拖拽排序与 split resize

### `useTerminalMenus`

负责三类菜单状态：

1. 终端正文右键菜单
2. 区域工作区栏会话菜单
3. 链接菜单

### `TerminalSearchBar`

负责搜索栏局部状态：

1. 关键字
2. 大小写 / 正则 / 全词匹配
3. 高亮开关
4. 搜索结果统计显示

## 设计边界

### 当前已支持

1. Pane 拆分
2. 区域内多会话
3. 区域内会话拖拽排序
4. 区域级关闭语义
5. 区域 resize
6. split 后终端内容恢复
7. 保存完整会话文本

### 当前未覆盖

1. 区域之间拖拽移动会话
2. 多工作区根节点
3. 会话跨区域拖放
4. 自动化单元测试
5. 输出缓存上限控制

## 维护要点

### 变更工作区语义时

优先检查：

1. `src/features/session/core/workspaceReducer.ts`
2. `src/features/session/hooks/useSessionWorkspace.ts`
3. `src/features/session/hooks/useSessionStateCore.ts`

工作区语义应首先在状态层完成收敛，再映射到 UI。

### 变更 split / 显示行为时

优先检查：

1. `TerminalPaneTree.tsx` 是否影响容器尺寸结构
2. `useTerminalRuntimeCore.ts` 的容器观察与 `finalizeTerminalMount()` 是否覆盖目标场景

### 变更会话导出与恢复时

优先检查：

1. 导出是否读取当前 xterm 缓冲区，并遵守回滚行数设置
2. 布局迁移是否复用同一实例，异步创建前的有界缓存是否仅消费一次

## 相关文件

- `src/types.ts`
- `src/features/session/core/workspaceReducer.ts`
- `src/features/session/hooks/useSessionWorkspace.ts`
- `src/features/session/hooks/useSessionStateCore.ts`
- `src/features/terminal/hooks/useTerminalRuntimeCore.ts`
- `src/components/terminal/sessions/TerminalPanel.tsx`
- `src/components/terminal/sessions/TerminalPaneTree.tsx`
- `src/components/terminal/sessions/useTerminalMenus.tsx`
- `src/components/terminal/sessions/TerminalSearchBar.tsx`
