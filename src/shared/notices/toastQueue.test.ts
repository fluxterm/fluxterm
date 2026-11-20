import assert from "node:assert/strict";
import test from "node:test";
import { appendToast } from "./toastQueue.ts";

void test("备份失败横幅不会被后续成功提示挤掉", () => {
  const failure = {
    id: "error",
    message: "Credentials do not match",
    durationMs: 0,
  };
  let queue = [failure];
  for (let i = 0; i < 8; i += 1) {
    queue = appendToast(
      queue,
      { id: String(i), message: "Saved", durationMs: 2600 },
      4,
    );
  }
  assert.equal(queue.length, 4);
  assert.equal(queue.includes(failure), true);
});

void test("相同错误只保留最新横幅，不覆盖其他待确认错误", () => {
  const first = { id: "first", message: "Wrong key", durationMs: 0 };
  const other = { id: "other", message: "Invalid nonce", durationMs: 0 };
  const replacement = { ...first, id: "latest" };
  const previous = [first, other];
  assert.deepEqual(appendToast(previous, replacement, 4), [replacement, other]);
  assert.deepEqual(previous, [first, other]);
});

void test("多个待确认错误不会因展示上限被静默移除", () => {
  let queue: Array<{ id: string; message: string; durationMs: number }> = [];
  for (let i = 0; i < 6; i += 1)
    queue = appendToast(
      queue,
      { id: String(i), message: `Error ${i}`, durationMs: 0 },
      4,
    );
  assert.equal(queue.length, 6);
});
