/** 串口 Widget 浮窗快照与动作协议。 */
import type { SerialPortInfo, SerialProfile } from "@/types";

export const WIDGET_SERIAL_CHANNEL = "fluxterm-serial-sync";

export type FloatingSerialSnapshot = {
  profiles: SerialProfile[];
  groups: string[];
  ports: SerialPortInfo[];
  connectingProfileIds: string[];
  loading: boolean;
};

export type FloatingSerialMessage =
  | { type: "serial:request-snapshot" }
  | { type: "serial:refresh" }
  | { type: "serial:connect"; profile: SerialProfile }
  | { type: "serial:save-profile"; profile: SerialProfile }
  | { type: "serial:remove-profile"; profileId: string }
  | { type: "serial:save-groups"; groups: string[] }
  | { type: "serial:snapshot"; payload: FloatingSerialSnapshot };
