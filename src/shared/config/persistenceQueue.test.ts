import assert from "node:assert/strict";
import test from "node:test";
import { PersistenceQueue } from "./persistenceQueue.ts";

/** 用可控时钟验证备份屏障，不依赖浏览器或 Tauri。 */
function fixture() {
  let next = 0;
  const timers = new Map<number, () => void>();
  const queue = new PersistenceQueue(
    (callback) => {
      timers.set(++next, callback);
      return next;
    },
    (id) => {
      timers.delete(id);
    },
  );
  return { queue, timers };
}

void test("备份立即提交尚未到期的保存并取消被取代状态", async () => {
  const { queue, timers } = fixture();
  const values: string[] = [];
  const old = queue.schedule(() => {
    values.push("old");
  }, 500);
  queue.cancel(old);
  queue.schedule(() => {
    values.push("new");
  }, 500);
  await queue.flush();
  assert.deepEqual(values, ["new"]);
  assert.equal(timers.size, 0);
});

void test("保存失败阻止备份，后续提交会重试同一待保存状态", async () => {
  const { queue } = fixture();
  let attempts = 0;
  queue.schedule(() => {
    if (++attempts === 1) throw new Error("disk full");
  }, 500);
  await assert.rejects(queue.flush(), /disk full/);
  await queue.flush();
  assert.equal(attempts, 2);
});

void test("屏障等待在途写入并向调用方传播失败", async () => {
  const { queue } = fixture();
  let reject: (error: Error) => void = () => undefined;
  const write = new Promise<void>((_, fail) => {
    reject = fail;
  });
  void queue.track(write).catch(() => undefined);
  const barrier = queue.flush();
  reject(new Error("write failed"));
  await assert.rejects(barrier, /write failed/);
});

void test("已经取消的旧保存失败后不会重新覆盖新状态", async () => {
  const { queue, timers } = fixture();
  let reject: (error: Error) => void = () => undefined;
  let oldAttempts = 0;
  const old = queue.schedule(() => {
    oldAttempts += 1;
    return new Promise<void>((_, fail) => {
      reject = fail;
    });
  }, 500);
  timers.get(old)?.();
  await Promise.resolve();
  queue.cancel(old);
  reject(new Error("old write failed"));
  await new Promise((resolve) => setImmediate(resolve));
  let saved = false;
  queue.schedule(() => {
    saved = true;
  }, 500);
  await queue.flush();
  assert.equal(oldAttempts, 1);
  assert.equal(saved, true);
});
