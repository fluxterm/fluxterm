/** 背景资源后端命令。 */
import { invokeTauriCommand } from "@/shared/tauri/commands";

/** 导入用户选择的背景媒体并返回相对资源标识。 */
export function importBackgroundAsset(sourcePath: string) {
  return invokeTauriCommand<string>("background_import", { sourcePath });
}

/** 读取背景媒体字节。 */
export async function readBackgroundAsset(asset: string) {
  const bytes = await invokeTauriCommand<number[]>("background_read", {
    asset,
  });
  return Uint8Array.from(bytes);
}

/** 删除配置目录中的背景媒体。 */
export function deleteBackgroundAsset(asset: string) {
  return invokeTauriCommand<void>("background_delete", { asset });
}
