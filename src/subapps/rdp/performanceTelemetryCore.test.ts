import assert from "node:assert/strict";
import test from "node:test";
import {
  FixedHistogram,
  getRdpResolutionClass,
} from "./performanceTelemetryCore.ts";

void test("固定桶忽略非法样本并在取出后清空", () => {
  const histogram = new FixedHistogram([1, 5]);
  histogram.record(Number.NaN);
  histogram.record(Number.POSITIVE_INFINITY);
  histogram.record(-1);
  histogram.record(0.5);
  histogram.record(5);
  histogram.record(9);

  assert.deepEqual(histogram.take(), {
    count: 3,
    sum: 14.5,
    min: 0.5,
    max: 9,
    bounds: [1, 5],
    bucketCounts: [1, 1, 1],
  });
  assert.equal(histogram.take(), null);
});

void test("分辨率只映射到固定低基数分类", () => {
  assert.equal(getRdpResolutionClass(1280, 720), "hd");
  assert.equal(getRdpResolutionClass(1920, 1080), "fullHd");
  assert.equal(getRdpResolutionClass(2560, 1440), "quadHd");
  assert.equal(getRdpResolutionClass(3840, 2160), "ultraHd");
  assert.equal(getRdpResolutionClass(-1, 1080), "hd");
});
