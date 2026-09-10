import type { RdpInputEvent } from "../../../types";
import {
  RDP_WHEEL_BATCH_MS,
  RDP_WHEEL_UNITS_PER_LINE,
  RDP_WHEEL_UNITS_PER_PIXEL,
} from "../../../constants/rdpPerformance.ts";

/** 将浏览器滚轮增量转换为 RDP 单位，方向保持浏览器约定。 */
export function normalizeWheel(delta: number, mode: number, height: number) {
  if (!Number.isFinite(delta)) return 0;
  return (
    delta *
    (mode === 1
      ? RDP_WHEEL_UNITS_PER_LINE
      : RDP_WHEEL_UNITS_PER_PIXEL * (mode === 2 ? height : 1))
  );
}

/** 为单个会话合并滚轮输入，并保留不足一个协议单位的余量。 */
export class WheelInputBatcher {
  private pending: RdpInputEvent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remainderX = 0;
  private remainderY = 0;
  private context: RdpInputEvent | null = null;
  private send: (input: RdpInputEvent) => void;

  constructor(send: (input: RdpInputEvent) => void) {
    this.send = send;
  }

  /** 不跨坐标、方向或修饰键边界聚合。 */
  push(input: RdpInputEvent) {
    if (this.context && !sameContext(this.context, input)) {
      this.flush();
    }
    this.context = input;
    this.pending = {
      ...input,
      deltaX: (this.pending?.deltaX ?? 0) + (input.deltaX ?? 0),
      deltaY: (this.pending?.deltaY ?? 0) + (input.deltaY ?? 0),
    };
    this.timer ??= setTimeout(() => this.flush(), RDP_WHEEL_BATCH_MS);
  }

  /** 在其他输入之前同步发出累计的完整单位。 */
  flush() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    const x = this.remainderX + (this.pending.deltaX ?? 0);
    const y = this.remainderY + (this.pending.deltaY ?? 0);
    const deltaX = Math.trunc(x);
    const deltaY = Math.trunc(y);
    this.remainderX = x - deltaX;
    this.remainderY = y - deltaY;
    const input = this.pending;
    this.pending = null;
    if (deltaX || deltaY) this.send({ ...input, deltaX, deltaY });
  }

  /** 在会话切换、失焦和销毁时取消尚未发送的输入。 */
  reset() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.context = null;
    this.remainderX = this.remainderY = 0;
  }
}

/** 判断两次滚轮事件是否属于同一输入语义区间。 */
function sameContext(a: RdpInputEvent, b: RdpInputEvent) {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.ctrlKey === b.ctrlKey &&
    a.shiftKey === b.shiftKey &&
    a.altKey === b.altKey &&
    a.metaKey === b.metaKey &&
    Math.sign(a.deltaX ?? 0) === Math.sign(b.deltaX ?? 0) &&
    Math.sign(a.deltaY ?? 0) === Math.sign(b.deltaY ?? 0)
  );
}

/** 同会话等待前一次 IPC 完成再发送，防止异步命令执行越过输入边界。 */
export class OrderedInputSender {
  private pending = new Map<string, { tail: Promise<void>; live: boolean }>();
  private deliver: (sessionId: string, input: RdpInputEvent) => Promise<void>;

  constructor(
    deliver: (sessionId: string, input: RdpInputEvent) => Promise<void>,
  ) {
    this.deliver = deliver;
  }

  /** 空闲时立即发送，不为键盘和按键增加聚合延迟。 */
  send(sessionId: string, input: RdpInputEvent) {
    const previous = this.pending.get(sessionId);
    const record = previous ?? { tail: Promise.resolve(), live: true };
    const next = previous
      ? previous.tail
          .catch(() => {})
          .then(() =>
            record.live ? this.deliver(sessionId, input) : undefined,
          )
      : this.deliver(sessionId, input);
    record.tail = next;
    this.pending.set(sessionId, record);
    void next
      .finally(() => {
        if (this.pending.get(sessionId) === record && record.tail === next)
          this.pending.delete(sessionId);
      })
      .catch(() => {});
    return next;
  }

  /** 断开时取消尚未开始的 IPC；已交给后端的调用不重放到重连会话。 */
  cancel(sessionId?: string) {
    for (const [id, record] of this.pending) {
      if (sessionId === undefined || id === sessionId) {
        record.live = false;
        this.pending.delete(id);
      }
    }
  }
}
