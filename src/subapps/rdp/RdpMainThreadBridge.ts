/**
 * @file RdpMainThreadBridge.ts
 * @description RDP 主线程渲染桥接，用于 WebKitGTK 等不支持 Worker WebGL 的环境。
 */

import { RdpWebGLRenderer } from "./WebGLRenderer";

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

type MainThreadSessionRuntime = {
  sessionId: string;
  ws: WebSocket | null;
  bridgeUrl: string | null;
  texture: WebGLTexture | null;
  textureSize: { width: number; height: number };
  pendingFrames: ArrayBuffer[];
  frameRequest: number | null;
  frameVersion: number;
  needsPresent: boolean;
};

export type RdpMainThreadBridgeState = {
  sessionId: string;
  state: "open" | "closed" | "error";
  details?: Record<string, unknown>;
};

export type RdpMainThreadBridgeCallbacks = {
  onBridgeState: (event: RdpMainThreadBridgeState) => void;
  onWireEvent: (sessionId: string, payload: RdpWireEvent) => void;
  onFramePresented: (
    sessionId: string,
    frameVersion: number,
    performance: {
      presentedFrames: number;
      receivedFrames: number;
      droppedFrames: number;
      queueDepthMax: number;
      renderDurationMs: number;
      surfaceWidth: number;
      surfaceHeight: number;
    },
  ) => void;
  onDiagnostic: (
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields?: Record<string, unknown>,
    sessionId?: string,
  ) => void;
};

/** 将未知异常收敛为可序列化日志字段。 */
function getErrorFields(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  return { message: String(error) };
}

/** 提取 bridge URL 的非敏感字段，避免日志输出 token。 */
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

