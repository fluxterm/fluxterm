import assert from "node:assert/strict";
import { test } from "node:test";
import { GraphicsConsumer } from "./graphicsProtocol.ts";

/** 构造与 Rust 发送端一致的批次布局。 */
function batch(generation = 1, sequence = 1, size = 2, partial = false) {
  const rectSize = partial ? 1 : size;
  const bytes = new ArrayBuffer(38 + rectSize * rectSize * 4);
  const view = new DataView(bytes);
  view.setUint8(0, 3);
  view.setUint32(1, generation, true);
  view.setUint32(5, sequence, true);
  view.setUint8(9, 2);
  for (const [offset, value] of [
    [10, size],
    [14, size],
    [18, 1],
    [22, 0],
    [26, 0],
    [30, rectSize],
    [34, rectSize],
  ]) {
    view.setUint32(offset, value, true);
  }
  new Uint8Array(bytes, 38).fill(sequence);
  return bytes;
}

void test("完整快照后应用增量，上传成功才确认；无需 RAF", () => {
  const consumer = new GraphicsConsumer();
  const pixels = new Uint8Array(16);
  const first = consumer.consume(batch(), (_w, _h, rects) => {
    pixels.set(rects[0].pixels);
  });
  assert.deepEqual(JSON.parse(first), {
    type: "graphics-ack",
    generation: 1,
    sequence: 1,
  });
  consumer.consume(batch(1, 2, 2, true), (_w, _h, rects) =>
    pixels.set(rects[0].pixels),
  );
  assert.deepEqual(
    [...pixels],
    [...Array<number>(4).fill(2), ...Array<number>(12).fill(1)],
  );
});

void test("乱序、重复和旧代次批次均不会上传", () => {
  const consumer = new GraphicsConsumer();
  consumer.consume(batch(), () => {});
  const unexpected = () => assert.fail("invalid batch must not upload");
  assert.throws(() => consumer.consume(batch(), unexpected));
  assert.throws(() => consumer.consume(batch(1, 3), unexpected));
  consumer.consume(batch(2, 2, 3), () => {});
  assert.throws(() => consumer.consume(batch(1, 3), unexpected));
});

void test("尺寸变化和新连接必须使用完整快照", () => {
  const consumer = new GraphicsConsumer();
  assert.throws(() => consumer.consume(batch(1, 1, 2, true), () => {}));
  consumer.consume(batch(), () => {});
  assert.throws(() => consumer.consume(batch(1, 2, 3), () => {}));
  assert.throws(() => consumer.consume(batch(2, 2, 3, true), () => {}));
  consumer.consume(batch(2, 2, 3), () => {});
  const reconnected = new GraphicsConsumer();
  reconnected.consume(batch(2, 1, 3), () => {});
});

void test("截断、空矩形与越界批次不会部分应用", () => {
  for (const mutate of [
    (buffer: ArrayBuffer) => buffer.slice(0, -1),
    (buffer: ArrayBuffer) => {
      new DataView(buffer).setUint32(30, 0, true);
      return buffer;
    },
    (buffer: ArrayBuffer) => {
      new DataView(buffer).setUint32(22, 2, true);
      return buffer;
    },
  ]) {
    assert.throws(() =>
      new GraphicsConsumer().consume(mutate(batch()), () =>
        assert.fail("must validate before upload"),
      ),
    );
  }
});

void test("上传失败不推进序号，像素视图不复制缓冲", () => {
  const consumer = new GraphicsConsumer();
  const buffer = batch();
  assert.throws(() =>
    consumer.consume(buffer, () => {
      throw new Error("context lost");
    }),
  );
  consumer.consume(buffer, (_w, _h, rects) =>
    assert.equal(rects[0].pixels.buffer, buffer),
  );
});
