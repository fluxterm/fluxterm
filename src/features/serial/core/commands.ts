/** 串口领域 Tauri 命令封装。 */
import type { SerialPortInfo, SerialProfile } from "@/types";
import { callTauri } from "@/shared/tauri/commands";

/** 枚举当前系统串口。 */
export function listSerialPorts() {
  return callTauri<SerialPortInfo[]>("serial_port_list");
}

/** 读取串口 Profile。 */
export function listSerialProfiles() {
  return callTauri<SerialProfile[]>("serial_profile_list");
}

/** 读取串口 Profile 分组。 */
export function listSerialProfileGroups() {
  return callTauri<string[]>("serial_profile_groups_list");
}

/** 覆盖保存串口 Profile 分组。 */
export function saveSerialProfileGroups(groups: string[]) {
  return callTauri<string[]>("serial_profile_groups_save", { groups });
}

/** 保存串口 Profile。 */
export function saveSerialProfile(profile: SerialProfile) {
  return callTauri<SerialProfile>("serial_profile_save", { profile });
}

/** 删除串口 Profile。 */
export function removeSerialProfile(profileId: string) {
  return callTauri<boolean>("serial_profile_remove", { profileId });
}
