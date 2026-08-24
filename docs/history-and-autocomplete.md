# 历史命令与命令联想设计

## 1. 范围

本文定义以下能力的当前设计：

- 终端输入行实时监听
- 历史命令记录、检索与持久化
- 基于历史命令的联想候选生成
- 终端联想浮层展示与交互
- 主窗口与浮动历史面板同步

## 2. 模块划分

### 2.1 历史命令核心

目录：`src/features/command-history/core`

- `storage.ts`
  负责 `command-history.json` 的加载、保存与数据规范化
- `query.ts`
  提供历史命令排序与搜索过滤
- `autocomplete.ts`
  定义联想 Provider 接口与默认历史命令 Provider
- `inputTracker.ts`
  维护联想输入缓冲与相关工具
- `widgetSync.ts`
  定义主窗口与浮动历史面板的同步协议

### 2.2 状态与运行时

- `src/hooks/useCommandHistoryState.ts`
  聚合运行期会话历史、全局历史、实时监听状态与搜索状态
- `src/hooks/useTerminalRuntimeCore.ts`
  在终端运行时中处理输入监听、命令提交收口、联想导航与浮层锚点计算

### 2.3 界面组件

- `src/widgets/history/components/CommandHistoryWidget.tsx`
  展示历史命令列表与实时监听项
- `src/widgets/terminal/components/TerminalPaneTree.tsx`
  渲染联想浮层
- `src/widgets/terminal/components/TerminalWidget.css`
  定义联想浮层与滚动条样式

## 3. 数据模型

### 3.1 历史命令项

```ts
type CommandHistoryItem = {
  id: string;
  command: string;
  firstUsedAt: number;
  lastUsedAt: number;
  useCount: number;
  source: "typed" | "quickbar" | "history";
};
```

- `typed`：终端回车提交后的命令
- `quickbar`：由快捷命令触发
- `history`：由历史命令面板再次执行

### 3.2 实时监听状态

```ts
type CommandHistoryLiveCapture = {
  state: "listening" | "tracking";
  command: string;
  updatedAt: number;
};
```

- `listening`：当前输入区为空
- `tracking`：当前输入区存在可见内容

## 4. 输入监听与历史记录

终端运行时通过读取 xterm 当前光标所在 buffer 行，识别 prompt 后的输入区内容，并向上层发布实时监听状态。可见输入行是补全的事实来源；键盘输入流只标记文本编辑意图，不直接累加联想文本。

状态切换规则：

1. 输入区为空时为 `listening`
2. 输入区出现可见内容时切换到 `tracking`
3. 输入区清空后回到 `listening`
4. 用户回车提交后，将本轮输入收口为正式历史命令
5. 等待下一次 prompt 后进入下一轮监听

内部交互状态分为 `unknown`、`prompt` 和 `running`。只有已确认处于 `prompt`、且当前行仍匹配已记录 prompt 前缀时才允许生成候选；无法确认时采用关闭补全的安全降级。

tmux 内正常的 shell prompt 仍可使用补全。tmux prefix、pane/window 切换等未回显到 shell 输入行的按键不会进入联想文本。备用 buffer 切换会重置 prompt 身份，但不会永久禁用补全，tmux 自身也可能长期使用备用 buffer。

候选采用“输入驱动、输出校准”模式：只有文本、退格、粘贴等编辑输入会开启一轮联想校准；xterm 完成对应回显后，再读取实际可见输入并生成候选，远端逐字符回显期间会持续校准到输出稳定。普通命令输出、tmux 重绘、鼠标操作和光标移动只更新终端状态，不主动重新生成候选。

记录规则：

- 历史命令在分桶内按命令文本去重
- 再次命中时更新 `lastUsedAt` 并增加 `useCount`
- 单个历史桶最多保留 `300` 条命令
- 当前联想使用全局持久化历史作为数据源

## 5. 联想候选生成

联想层仅依赖 Provider 接口：

```ts
type CommandAutocompleteProvider = {
  getSuggestions: (input: string) => CommandAutocompleteCandidate[];
};
```

当前默认实现为 `createHistoryAutocompleteProvider(items)`，输入来源是全局持久化历史。

候选规则：

- 输入非空时才触发联想
- 与当前输入完全相等的命令不显示
- 单词输入按首词前缀匹配
- 含空格输入按整行连续前缀匹配
- 最低使用次数为 `AUTOCOMPLETE_MIN_USE_COUNT`
- 最多返回 `AUTOCOMPLETE_MAX_CANDIDATES` 条候选

排序因素：

1. 命中质量
2. 使用频次
3. 近期性
4. 长度惩罚

相关常量位于 `src/features/terminal/core/constants.ts`。

## 6. 联想浮层

联想浮层由 `TerminalPaneTree` 渲染，锚点由终端运行时计算。

布局规则：

- 优先显示在当前 prompt 行上方
- 上方空间不足时翻转到下方
- 左侧起点尽量对齐当前光标列
- 保留 pane 内边距，避免超出可视区域
- 最多显示 `AUTOCOMPLETE_VISIBLE_ITEMS` 条可视项，超出后滚动

定位规则：

- 浮层横向位置随当前光标列更新
- xterm 完成输出解析后，使用实际可见光标列计算锚点

交互规则：

- `↑ / ↓`：按 DOM 按键语义切换候选
- 默认不自动选中第一项
- `Enter`：选中候选时写回输入行，不直接执行
- `Esc`、左右方向键、点击浮层外区域、窗口失焦时关闭联想

样式规则：

- 联想浮层使用项目统一的细滚动条视觉
- 滚动条样式定义在 `src/widgets/terminal/components/TerminalWidget.css`

## 7. 浮动历史面板同步

浮动历史面板通过 `BroadcastChannel` 与主窗口同步最小快照。

同步内容包括：

- `activeSessionId`
- `hasActiveSession`
- `liveCapture`
- `items`

主窗口负责广播当前活动会话数据；浮动窗口负责本地搜索过滤，并将执行动作回传主窗口。

## 8. 设计边界

- 提示符识别依赖当前 shell 输出形态与 prompt 前缀稳定性
- 多行复杂命令的监听精度受 xterm 当前显示结果影响
- htop、btop、vim 等程序执行期间依靠命令运行态和可见 prompt 校验暂停补全；备用 buffer 仅作为辅助状态，不能单独用于判断 tmux 内是否处于 TUI
- 当前联想采用规则排序，不包含语义理解
- 运行期会话历史与全局持久化历史为分层存储
