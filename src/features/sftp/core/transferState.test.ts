import assert from "node:assert/strict";
import test from "node:test";
import type { SftpProgress } from "../../../types.ts";
import {
  getSftpTransferKey,
  selectRunningSftpTransfers,
  syncRunningSftpTransfer,
  type RunningSftpTransfers,
} from "./transferState.ts";

/** 构造传输状态测试使用的最小进度快照。 */
function createProgress(overrides: Partial<SftpProgress> = {}): SftpProgress {
  return {
    sessionId: "session-a",
    transferId: "transfer-a",
    op: "upload",
    kind: "file",
    path: "/tmp/a.txt",
    displayName: "a.txt",
    itemLabel: "1 item",
    transferred: 0,
    total: 100,
    completedItems: 0,
    totalItems: 1,
    status: "running",
    failedItems: 0,
    ...overrides,
  };
}

void test("不同会话的运行任务互不覆盖", () => {
  let state: RunningSftpTransfers = {};
  state = syncRunningSftpTransfer(state, createProgress(), 100);
  state = syncRunningSftpTransfer(
    state,
    createProgress({ sessionId: "session-b" }),
    200,
  );

  assert.equal(Object.keys(state).length, 2);
  assert.equal(
    state[getSftpTransferKey("session-a", "transfer-a")]?.progress.sessionId,
    "session-a",
  );
  assert.equal(
    state[getSftpTransferKey("session-b", "transfer-a")]?.progress.sessionId,
    "session-b",
  );
});

void test("同一会话的不同 transferId 可以并存", () => {
  let state: RunningSftpTransfers = {};
  state = syncRunningSftpTransfer(state, createProgress(), 100);
  state = syncRunningSftpTransfer(
    state,
    createProgress({ transferId: "transfer-b", displayName: "b.txt" }),
    200,
  );

  assert.equal(
    state[getSftpTransferKey("session-a", "transfer-a")]?.progress.displayName,
    "a.txt",
  );
  assert.equal(
    state[getSftpTransferKey("session-a", "transfer-b")]?.progress.displayName,
    "b.txt",
  );
});

void test("进度更新只修改目标任务并保留开始时间", () => {
  let state: RunningSftpTransfers = {};
  state = syncRunningSftpTransfer(state, createProgress(), 100);
  state = syncRunningSftpTransfer(
    state,
    createProgress({ transferred: 50 }),
    300,
  );

  const task = state[getSftpTransferKey("session-a", "transfer-a")];
  assert.equal(task?.startedAt, 100);
  assert.equal(task?.progress.transferred, 50);
});

void test("终态事件只移除对应任务", () => {
  let state: RunningSftpTransfers = {};
  state = syncRunningSftpTransfer(state, createProgress(), 100);
  state = syncRunningSftpTransfer(
    state,
    createProgress({ sessionId: "session-b" }),
    200,
  );
  state = syncRunningSftpTransfer(
    state,
    createProgress({ status: "success", transferred: 100 }),
    300,
  );

  assert.deepEqual(Object.keys(state), [
    getSftpTransferKey("session-b", "transfer-a"),
  ]);
});

void test("活动任务按开始时间倒序排列", () => {
  let state: RunningSftpTransfers = {};
  state = syncRunningSftpTransfer(state, createProgress(), 100);
  state = syncRunningSftpTransfer(
    state,
    createProgress({ sessionId: "session-b", transferId: "transfer-b" }),
    200,
  );

  assert.deepEqual(
    selectRunningSftpTransfers(state).map((item) => item.progress.transferId),
    ["transfer-b", "transfer-a"],
  );
});
