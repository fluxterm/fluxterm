# RDP 性能优化与 AVC420 对比测试

## 分支与构建

本地分支：`codex/rdp-performance`。基线为创建该分支时的 `main`。优化与基线应使用同一种构建配置，不能把开发构建与发布构建直接比较。

```powershell
pnpm build:fast
```

若已有 Pulse 接收端及遥测配置，各版本均使用 `pnpm build:fast:telemetry`。对比时区分原始基线、首轮滚轮与背压优化、后续 RDPEGFX / AVC420 软件解码三个版本。记录各自构建提交或保存的源码快照，不要只记录相同的分支名。

当前版本支持 RDPEGFX / AVC420 软件解码；服务器未启用图形通道时继续走原有画面路径。不改变连接配置，`compression_type: None` 保持不变；GFX 自身的 ZGFX 封装压缩独立处理。AVC420 为有损 4:2:0 编码，文字和彩色细线画质也要比较；不会主动降低远端分辨率或限制帧率。

## 确认实际使用的编码

发布包可在应用日志中查找 `rdp.runtime.codec.selected`：`codec=avc420`、`decoder=openh264-software` 表示该会话已成功解码首张 AVC420 画面。此事件每条连接最多记录一次，不持续记录帧或性能数据；未出现时不能认定已经使用 H.264。

在 RDP 子应用开发者工具查看最近窗口：

```javascript
window.__fluxtermRdpPerformance?.slice(-5);
```

- `metrics.gfxNegotiated === 1` 仅说明图形通道已协商。
- `metrics.gfxAvc420Negotiated === 1` 仅说明协商允许 AVC420。
- 持续滚动时 `metrics.gfxAvc420FramesTotal` 和 `gfxAvc420BytesTotal` 增长，才证明实际在使用 H.264。服务器可能在同一会话中混用其他图形编码。
- 两个协商字段均为 0 时，不应把结果标为 H.264。服务器是否选用 AVC420 取决于其版本和策略，本客户端不会强制修改远端设置。

新增 `gfx*Total` 字段是每条 RDP 连接的累计值，比较相同会话两个窗口的差分；断开后重新计数。`gfxDecodeUsTotal` 记录 OpenH264 解码耗时，`gfxRgbaConversionUsTotal` 记录 RGBA 分配及 YUV 转换耗时，`gfxDecodedPixelsTotal` 记录完整解码像素，`gfxBitmapUpdatesTotal` 记录解码后区域更新数。它们是墙钟耗时，不是操作系统 CPU 使用率。

本轮使用软件解码，本机 Video Decode 引擎不应成为性能收益的验收指标；重点同时观察本机 CPU、被控端 Video Encode、网络字节及包数、停止滚动后画面是否及时稳定。H.264 仍在后端转换成 RGBA 后传入 WebView，因此本地 RGBA 字节不一定随远端网络字节一起下降。

## 对比条件

- 使用同一被控端、用户、网页、浏览器缩放、远端分辨率和 Windows 显示缩放；按顺序连接，避免两个会话相互影响。
- 固定 TCP、音频、剪贴板和视觉体验选项；网页加载与缓存预热完成后再采样。
- 建连过程单独记录；每个稳定场景连续采样 30 秒，重复三次，比较中位数。需要与原来的 5 秒结果对比时，从稳定运行区间截取相同长度。
- 滚轮映射已修复，原来的相同鼠标动作可能不再产生相同滚动距离。性能对比使用固定距离脚本；鼠标手动滚动用于单独检验输入体验。

## 场景

| 场景 | 操作 | 重点 |
| --- | --- | --- |
| 静止 | 网页无动画、鼠标不动，等待 30 秒 | 不应持续传输重复画面 |
| 固定滚动 | 同一长页面以相同距离滚动 30 秒 | 带宽、流畅度、停止后的追帧时间 |
| 窗口拖动 | 同一远端窗口按固定路线持续拖动 | 输入响应、稀疏更新和多矩形开销 |
| 高分辨率 | 在 2560×1440 或 3840×2160 重复滚动 | 客户端 CPU、内存、纹理提交与带宽 |
| 后台恢复 | 滚动中切换会话标签或最小化，再恢复 | 无无限积压，无缺块和旧画面覆盖 |
| 尺寸与重连 | 动态调整桌面尺寸，随后断开重连 | 完整快照正确，旧尺寸画面不覆盖新画面 |

固定滚动可在**被控端浏览器**开发者工具中执行以下代码。两个客户端使用同一页面与脚本，确认控制台输出的距离一致：

