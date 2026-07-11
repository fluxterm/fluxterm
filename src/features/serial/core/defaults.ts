/** 串口默认配置与纯函数工具。 */
import type { SerialPortInfo, SerialProfile } from "@/types";

/** 创建 115200 8N1 的默认快速连接配置。 */
export function createDefaultSerialProfile(
  port?: SerialPortInfo | null,
): SerialProfile {
  return {
    id: "",
    name: port?.product || port?.portName || "",
    portName: port?.portName ?? "",
    baudRate: 115200,
    dataBits: "eight",
    stopBits: "one",
    parity: "none",
    flowControl: "none",
    encoding: "utf8",
    lineEnding: "crlf",
    tags: null,
  };
}

/** 复制串口 Profile，避免表单直接修改列表对象。 */
export function cloneSerialProfile(profile: SerialProfile): SerialProfile {
  return { ...profile, tags: profile.tags ? [...profile.tags] : null };
}
