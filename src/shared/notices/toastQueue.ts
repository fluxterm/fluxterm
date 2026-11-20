/** 横幅队列项的最小信息，不依赖 React。 */
type QueueItem = { id: string; message: string; durationMs?: number };

/** 新提示不挤掉待确认错误，相同持久提示合并为最新一条。 */
export function appendToast<T extends QueueItem>(
  previous: readonly T[],
  next: T,
  visibleLimit: number,
): T[] {
  const retained = previous.filter(
    (item) =>
      !(
        next.durationMs === 0 &&
        item.durationMs === 0 &&
        item.message === next.message
      ),
  );
  const persistent = retained.filter((item) => item.durationMs === 0);
  const transient = retained.filter((item) => item.durationMs !== 0);
  return [
    next,
    ...persistent,
    ...transient.slice(0, Math.max(0, visibleLimit - 1 - persistent.length)),
  ];
}