```javascript
const root = document.scrollingElement;
root.scrollTo({ top: 0, behavior: "instant" });
const distance = Math.min(18000, root.scrollHeight - root.clientHeight);
const start = performance.now();
function step(now) {
  const progress = Math.min(1, (now - start) / 30000);
  root.scrollTo({ top: Math.round(distance * progress), behavior: "instant" });
  if (progress < 1) requestAnimationFrame(step);
  else console.log({ distance, actual: root.scrollTop });
}
requestAnimationFrame(step);
```

另行手动检查：慢速滚轮、高速滚轮、反向滚动、水平滚动、触摸板小增量、Ctrl+滚轮，以及滚动后立即点击或按键。输入停止后不应继续追赶旧滚动；切换标签和断开后不应向其他会话发送旧输入。

## 数据口径

- 抓包只过滤被控端 IP 与实际 RDP TCP 端口，排除本地回环 WebSocket。分别记录上下行字节、数据包数、平均包长、纯 ACK、小包占比和重传。
- 同时记录两端 CPU、内存；被控端 GPU 分开观察 3D 与 Video Encode，本机观察 3D 与解码引擎。总 GPU 百分比不作为效率的唯一判断。
- 前端 FPS 表示 WebGL 提交新画面的频率，不是远端编码帧率或显示器实际扫描输出次数。

RDP 子应用开发者工具可读取 `window.__fluxtermRdpPerformance`，最近 120 个采样窗口在所有会话间共用上限。常规构建每秒一个窗口，遥测构建跟随既有采样间隔；数据不写入业务日志，不要求外部接收端支持新指标。运行三次测试前可用 `window.__fluxtermRdpPerformance = []` 清空，然后复制 `JSON.stringify(window.__fluxtermRdpPerformance)` 保存结果。在不提供开发者工具的发布包中，使用已有 Pulse 指标及抓包比较；内存快照可在开发构建中辅助定位，不能将两种构建的绝对性能直接对比。

| 本地诊断字段 | 含义 |
| --- | --- |
| `sessionId`、`recordedAt`、`metrics.durationMs` | 快照会话、前端接收时间与实际采样时长 |
| `receivedPduBytes` | 已读 RDP PDU 的载荷字节，不含 TCP/TLS/ACK 开销 |
| `bridgeBytes`、`sentPixels`、`sentBatches`、`sentRects` | 构造的本地 RGBA 消息字节、像素、批次、矩形数量；多消费者分别计数 |
| `rawPixels`、`rawUpdates` | 解码产生的原始矩形面积之和与更新周期；重叠区域重复计数 |
| `coalescedUpdates` | 每个消费者发送前被累计到同一批次的额外更新次数；不是丢帧 |
| `acknowledgedBatches`、`ackWaitUs` | 已确认批次数与从发送入队到处理消费确认的累计微秒数；两者相除得到平均等待时间 |

已有 Pulse 指标继续提供接收/编码字节、发送像素、解码/复制/打包耗时、纹理上传与提交的 CPU 耗时，以及消费批次和呈现次数。`renderer.dropped_frames` 不再把合并呈现计作远端丢帧；接收数量指本地 RGBA 批次。`bridge_send_cpu` 不再上报，避免把旧广播入队耗时误当作新传输链路耗时。新增诊断字段保存在本地有界内存快照，不扩展外部 Pulse 0.1.0 协议目录。

## 恢复与验收

- 每个桥接连接最多一个未确认图形批次；等待期间只保留最多 256 个脏矩形，极端碎片化时转为下一次完整快照，内存不随等待时间持续增长。
- 完整快照与增量共用同一序列。调整尺寸时，允许旧在途批次完成消费；随后发送新代次完整快照，旧确认不能确认新画面。
- 控制事件溢出会以 WebSocket 1013 显式关闭，客户端 250ms 后重建桥接并接收快照。图形数据无效则关闭为 1002，报告错误。
- 自动验证覆盖滚轮单位、累计、顺序、协议范围、大批次分组、面积限制、慢消费者、新连接、尺寸变化、重复/旧确认与损坏批次；运行 `pnpm rdp:test` 和 `cargo test -p fluxterm-rdp-core --lib --all-features`。
- AVC420 自动验证使用实际 OpenH264 编码数据，覆盖非零原点区域掩码、多表面预测帧隔离、非法区域拒绝、尺寸重置与解码恢复；图形合成器及会话补丁另运行 `cargo test -p ironrdp-egfx -p ironrdp-session --lib`。
- 自动测试没有连接真实远端，也不能证明 GPU 完成了硬件操作；消费确认表示 WebGL 纹理上传调用已成功返回，不使用 `gl.finish()` 强制同步。
- 最终以画面正确、输入完整、积压有界，以及相同工作量下的资源占用和响应改善为准。不预设包数减半或 GPU 占用降低。
