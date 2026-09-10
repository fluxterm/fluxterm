import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeWheel,
  WheelInputBatcher,
  OrderedInputSender,
} from "./wheelInput.ts";

void test("浏览器单位转换为协议单位", () => {
  assert.equal(normalizeWheel(100, 0, 1000), 120);
  assert.equal(normalizeWheel(3, 1, 1000), 120);
  assert.equal(normalizeWheel(1, 2, 1000), 1200);
  assert.equal(normalizeWheel(NaN, 0, 1000), 0);
});

void test("连续增量、小数余量与水平轴均完整保留", () => {
  const sent: { deltaX?: number; deltaY?: number }[] = [];
  const batch = new WheelInputBatcher((input) => sent.push(input));
  for (let i = 0; i < 4; i++) {
    batch.push({ kind: "wheel", deltaX: 0.25, deltaY: 100.25 });
    batch.flush();
  }
  assert.equal(
    sent.reduce((sum, event) => sum + (event.deltaX ?? 0), 0),
    1,
  );
  assert.equal(
    sent.reduce((sum, event) => sum + (event.deltaY ?? 0), 0),
    401,
  );
  batch.reset();
});

void test("方向、位置和修饰键边界先发送旧输入", () => {
  const sent: number[] = [];
  const batch = new WheelInputBatcher((input) => sent.push(input.deltaY ?? 0));
  batch.push({ kind: "wheel", deltaY: 120, x: 1 });
  batch.push({ kind: "wheel", deltaY: -120, x: 1 });
  batch.push({ kind: "wheel", deltaY: -120, x: 2 });
  batch.push({ kind: "wheel", deltaY: -120, x: 2, ctrlKey: true });
  batch.flush();
  assert.deepEqual(sent, [120, -120, -120, -120]);
  batch.reset();
});

void test("8ms 窗口不因后续输入延期，销毁取消输入", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: number[] = [];
  const batch = new WheelInputBatcher((input) => sent.push(input.deltaY ?? 0));
  batch.push({ kind: "wheel", deltaY: 120 });
  context.mock.timers.tick(7);
  batch.push({ kind: "wheel", deltaY: 120 });
  context.mock.timers.tick(1);
  assert.deepEqual(sent, [240]);
  batch.push({ kind: "wheel", deltaY: 120 });
  batch.reset();
  context.mock.timers.tick(8);
  assert.deepEqual(sent, [240]);
});

void test("异步 IPC 保持会话内顺序，不阻塞其他会话", async () => {
  const sent: string[] = [];
  let complete: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const sender = new OrderedInputSender((session, input) => {
    sent.push(`${session}:${input.kind}`);
    return input.kind === "wheel" ? blocked : Promise.resolve();
  });
  const first = sender.send("a", { kind: "wheel" });
  const second = sender.send("a", { kind: "key_down" });
  await sender.send("b", { kind: "mouse_down" });
  assert.deepEqual(sent, ["a:wheel", "b:mouse_down"]);
  complete();
  await Promise.all([first, second]);
  assert.deepEqual(sent, ["a:wheel", "b:mouse_down", "a:key_down"]);
});

void test("断开后不把排队输入重放到同 ID 的新连接", async () => {
  const sent: string[] = [];
  let complete: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const sender = new OrderedInputSender((_session, input) => {
    sent.push(input.kind);
    return input.kind === "wheel" ? blocked : Promise.resolve();
  });
  const first = sender.send("a", { kind: "wheel" });
  const stale = sender.send("a", { kind: "key_down" });
  sender.cancel("a");
  await sender.send("a", { kind: "mouse_down" });
  complete();
  await Promise.all([first, stale]);
  assert.deepEqual(sent, ["wheel", "mouse_down"]);
});
