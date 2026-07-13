# 终端性能测试手册

本文档定义 FluxTerm 的终端极限压测、内存观察与可重复性能基准流程，用于故障复现和跨版本回归对比。

## 1. 目标与原则

- 快速极限压测用于暴露高频输出下的卡死、截断、交互失效和异常内存增长。
- 限速基准用于稳定比较不同版本的渲染性能与交互延迟，不与极限压测结果混用。
- 跨版本比较应使用同一台机器、窗口尺寸、Profile、终端配置和录制时长。
- 正式基准每个版本至少执行 3 次，并以中位数写入 JSON。

## 2. WSL/Linux 快速极限压测

以下命令默认持续 30 秒并由 `timeout` 强制结束，也可以使用 `Ctrl+C` 提前中断。建议按固定文本、变化文本、ANSI 256 色的顺序逐项执行，不要同时运行多个压测命令。

### 2.1 固定文本输出

用于验证纯文本吞吐、输出队列和基础渲染稳定性。

```bash
timeout --signal=KILL 30s yes "FluxTerm stress test: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ"
```

### 2.2 变化文本输出

用于验证持续变化内容的解析、滚动回溯和渲染稳定性。

```bash
timeout --signal=KILL 30s awk 'BEGIN { for (i=0;;i++) printf "FluxTerm stress test line=%d value=%08x\n", i, i }'
```

### 2.3 ANSI 256 色输出

用于验证 ANSI 控制序列解析、颜色切换和渲染器缓存压力。

```bash
timeout --signal=KILL 30s awk 'BEGIN { for (i=0;;i++) printf "\033[38;5;%dmFluxTerm ANSI stress line=%d\033[0m\n", i%256, i }'
```

### 2.4 观察与记录

每条命令至少记录以下现象：

- 输出期间窗口、标签切换和键盘输入是否保持响应。
- `Ctrl+C` 是否能及时中断命令。
- 30 秒后命令是否自动结束并恢复 Shell 提示符。
- 输出是否出现截断、乱序、异常空行或 ANSI 状态残留。
- 命令结束后是否仍长时间处理历史积压。

快速极限压测只用于复现故障和验证稳定性，不用于计算不同版本间的 FPS 或延迟变化率。

## 3. 内存测试流程

### 3.1 采样时点

在同一次测试中依次记录：

1. 应用启动稳定后的基线。
2. 压力命令执行期间的峰值。
3. 命令结束且提示符恢复后的占用。
4. 关闭被测试终端标签后的占用。
5. 关闭 DevTools 后的最终 WebView2 占用。

输入 `exit` 或断开 SSH 只会改变连接状态；只要终端标签仍然存在，xterm、滚动回溯和相关运行时仍可能继续占用内存。只有关闭标签并完成终端销毁后，才能判断是否存在残留引用。

Windows 任务管理器可能将 FluxTerm 的 WebView2 browser、renderer、GPU 和 DevTools renderer 汇总展示。记录数据时应注明观察的是单个进程还是进程组，打开 DevTools 后的进程组总量不能作为最终空闲基线。

### 3.2 调试构建的 JS 堆采样

在调试构建中打开 DevTools Console，执行：

```js
const terminalMemory = () => ({
  usedJSHeapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
  totalJSHeapMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
  xterms: document.querySelectorAll(".xterm").length,
  canvases: document.querySelectorAll("canvas").length,
});

console.log("before", terminalMemory());
gc();
setTimeout(() => console.log("after", terminalMemory()), 3000);
```

判读原则：

- `usedJSHeapMB` 在 GC 后明显下降，说明存在可回收但尚未被 V8 主动回收的对象。
- 关闭测试标签后 `xterms` 应减少，对应 JS 堆应接近测试前基线。
- JS 堆已恢复但 WebView2 工作集仍较高，通常表示 V8/WebView2 保留堆或原生分配器高水位，不能仅凭任务管理器数值判定泄漏。
- GC 后仍有大量存活堆时，应使用 DevTools Memory Heap Snapshot 检查强引用链。

手动调用 `gc()` 只用于诊断调试构建中的可回收对象与存活引用，不能作为产品内存治理或性能修复方案。正式测试结束后应关闭 DevTools，再记录最终进程占用。

## 4. 可重复限速基准

脚本路径：`scripts/terminal-bench.ps1`

常用命令：

```powershell
# 中负载（30s）
powershell -ExecutionPolicy Bypass -File .\scripts\terminal-bench.ps1 -Profile medium -DurationSeconds 30

# 高负载（45s）
powershell -ExecutionPolicy Bypass -File .\scripts\terminal-bench.ps1 -Profile high -DurationSeconds 45

# 极限负载（60s）
powershell -ExecutionPolicy Bypass -File .\scripts\terminal-bench.ps1 -Profile extreme -DurationSeconds 60
```

可选参数：

- `-LinesPerSecond`：覆盖 Profile 默认行速率。
- `-LineLength`：覆盖 Profile 默认单行长度。
- `-Seed`：固定随机内容，保证复现性。
- `-Tag`：写入日志前缀，便于录制时定位。

## 5. DevTools 性能采样流程

1. 启动同一构建版本的 FluxTerm。
2. 将窗口固定为同一尺寸，建议 `1440x900`。
3. 打开 DevTools Performance 面板并开始录制。
4. 在终端执行同一条限速基准命令，例如 `high 45s`。
5. 压测结束后停止录制。
6. 记录 `fpsMedian`、`longTaskTotalMs`、`inputLatencyP95Ms` 和 `mainThreadBusyPct`。
7. 同一版本重复 3 次，并记录中位数。

## 6. 结果文件格式

每个版本保存一个 JSON，建议目录：`bench-results/`。

示例：

```json
{
  "version": "0.1.0-alpha.2",
  "date": "2026-02-27",
  "profile": "high-45s",
  "notes": "webgl + gutter raf/incremental",
  "metrics": {
    "fpsMedian": 57.2,
    "longTaskTotalMs": 412.0,
    "inputLatencyP95Ms": 34.0,
    "mainThreadBusyPct": 71.5
  }
}
```

### 6.1 从模板创建版本结果

先复制模板，再填写本次版本数据：

```powershell
Copy-Item .\bench-results\template.json .\bench-results\0.1.0-alpha.2.json
```

建议修改以下字段：

- `version`
- `date`
- `profile`
- `notes`
- `environment.renderer`（`canvas` 或 `webgl`）
- `metrics` 下四个指标

## 7. 版本对比

脚本路径：`scripts/compare-bench.ps1`

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\compare-bench.ps1 `
  -Baseline .\bench-results\0.1.0-alpha.1.json `
  -Current .\bench-results\0.1.0-alpha.2.json `
  -RegressionThresholdPct 10
```

输出包含：

- 一行 JSON 摘要：是否存在回归、阈值与版本信息。
- 表格：各指标的基线值、当前值、变化率与回归标记。

说明：

- `fpsMedian` 越高越好。
- `longTaskTotalMs`、`inputLatencyP95Ms`、`mainThreadBusyPct` 越低越好。
- 默认回归阈值为 `10%`。
