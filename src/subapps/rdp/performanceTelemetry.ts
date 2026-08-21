/**
 * RDP Webview 性能遥测窗口聚合器。
 *
 * 仅复用调用方已有的帧回调和 RAF，不创建定时器或新的采样循环。
 */
import { invokeTauriCommand } from "@/shared/tauri/commands";
import {
  FixedHistogram,
  type HistogramValue,
} from "./performanceTelemetryCore";

export { getRdpResolutionClass } from "./performanceTelemetryCore";

type TelemetryStatus = {
  enabled: boolean;
  intervalMs: number;
  domains: Array<"sftp" | "rdp">;
};

type MetricAttributes = {
  rendererMode: "worker" | "main-thread" | "none";
  visibility: "visible" | "hidden";
  resolutionClass: "hd" | "fullHd" | "quadHd" | "ultraHd";
};

type MetricPoint = {
  name: string;
  kind: "gauge" | "counterDelta" | "histogram";
  unit: string;
  value?: number;
  histogram?: HistogramValue;
  attributes?: Record<string, string>;
};

const FRAME_INTERVAL_BOUNDS = [4, 8, 12, 16.67, 25, 33.33, 50, 100, 250, 1000];

/** 查询发送端状态；失败按禁用处理。 */
export async function getRdpPerformanceTelemetryStatus(): Promise<TelemetryStatus> {
  try {
    return await invokeTauriCommand<TelemetryStatus>(
      "performance_telemetry_status_get",
    );
  } catch {
    return { enabled: false, intervalMs: 1000, domains: [] };
  }
}

/** RDP 单条匿名流的前端聚合状态。 */
export class RdpPerformanceCollector {
  private windowStartedAt = performance.now();
  private windowStartedUnixMs = Date.now();
  private receivedFrames = 0;
  private presentedFrames = 0;
  private droppedFrames = 0;
  private queueDepthMax = 0;
  private lastPresentedAt = 0;
  private dirty = false;
  private pendingFlush: Promise<unknown> = Promise.resolve();
  private readonly frameIntervals = new FixedHistogram(FRAME_INTERVAL_BOUNDS);
  private readonly renderDurations = new FixedHistogram([
    0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 33, 100, 500, 1000,
  ]);

  constructor(
    private readonly streamId: string,
    private intervalMs: number,
  ) {}

  /** 配置异步加载完成后修正后续窗口长度。 */
  setIntervalMs(intervalMs: number) {
    this.intervalMs = Math.max(1, intervalMs);
  }

  /** 记录渲染通道确认呈现的帧。 */
  recordPresented(
    presentedFrames: number,
    queueDepth = 0,
    receivedFrames = presentedFrames,
    droppedFrames = 0,
    renderDurationMs = 0,
  ) {
    const now = performance.now();
    const frames = Math.max(0, Math.floor(presentedFrames));
    this.receivedFrames += Math.max(0, Math.floor(receivedFrames));
    this.presentedFrames += frames;
    this.droppedFrames += Math.max(0, Math.floor(droppedFrames));
    this.queueDepthMax = Math.max(this.queueDepthMax, queueDepth);
    this.dirty = true;
    if (renderDurationMs > 0) {
      this.renderDurations.record(renderDurationMs);
    }
    if (this.lastPresentedAt > 0) {
      this.frameIntervals.record(now - this.lastPresentedAt);
    }
    this.lastPresentedAt = now;
  }

  /** 记录渲染器明确丢弃或合并的帧。 */
  recordDropped(frames: number) {
    this.droppedFrames += Math.max(0, Math.floor(frames));
    this.dirty = true;
  }

  /**
   * 在调用方现有 RAF 中尝试轮换窗口。
   *
   * 未达到配置窗口时只做一次数值比较，不触发 invoke。
   */
  flushIfDue(
    now: number,
    width: number,
    height: number,
    attributes: MetricAttributes,
  ) {
    const elapsed = now - this.windowStartedAt;
    if (elapsed < this.intervalMs) return;
    void this.flush(now, width, height, attributes);
  }

  /** 在后端关闭流之前提交尚未达到完整周期的最后窗口。 */
  flushFinal(width: number, height: number, attributes: MetricAttributes) {
    if (!this.dirty) return this.pendingFlush;
    return this.flush(performance.now(), width, height, attributes);
  }

  private flush(
    now: number,
    width: number,
    height: number,
    attributes: MetricAttributes,
  ) {
    const elapsed = now - this.windowStartedAt;
    const durationMs = Math.max(1, Math.round(elapsed));
    const windowStartedUnixMs = this.windowStartedUnixMs;
    const fps = (this.presentedFrames * 1000) / durationMs;
    const sharedAttributes = { ...attributes };
    const metrics: MetricPoint[] = [
      {
        name: "fluxterm.rdp.renderer.fps",
        kind: "gauge",
        unit: "{frame}/s",
        value: fps,
        attributes: sharedAttributes,
      },
      {
        name: "fluxterm.rdp.renderer.received_frames",
        kind: "counterDelta",
        unit: "{frame}",
        value: this.receivedFrames,
        attributes: sharedAttributes,
      },
      {
        name: "fluxterm.rdp.renderer.presented_frames",
        kind: "counterDelta",
        unit: "{frame}",
        value: this.presentedFrames,
        attributes: sharedAttributes,
      },
      {
        name: "fluxterm.rdp.renderer.dropped_frames",
        kind: "counterDelta",
        unit: "{frame}",
        value: this.droppedFrames,
        attributes: sharedAttributes,
      },
      {
        name: "fluxterm.rdp.renderer.queue_depth.max",
        kind: "gauge",
        unit: "{frame}",
        value: this.queueDepthMax,
        attributes: sharedAttributes,
      },
      {
        name: "fluxterm.rdp.renderer.width",
        kind: "gauge",
        unit: "px",
        value: Math.max(0, width),
        attributes: sharedAttributes,
      },
      {
        name: "fluxterm.rdp.renderer.height",
        kind: "gauge",
        unit: "px",
        value: Math.max(0, height),
        attributes: sharedAttributes,
      },
    ];
    const frameInterval = this.frameIntervals.take();
    if (frameInterval) {
      metrics.push({
        name: "fluxterm.rdp.renderer.frame_interval",
        kind: "histogram",
        unit: "ms",
        histogram: frameInterval,
        attributes: sharedAttributes,
      });
    }
    const renderDuration = this.renderDurations.take();
    if (renderDuration) {
      metrics.push({
        name: "fluxterm.rdp.renderer.render_duration",
        kind: "histogram",
        unit: "ms",
        histogram: renderDuration,
        attributes: sharedAttributes,
      });
    }
    this.pendingFlush = this.pendingFlush
      .then(() =>
        invokeTauriCommand("performance_telemetry_record_rdp_batch", {
          batch: {
            streamId: this.streamId,
            window: {
              startedAtUnixMs: windowStartedUnixMs,
              durationMs,
            },
            metrics,
          },
        }),
      )
      .catch(() => undefined);
    this.windowStartedAt = now;
    this.windowStartedUnixMs = Date.now();
    this.receivedFrames = 0;
    this.presentedFrames = 0;
    this.droppedFrames = 0;
    this.queueDepthMax = 0;
    this.dirty = false;
    return this.pendingFlush;
  }
}
