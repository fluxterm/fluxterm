/**
 * 终端事件监听模块。
 * 职责：统一注册 terminal:output 事件并向外转发。
 */
import { subscribeTauri } from "@/shared/tauri/events";

type TerminalOutputPayload = {
  sessionId: string;
  data: string;
};

/** 串口原始字节输出事件。 */
export type SerialOutputPayload = {
  sessionId: string;
  data: number[];
  receivedAt: number;
};

/**
 * 注册终端输出事件监听，并返回卸载函数。
 */
export async function registerTerminalOutputListener(
  onOutput: (payload: TerminalOutputPayload) => void,
) {
  return subscribeTauri<TerminalOutputPayload>("terminal:output", (event) => {
    onOutput(event.payload);
  });
}

/** 注册串口原始输出监听，并返回卸载函数。 */
export async function registerSerialOutputListener(
  onOutput: (payload: SerialOutputPayload) => void,
) {
  return subscribeTauri<SerialOutputPayload>("serial:output", (event) => {
    onOutput(event.payload);
  });
}
