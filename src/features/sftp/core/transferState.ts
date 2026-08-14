/**
 * SFTP 活动传输状态。
 * 职责：按会话与 transferId 的复合身份归集运行任务，并在任务进入终态时移出活动集合。
 */
import type { SftpProgress } from "@/types";

/** 单个运行中传输任务的前端快照。 */
export type RunningSftpTransfer = {
  progress: SftpProgress;
  startedAt: number;
};

/** 按会话与 transferId 复合键索引的运行中传输任务集合。 */
export type RunningSftpTransfers = Record<string, RunningSftpTransfer>;

/** 构造不会受会话间 transferId 重名影响的稳定任务键。 */
export function getSftpTransferKey(sessionId: string, transferId: string) {
  return JSON.stringify([sessionId, transferId]);
}

/**
 * 将最新进度合并到活动任务集合。
 * running 事件负责新增或更新任务，终态事件只移除对应会话中的任务。
 */
export function syncRunningSftpTransfer(
  previous: RunningSftpTransfers,
  progress: SftpProgress,
  now = Date.now(),
): RunningSftpTransfers {
  const transferKey = getSftpTransferKey(
    progress.sessionId,
    progress.transferId,
  );
  if (progress.status !== "running") {
    if (!previous[transferKey]) return previous;
    const next = { ...previous };
    delete next[transferKey];
    return next;
  }

  const current = previous[transferKey];
  return {
    ...previous,
    [transferKey]: {
      progress,
      startedAt: current?.startedAt ?? now,
    },
  };
}

/** 按开始时间倒序返回稳定的活动任务列表。 */
export function selectRunningSftpTransfers(
  transfers: RunningSftpTransfers,
): RunningSftpTransfer[] {
  return Object.values(transfers).sort(
    (left, right) =>
      right.startedAt - left.startedAt ||
      right.progress.sessionId.localeCompare(left.progress.sessionId) ||
      right.progress.transferId.localeCompare(left.progress.transferId),
  );
}
