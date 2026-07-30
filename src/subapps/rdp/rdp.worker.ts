/**
 * @file rdp.worker.ts
 * @description RDP 离屏渲染 Worker。
 * 将 WebSocket 接收、协议解析和 WebGL 渲染完全移出主线程。
 */

import { RdpWebGLRenderer } from "./WebGLRenderer";

const FRAME_PRESENTED_NOTIFY_INTERVAL_MS = 250;

type WorkerSessionRuntime = {
  sessionId: string;
  ws: WebSocket | null;
  /** 当前会话最近一次成功发起桥接连接时使用的 URL，用于幂等判定。 */
  bridgeUrl: string | null;
  texture: WebGLTexture | null;
  textureSize: { width: number; height: number };
  pendingFrames: ArrayBuffer[];
  frameRequest: number | null;
  frameVersion: number;
  pendingPresentedFrames: number;
  pendingReceivedFrames: number;
  pendingDroppedFrames: number;
  pendingRenderDurationMs: number;
  queueDepthMax: number;
  lastFramePresentedNotifyAt: number;
  needsPresent: boolean;
};

type RdpWireEvent =
  | {
      type: "state";
      state: string;
      message?: string;
      width?: number;
      height?: number;
    }
  | { type: "cursor"; cursor: string }
  | { type: "clipboard"; direction: string; text: string }
  | { type: "input-ack"; kind: string }
  | { type: "error"; code: string; message: string };

type WorkerMessage =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "set-active"; sessionId: string | null }
  | { type: "connect"; sessionId: string; url: string }
  | { type: "disconnect"; sessionId: string };

type MainMessage =
  | {
      type: "bridge-state";
      sessionId: string;
      state: "open" | "closed" | "error";
      details?: Record<string, unknown>;
    }
  | { type: "wire-event"; sessionId: string; payload: RdpWireEvent }
  | {
      type: "frame-presented";
      sessionId: string;
      frameVersion: number;
      presentedFrames: number;
      receivedFrames: number;
      droppedFrames: number;
      queueDepthMax: number;
      renderDurationMs: number;
      surfaceWidth: number;
      surfaceHeight: number;
    }
  | {
      type: "diagnostic";
      level: "debug" | "info" | "warn" | "error";
      event: string;
      sessionId?: string;
      fields?: Record<string, unknown>;
    };

function getErrorFields(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  return { message: String(error) };
}

function getSafeUrlFields(url: string) {
  try {
    const parsed = new URL(url);
    return {
      wsUrlProtocol: parsed.protocol,
      wsUrlHost: parsed.host,
      wsUrlPathname: parsed.pathname,
      hasToken: parsed.searchParams.has("token"),
    };
  } catch (error) {
    return {
      wsUrlInvalid: true,
      error: getErrorFields(error),
    };
  }
}

function postDiagnostic(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>,
  sessionId?: string,
) {
  self.postMessage({
    type: "diagnostic",
    level,
    event,
    sessionId,
    fields,
  } satisfies MainMessage);
}

class RdpWorkerContext {
  private renderer: RdpWebGLRenderer | null = null;
  private sessions = new Map<string, WorkerSessionRuntime>();
  private activeSessionId: string | null = null;

  constructor(canvas: OffscreenCanvas) {
    // 强制类型转换为 HTMLCanvasElement 兼容现有 WebGLRenderer 代码
    // 在 WebGL 上下文层面，OffscreenCanvas 和 HTMLCanvasElement 的接口是一致的
    this.renderer = new RdpWebGLRenderer(
      canvas as unknown as HTMLCanvasElement,
    );
  }

  public setActiveSession(sessionId: string | null) {
    this.activeSessionId = sessionId;
    if (!sessionId) {
      // 当前没有活动会话时立即清屏，避免主线程切到空态后仍看到上一帧。
      this.renderer?.clear();
      return;
    }

    const session = this.ensureSession(sessionId);
    if (
      session.texture &&
      session.textureSize.width > 0 &&
      session.textureSize.height > 0
    ) {
      this.renderer?.commit(
        session.texture,
        session.textureSize.width,
        session.textureSize.height,
      );
      this.notifyFramePresented(session);
    } else {
      this.renderer?.clear();
    }
    this.requestRender(sessionId);
  }

