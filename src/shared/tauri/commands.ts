/**
 * Tauri 命令调用基础设施。
 * 职责：统一封装 invoke 调用入口。
 */
import {
  initializePersistence,
  trackPersistenceCommand,
} from "@/shared/config/persistence";
import { invoke } from "@tauri-apps/api/core";
import { normalizeToAppError } from "@/shared/errors/appError";

/** 系统信息结构。 */
export type SystemInfo = {
  osName: string;
  osVersion: string;
  kernelVersion: string;
  arch: string;
};

/** 统一的 Tauri 命令调用入口。 */
export async function invokeTauriCommand<T>(
  command: string,
  payload?: Record<string, unknown>,
) {
  try {
    await initializePersistence();
    const request = invoke<T>(command, payload ?? {});
    const isConfigurationWrite =
      /^(config_write_text|profile_(save|remove|groups_save)|credential_(save|delete)|serial_profile_(save|remove|groups_save)|ai_settings_save|security_(change_password|enable_strong_protection|enable_weak_protection)|background_(import|delete)|ssh_import_openssh_config)$/.test(
        command,
      );
    return await (isConfigurationWrite
      ? trackPersistenceCommand(request)
      : request);
  } catch (error) {
    throw normalizeToAppError(error, {
      code: "tauri_invoke_error",
      source: "tauri",
      diagnostic: {
        command,
        payloadKeys: Object.keys(payload ?? {}),
      },
    });
  }
}

/** 读取后端系统信息。 */
export function getSystemInfo() {
  return invokeTauriCommand<SystemInfo>("get_system_info");
}
