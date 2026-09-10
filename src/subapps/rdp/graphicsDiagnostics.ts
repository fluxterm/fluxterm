import { RDP_DIAGNOSTIC_WINDOW_LIMIT } from "@/constants/rdpPerformance";

/** 协议任务的本地窗口指标，不进入业务日志或外部 Pulse 目录。 */
type GraphicsWindow = {
  sessionId: string;
  recordedAt: number;
  metrics: Record<string, number>;
};

declare global {
  interface Window {
    /** 供 RDP 子应用开发者工具导出的有界诊断快照。 */
    __fluxtermRdpPerformance?: GraphicsWindow[];
  }
}

/** 保存最近的采样窗口，不增加定时器，也不触发 React 更新。 */
export function recordGraphicsWindow(
  sessionId: string,
  metrics: Record<string, number>,
) {
  const windows = (window.__fluxtermRdpPerformance ??= []);
  windows.push({ sessionId, recordedAt: Date.now(), metrics });
  if (windows.length > RDP_DIAGNOSTIC_WINDOW_LIMIT)
    windows.splice(0, windows.length - RDP_DIAGNOSTIC_WINDOW_LIMIT);
}