/** 管理主线程 WebSocket、RDP 帧解析和 WebGL 呈现。 */
export class RdpMainThreadBridge {
  private renderer: RdpWebGLRenderer;
  private sessions = new Map<string, MainThreadSessionRuntime>();
  private activeSessionId: string | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private callbacks: RdpMainThreadBridgeCallbacks,
  ) {
    this.renderer = new RdpWebGLRenderer(canvas);
  }

  /** 切换当前活动会话，并在已有纹理时立即恢复最后一帧。 */
  public setActiveSession(sessionId: string | null) {
    this.activeSessionId = sessionId;
    if (!sessionId) {
      this.renderer.clear();
      return;
    }

    const session = this.ensureSession(sessionId);
    if (
      session.texture &&
      session.textureSize.width > 0 &&
      session.textureSize.height > 0
    ) {
      this.renderer.commit(
        session.texture,
        session.textureSize.width,
        session.textureSize.height,
      );
      this.notifyFramePresented(session, {
        presentedFrames: 1,
        receivedFrames: 0,
        droppedFrames: 0,
        queueDepthMax: 0,
        renderDurationMs: 0,
      });
    } else {
      this.renderer.clear();
    }
    this.requestRender(sessionId);
  }

  /** 为指定会话建立本地 bridge WebSocket。 */
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
      const details = {
        readyState: ws.readyState,
        ...getSafeUrlFields(url),
      };
      this.callbacks.onBridgeState({ sessionId, state: "open", details });
    };
    ws.onmessage = (event) => {
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession || currentSession.ws !== ws) {
        return;
      }
      if (typeof event.data === "string") {
        try {
          const payload = JSON.parse(event.data) as RdpWireEvent;
          this.callbacks.onWireEvent(sessionId, payload);
        } catch (error) {
          this.callbacks.onDiagnostic(
            "warn",
            "rdp.mainThreadBridge.websocket.message.invalid",
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
      this.callbacks.onBridgeState({ sessionId, state: "closed", details });
    };
    ws.onerror = () => {
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession || currentSession.ws !== ws) {
        return;
      }
      const details = {
        readyState: ws.readyState,
        ...getSafeUrlFields(url),
      };
      this.callbacks.onDiagnostic(
        "warn",
        "rdp.mainThreadBridge.websocket.error",
        details,
        sessionId,
      );
      this.callbacks.onBridgeState({ sessionId, state: "error", details });
    };
    session.ws = ws;
  }

  /** 主动断开单个会话并释放该会话纹理。 */
  public disconnect(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.frameRequest !== null) {
        window.cancelAnimationFrame(session.frameRequest);
        session.frameRequest = null;
      }
      session.ws?.close();
      session.ws = null;
      session.bridgeUrl = null;
      session.pendingFrames = [];
      session.needsPresent = false;
      if (session.texture) {
        this.renderer.deleteTexture(session.texture);
        session.texture = null;
      }
      this.sessions.delete(sessionId);
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this.renderer.clear();
    }
  }

  /** 关闭所有连接并释放主线程桥接状态。 */
  public terminate() {
    for (const sessionId of [...this.sessions.keys()]) {
      this.disconnect(sessionId);
    }
    this.renderer.clear();
  }

  /** 读取或创建单个会话的主线程渲染状态。 */
  private ensureSession(sessionId: string): MainThreadSessionRuntime {
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
        needsPresent: false,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** 将后端推送的二进制帧加入待渲染队列。 */
  private queueFrame(sessionId: string, buffer: ArrayBuffer) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingFrames.push(buffer);
    session.needsPresent = true;
    this.requestRender(sessionId);
  }

  /** 请求下一帧渲染并批量消费积压帧。 */
  private requestRender(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.frameRequest !== null) return;

    session.frameRequest = window.requestAnimationFrame(() => {
      session.frameRequest = null;
      const renderStartedAt = performance.now();
      const queue = session.pendingFrames.splice(0);
      for (const buffer of queue) {
        this.drawFrame(session, buffer);
      }

      if (
        this.activeSessionId === sessionId &&
        session.needsPresent &&
        session.texture
      ) {
        this.renderer.commit(
          session.texture,
          session.textureSize.width,
          session.textureSize.height,
        );
        session.needsPresent = false;
        this.notifyFramePresented(session, {
          presentedFrames: 1,
          receivedFrames: queue.length,
          droppedFrames: Math.max(0, queue.length - 1),
          queueDepthMax: queue.length,
          renderDurationMs: performance.now() - renderStartedAt,
        });
      }
    });
  }

  /** 通知主组件当前会话已经提交了新的画面版本。 */
  private notifyFramePresented(
    session: MainThreadSessionRuntime,
    performance: {
      presentedFrames: number;
      receivedFrames: number;
      droppedFrames: number;
      queueDepthMax: number;
      renderDurationMs: number;
    },
  ) {
    session.frameVersion += 1;
    this.callbacks.onFramePresented(session.sessionId, session.frameVersion, {
      ...performance,
      surfaceWidth: session.textureSize.width,
      surfaceHeight: session.textureSize.height,
    });
  }

  /** 解析 RDP bridge 二进制帧并上传到 WebGL 纹理。 */
  private drawFrame(session: MainThreadSessionRuntime, buffer: ArrayBuffer) {
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

      this.ensureTexture(session, surfaceWidth, surfaceHeight);
      if (!session.texture) return;
      this.renderer.uploadRect(
        session.texture,
        x,
        y,
        rectWidth,
        rectHeight,
        pixels,
      );
      return;
    }

    if (messageType !== 2 || view.byteLength < 13) {
      return;
    }

    const surfaceWidth = view.getUint32(1, true);
    const surfaceHeight = view.getUint32(5, true);
    const rectCount = view.getUint32(9, true);

    this.ensureTexture(session, surfaceWidth, surfaceHeight);
    if (!session.texture) return;

    let offset = 13;
    for (let index = 0; index < rectCount; index += 1) {
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

  /** 确保会话纹理尺寸与远端画布尺寸一致。 */
  private ensureTexture(
    session: MainThreadSessionRuntime,
    surfaceWidth: number,
    surfaceHeight: number,
  ) {
    if (
      session.texture &&
      session.textureSize.width === surfaceWidth &&
      session.textureSize.height === surfaceHeight
    ) {
      return;
    }
    if (session.texture) {
      this.renderer.deleteTexture(session.texture);
    }
    session.texture = this.renderer.createTexture(surfaceWidth, surfaceHeight);
    session.textureSize = { width: surfaceWidth, height: surfaceHeight };
  }
}