  /** 为指定会话建立桥接连接；若已连到同一地址则直接复用，避免重复附着旧桥接。 */
  public connect(sessionId: string, url: string) {
    const session = this.ensureSession(sessionId);
    if (
      session.ws &&
      session.bridgeUrl === url &&
      (session.ws.readyState === WebSocket.CONNECTING ||
        session.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    if (session.ws) {
      session.ws.close();
      session.ws = null;
    }

    const ws = new WebSocket(url);
    session.bridgeUrl = url;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession || currentSession.ws !== ws) {
        ws.close();
        return;
      }
      self.postMessage({
        type: "bridge-state",
        sessionId,
        state: "open",
        details: {
          readyState: ws.readyState,
          ...getSafeUrlFields(url),
        },
      } satisfies MainMessage);
    };
    ws.onmessage = (event) => {
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession || currentSession.ws !== ws) {
        return;
      }
      if (typeof event.data === "string") {
        try {
          const payload = JSON.parse(event.data) as RdpWireEvent;
          self.postMessage({
            type: "wire-event",
            sessionId,
            payload,
          } satisfies MainMessage);
        } catch (error) {
          postDiagnostic(
            "warn",
            "rdp.worker.websocket.message.invalid",
            {
              dataLength: event.data.length,
              error: getErrorFields(error),
            },
            sessionId,
          );
        }
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.queueFrame(sessionId, event.data);
      }
    };
    ws.onclose = (event) => {
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession || currentSession.ws !== ws) {
        return;
      }
      currentSession.ws = null;
      const details = {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        readyState: ws.readyState,
        ...getSafeUrlFields(url),
      };
      self.postMessage({
        type: "bridge-state",
        sessionId,
        state: "closed",
        details,
      } satisfies MainMessage);
    };
    ws.onerror = () => {
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession || currentSession.ws !== ws) {
        return;
      }
      self.postMessage({
        type: "bridge-state",
        sessionId,
        state: "error",
        details: {
          readyState: ws.readyState,
          ...getSafeUrlFields(url),
        },
      } satisfies MainMessage);
      postDiagnostic(
        "warn",
        "rdp.worker.websocket.error",
        {
          readyState: ws.readyState,
          ...getSafeUrlFields(url),
        },
        sessionId,
      );
    };
    session.ws = ws;
  }

  /** 主动断开会话桥接并回收与该会话关联的渲染状态。 */
  public disconnect(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.frameRequest !== null) {
        self.cancelAnimationFrame(session.frameRequest);
        session.frameRequest = null;
      }
      session.ws?.close();
      session.ws = null;
      session.bridgeUrl = null;
      session.pendingFrames = [];
      session.needsPresent = false;
      if (session.texture) {
        this.renderer?.deleteTexture(session.texture);
        session.texture = null;
      }
      this.sessions.delete(sessionId);
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      // 主动断开当前活动会话时同步清屏，避免最后一帧残留在画布上。
      this.renderer?.clear();
    }
  }

  /** 读取或创建会话运行时容器，集中管理该会话的桥接和渲染状态。 */
  private ensureSession(sessionId: string): WorkerSessionRuntime {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        ws: null,
        bridgeUrl: null,
        texture: null,
        textureSize: { width: 0, height: 0 },
        pendingFrames: [],
        frameRequest: null,
        frameVersion: 0,
        pendingPresentedFrames: 0,
        pendingReceivedFrames: 0,
        pendingDroppedFrames: 0,
        pendingRenderDurationMs: 0,
        queueDepthMax: 0,
        lastFramePresentedNotifyAt: 0,
        needsPresent: false,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private queueFrame(sessionId: string, buffer: ArrayBuffer) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingFrames.push(buffer);
    session.pendingReceivedFrames += 1;
    session.queueDepthMax = Math.max(
      session.queueDepthMax,
      session.pendingFrames.length,
    );
    session.needsPresent = true;
    this.requestRender(sessionId);
  }

  private requestRender(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.frameRequest !== null) return;

    session.frameRequest = self.requestAnimationFrame(() => {
      session.frameRequest = null;
      const renderStartedAt = performance.now();
      // 一个动画帧内批量消费积压脏矩形，减少主线程切换和重复 commit。
      const queue = session.pendingFrames.splice(0);
      for (const buffer of queue) {
        this.drawFrame(session, buffer);
      }

      if (
        this.activeSessionId === sessionId &&
        session.needsPresent &&
        session.texture &&
        this.renderer
      ) {
        this.renderer.commit(
          session.texture,
          session.textureSize.width,
          session.textureSize.height,
        );
        session.pendingDroppedFrames += Math.max(0, queue.length - 1);
        session.pendingRenderDurationMs += performance.now() - renderStartedAt;
        session.needsPresent = false;
        this.notifyFramePresented(session);
      }
    });
  }

  /**
   * 每次真正提交当前活动会话画面后递增版本号，交给主线程估算可见呈现 FPS。
   * 注意这里只能说明“渲染链路提交了新画面”，不能直接代表宿主合成和显示器最终上屏次数。
   */
  private notifyFramePresented(session: WorkerSessionRuntime) {
    session.frameVersion += 1;
    session.pendingPresentedFrames += 1;
    const now = performance.now();
    if (
      now - session.lastFramePresentedNotifyAt <
      FRAME_PRESENTED_NOTIFY_INTERVAL_MS
    ) {
      return;
    }

    const presentedFrames = session.pendingPresentedFrames;
    const receivedFrames = session.pendingReceivedFrames;
    const droppedFrames = session.pendingDroppedFrames;
    const queueDepthMax = session.queueDepthMax;
    const renderDurationMs = session.pendingRenderDurationMs;
    session.pendingPresentedFrames = 0;
    session.pendingReceivedFrames = 0;
    session.pendingDroppedFrames = 0;
    session.queueDepthMax = 0;
    session.pendingRenderDurationMs = 0;
    session.lastFramePresentedNotifyAt = now;
    self.postMessage({
      type: "frame-presented",
      sessionId: session.sessionId,
      frameVersion: session.frameVersion,
      presentedFrames,
      receivedFrames,
      droppedFrames,
      queueDepthMax,
      renderDurationMs,
      surfaceWidth: session.textureSize.width,
      surfaceHeight: session.textureSize.height,
    } satisfies MainMessage);
  }

  private drawFrame(session: WorkerSessionRuntime, buffer: ArrayBuffer) {
    if (!this.renderer) return;
    const view = new DataView(buffer);
    const messageType = view.getUint8(0);

    if (messageType === 1) {
      if (view.byteLength < 25) return;
      const x = view.getUint32(1, true);
      const y = view.getUint32(5, true);
      const rectWidth = view.getUint32(9, true);
      const rectHeight = view.getUint32(13, true);
      const surfaceWidth = view.getUint32(17, true);
      const surfaceHeight = view.getUint32(21, true);
      const pixels = new Uint8Array(buffer, 25);

      if (
        !session.texture ||
        session.textureSize.width !== surfaceWidth ||
        session.textureSize.height !== surfaceHeight
      ) {
        if (session.texture) this.renderer.deleteTexture(session.texture);
        session.texture = this.renderer.createTexture(
          surfaceWidth,
          surfaceHeight,
        );
        session.textureSize = { width: surfaceWidth, height: surfaceHeight };
      }

      this.renderer.uploadRect(
        session.texture,
        x,
        y,
        rectWidth,
        rectHeight,
        pixels,
      );
    } else if (messageType === 2 && view.byteLength >= 13) {
      const surfaceWidth = view.getUint32(1, true);
      const surfaceHeight = view.getUint32(5, true);
      const rectCount = view.getUint32(9, true);

      if (
        !session.texture ||
        session.textureSize.width !== surfaceWidth ||
        session.textureSize.height !== surfaceHeight
      ) {
        if (session.texture) this.renderer.deleteTexture(session.texture);
        session.texture = this.renderer.createTexture(
          surfaceWidth,
          surfaceHeight,
        );
        session.textureSize = { width: surfaceWidth, height: surfaceHeight };
      }

      let offset = 13;
      for (let i = 0; i < rectCount; i++) {
        if (offset + 16 > view.byteLength) break;
        const x = view.getUint32(offset, true);
        const y = view.getUint32(offset + 4, true);
        const rectWidth = view.getUint32(offset + 8, true);
        const rectHeight = view.getUint32(offset + 12, true);
        offset += 16;
        const pixelBytes = rectWidth * rectHeight * 4;
        if (offset + pixelBytes > view.byteLength) break;
        const pixels = new Uint8Array(buffer, offset, pixelBytes);
        this.renderer.uploadRect(
          session.texture,
          x,
          y,
          rectWidth,
          rectHeight,
          pixels,
        );
        offset += pixelBytes;
      }
    }
  }
}

let context: RdpWorkerContext | null = null;

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const data = event.data;

  switch (data.type) {
    case "init":
      try {
        context = new RdpWorkerContext(data.canvas);
        postDiagnostic("info", "rdp.worker.init.success", {
          canvasWidth: data.canvas.width,
          canvasHeight: data.canvas.height,
        });
      } catch (error) {
        postDiagnostic("error", "rdp.worker.init.failed", {
          error: getErrorFields(error),
        });
        throw error;
      }
      break;
    case "set-active":
      context?.setActiveSession(data.sessionId);
      break;
    case "connect":
      context?.connect(data.sessionId, data.url);
      break;
    case "disconnect":
      context?.disconnect(data.sessionId);
      break;
  }
};
