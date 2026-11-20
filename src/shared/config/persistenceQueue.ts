/** 可提交的防抖保存队列，与窗口通信和 Tauri 无关。 */
type Save = () => void | Promise<void>;
type Entry = { id: number; callback: Save; running?: Promise<void> };

/** 保留失败保存以供重试，并等待所有已发出的配置写入。 */
export class PersistenceQueue {
  private readonly pending = new Map<number, Entry>();
  private readonly entries = new Map<number, Entry>();
  private readonly running = new Set<Promise<unknown>>();
  private failureSequence = 0;
  private lastFailure: unknown;
  private flushing?: Promise<void>;
  private readonly setTimer: (callback: () => void, delay: number) => number;
  private readonly clearTimer: (id: number) => void;

  constructor(
    setTimer: (callback: () => void, delay: number) => number,
    clearTimer: (id: number) => void,
  ) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  /** 跟踪命令错误，但不保留长期运行的非配置请求。 */
  track<T>(promise: Promise<T>): Promise<T> {
    this.running.add(promise);
    void promise.then(
      () => this.running.delete(promise),
      (error: unknown) => {
        this.running.delete(promise);
        this.failureSequence += 1;
        this.lastFailure = error;
      },
    );
    return promise;
  }

  /** 保存任务既可在定时器到期时执行，也可由备份主动提交。 */
  schedule(callback: Save, delay: number): number {
    const id = this.setTimer(() => {
      const entry = this.entries.get(id);
      if (entry) void this.execute(entry).catch(() => undefined);
    }, delay);
    const entry = { id, callback };
    this.pending.set(id, entry);
    this.entries.set(id, entry);
    return id;
  }

  /** 取消旧状态；已经执行的旧保存失败后也不得重新排入队列。 */
  cancel(id: number): void {
    this.clearTimer(id);
    this.pending.delete(id);
    this.entries.delete(id);
  }

  /** 同时收到多个提交请求时复用同一次落盘屏障。 */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** 执行时保留任务身份，失败且未被新状态取消时允许再次提交。 */
  private execute(entry: Entry): Promise<void> {
    if (entry.running) return entry.running;
    this.clearTimer(entry.id);
    this.pending.delete(entry.id);
    const operation = Promise.resolve()
      .then(entry.callback)
      .then(
        () => {
          this.entries.delete(entry.id);
        },
        (error: unknown) => {
          if (this.entries.get(entry.id) === entry)
            this.pending.set(entry.id, entry);
          throw error;
        },
      )
      .finally(() => {
        entry.running = undefined;
      });
    entry.running = operation;
    return this.track(operation);
  }

  /** 直到队列与在途写入均为空；失败立即返回，保留可重试内容。 */
  private async drain(): Promise<void> {
    const sequence = this.failureSequence;
    while (this.pending.size || this.running.size) {
      const entries = [...this.pending.values()];
      const writes = [...this.running];
      const results = await Promise.allSettled([
        ...entries.map((entry) => this.execute(entry)),
        ...writes,
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      if (this.failureSequence !== sequence) throw this.lastFailure;
    }
  }
}
