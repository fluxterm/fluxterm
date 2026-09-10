/** 已验证的 RGBA 脏矩形视图，像素直接引用 WebSocket 缓冲。 */
export type GraphicsRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
};

/** 按连接验证代次与序号，在所有矩形上传成功后才返回消费确认。 */
export class GraphicsConsumer {
  private generation = 0;
  private sequence = 0;
  private width = 0;
  private height = 0;

  /** 验证整个批次，避免畸形批次被部分应用后确认。 */
  consume(
    buffer: ArrayBuffer,
    upload: (width: number, height: number, rects: GraphicsRect[]) => void,
  ) {
    const view = new DataView(buffer);
    if (view.byteLength < 22 || view.getUint8(0) !== 3) {
      throw new Error("Invalid RDP graphics envelope");
    }
    const generation = view.getUint32(1, true);
    const sequence = view.getUint32(5, true);
    if (
      generation < this.generation ||
      !generation ||
      sequence !== this.sequence + 1
    ) {
      throw new Error("Out-of-order RDP graphics batch");
    }
    const kind = view.getUint8(9);
    let width: number;
    let height: number;
    const rects: GraphicsRect[] = [];
    let offset: number;
    /** 创建矩形视图前检查边界和完整像素长度。 */
    const addRect = (
      x: number,
      y: number,
      w: number,
      h: number,
      start: number,
    ) => {
      const size = w * h * 4;
      if (
        !w ||
        !h ||
        x + w > width ||
        y + h > height ||
        start + size > buffer.byteLength
      ) {
        throw new Error("Invalid RDP graphics rectangle");
      }
      rects.push({
        x,
        y,
        width: w,
        height: h,
        pixels: new Uint8Array(buffer, start, size),
      });
      return start + size;
    };
    if (kind === 1 && view.byteLength >= 34) {
      width = view.getUint32(26, true);
      height = view.getUint32(30, true);
      offset = addRect(
        view.getUint32(10, true),
        view.getUint32(14, true),
        view.getUint32(18, true),
        view.getUint32(22, true),
        34,
      );
    } else if (kind === 2) {
      width = view.getUint32(10, true);
      height = view.getUint32(14, true);
      const count = view.getUint32(18, true);
      offset = 22;
      for (let i = 0; i < count; i++) {
        if (offset + 16 > view.byteLength)
          throw new Error("Truncated RDP graphics batch");
        offset = addRect(
          view.getUint32(offset, true),
          view.getUint32(offset + 4, true),
          view.getUint32(offset + 8, true),
          view.getUint32(offset + 12, true),
          offset + 16,
        );
      }
    } else {
      throw new Error("Unsupported RDP graphics batch");
    }
    if (
      !width ||
      !height ||
      width > 65535 ||
      height > 65535 ||
      !rects.length ||
      offset !== buffer.byteLength
    ) {
      throw new Error("Invalid RDP graphics surface");
    }
    if (
      generation !== this.generation &&
      !(
        rects.length === 1 &&
        rects[0].x === 0 &&
        rects[0].y === 0 &&
        rects[0].width === width &&
        rects[0].height === height
      )
    ) {
      throw new Error("RDP graphics generation requires full snapshot");
    }
    if (
      generation === this.generation &&
      (width !== this.width || height !== this.height)
    ) {
      throw new Error("RDP graphics resize requires a new generation");
    }
    upload(width, height, rects);
    this.generation = generation;
    this.sequence = sequence;
    this.width = width;
    this.height = height;
    return JSON.stringify({ type: "graphics-ack", generation, sequence });
  }
}
