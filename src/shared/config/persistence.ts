/** 可主动提交的防抖持久化与跨窗口落盘屏障。 */
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  getCurrentWebviewWindow,
  getAllWebviewWindows,
} from "@tauri-apps/api/webviewWindow";

import { PersistenceQueue } from "./persistenceQueue";
import { PERSISTENCE_FLUSH_TIMEOUT_MS } from "@/constants/persistence";

const queue = new PersistenceQueue(
  (callback, delay) => window.setTimeout(callback, delay),
  (id) => window.clearTimeout(id),
);
let initialized: Promise<void> | undefined;

/** 跟踪在途配置写入。 */
export function trackPersistenceCommand<T>(promise: Promise<T>): Promise<T> {
  return queue.track(promise);
}

/** 安排可在备份前立即提交的保存。 */
export function schedulePersistence(
  callback: () => void | Promise<void>,
  delay: number,
): number {
  return queue.schedule(callback, delay);
}

/** 取消被新状态取代的保存。 */
export function cancelPersistence(timer: number): void {
  queue.cancel(timer);
}

/** 每个运行窗口注册一次落盘请求处理器。 */
export function initializePersistence(): Promise<void> {
  initialized ??= listen<{ token: string; replyTo: string }>(
    "config-persistence://flush",
    ({ payload }) => {
      void (async () => {
        let ok = true;
        try {
          await queue.flush();
        } catch {
          ok = false;
        }
        await emitTo(payload.replyTo, "config-persistence://flushed", {
          token: payload.token,
          label: getCurrentWebviewWindow().label,
          ok,
        });
      })().catch(() => undefined);
    },
  ).then(() => undefined);
  return initialized;
}

/** 备份前等待所有窗口显式确认；超时或任一保存失败都中止备份。 */
export async function flushAllPersistence(): Promise<void> {
  await initializePersistence();
  const windows = await getAllWebviewWindows();
  const waiting = new Set(windows.map((window) => window.label));
  const token = crypto.randomUUID();
  const replyTo = getCurrentWebviewWindow().label;
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const unlisten = await listen<{ token: string; label: string; ok: boolean }>(
    "config-persistence://flushed",
    ({ payload }) => {
      if (payload.token !== token || !waiting.has(payload.label)) return;
      if (!payload.ok) {
        fail(new Error("Configuration could not be saved"));
        return;
      }
      waiting.delete(payload.label);
      if (!waiting.size) finish();
    },
  );
  const timeout = window.setTimeout(
    () => fail(new Error("Timed out waiting for configuration saves")),
    PERSISTENCE_FLUSH_TIMEOUT_MS,
  );
  try {
    // 先安装完成监听再发送请求，避免快速响应丢失。
    if (!waiting.size) finish();
    await Promise.all([
      Promise.all(
        windows.map((window) =>
          emitTo(window.label, "config-persistence://flush", {
            token,
            replyTo,
          }),
        ),
      ),
      completed,
    ]);
  } finally {
    window.clearTimeout(timeout);
    unlisten();
  }
}
