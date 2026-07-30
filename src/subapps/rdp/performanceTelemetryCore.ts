/** 固定桶直方图的序列化值。 */
export type HistogramValue = {
  count: number;
  sum: number;
  min: number;
  max: number;
  bounds: number[];
  bucketCounts: number[];
};

/** 只保留固定桶计数和摘要，不保存逐帧样本。 */
export class FixedHistogram {
  private readonly bounds: readonly number[];
  private readonly bucketCounts: number[];
  private count = 0;
  private sum = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;

  constructor(bounds: readonly number[]) {
    this.bounds = bounds;
    this.bucketCounts = Array.from({ length: bounds.length + 1 }, () => 0);
  }

  /** 记录有限且非负的耗时样本。 */
  record(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    const found = this.bounds.findIndex((bound) => value <= bound);
    const index = found === -1 ? this.bounds.length : found;
    this.bucketCounts[index] += 1;
    this.count += 1;
    this.sum += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
  }

  /** 取出当前窗口并原地清空累加状态。 */
  take(): HistogramValue | null {
    if (this.count === 0) return null;
    const value: HistogramValue = {
      count: this.count,
      sum: this.sum,
      min: this.min,
      max: this.max,
      bounds: [...this.bounds],
      bucketCounts: [...this.bucketCounts],
    };
    this.bucketCounts.fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
    return value;
  }
}

/** 将实际分辨率收敛为稳定、低基数的图表维度。 */
export function getRdpResolutionClass(width: number, height: number) {
  const pixels = Math.max(0, width) * Math.max(0, height);
  if (pixels <= 1280 * 720) return "hd";
  if (pixels <= 1920 * 1080) return "fullHd";
  if (pixels <= 2560 * 1440) return "quadHd";
  return "ultraHd";
}
