/** 配置备份领域的 Tauri 命令与跨窗口保存协调。 */
import { invokeTauriCommand } from "@/shared/tauri/commands";
import { flushAllPersistence } from "@/shared/config/persistence";
import { AppError } from "@/shared/errors/appError";

const cancelledTasks = new Set<string>();

/** 在前端落盘屏障后检查取消，防止取消请求先于后端任务创建。 */
function checkCancelled(taskId: string) {
  if (cancelledTasks.delete(taskId))
    throw new AppError({
      code: "backup_cancelled",
      message: "The operation was cancelled",
      messageKey: "backup.error.cancelled",
    });
}

export type BackupSettings = {
  url: string;
  username: string;
  hasPassword: boolean;
  pendingRestore: boolean;
  restoreNotice: string | null;
};

export type WebdavInput = {
  url: string;
  username: string;
  password?: string;
  useSavedPassword: boolean;
};

export type Inspection = {
  token: string;
  manifest: {
    formatVersion: number;
    appVersion: string;
    createdAt: string;
    protection: string;
    files: Array<{ path: string; size: number; sha256: string }>;
  };
};

/** 获取安装本地的备份设置。 */
export function getBackupSettings() {
  return invokeTauriCommand<BackupSettings>("backup_settings_get");
}

/** 保存 WebDAV 设置；未提供密码时保留现有密文。 */
export function saveBackupSettings(
  input: Omit<WebdavInput, "useSavedPassword"> & {
    forgetPassword: boolean;
    clear?: boolean;
  },
) {
  return invokeTauriCommand<BackupSettings>("backup_settings_save", { input });
}

/** 清空整个 WebDAV 配置，包括已保存的密码。 */
export function clearBackupSettings() {
  return saveBackupSettings({
    url: "",
    username: "",
    forgetPassword: true,
    clear: true,
  });
}

/** 备份前显式提交所有窗口的待保存配置。 */
export async function exportLocalBackup(taskId: string, path: string) {
  await flushAllPersistence();
  checkCancelled(taskId);
  return invokeTauriCommand<void>("backup_export_local", { taskId, path });
}

/** WebDAV 仅作为新备份文件的上传目的地。 */
export async function uploadWebdavBackup(taskId: string, input: WebdavInput) {
  await flushAllPersistence();
  checkCancelled(taskId);
  return invokeTauriCommand<string>("backup_upload_webdav", { taskId, input });
}

/** 只读检查 WebDAV 连接与现存目录。 */
export function testWebdav(taskId: string, input: WebdavInput) {
  return invokeTauriCommand<void>("backup_test_webdav", { taskId, input });
}

/** 检查本地 ZIP，获取后端拥有的恢复标识。 */
export function inspectBackup(taskId: string, path: string) {
  return invokeTauriCommand<Inspection>("backup_inspect_local", {
    taskId,
    path,
  });
}

/** 暂存已确认恢复内容，下次启动时应用。 */
export async function stageRestore(taskId: string, token: string) {
  await flushAllPersistence();
  checkCancelled(taskId);
  return invokeTauriCommand<void>("backup_stage_restore", { taskId, token });
}

/** 请求取消当前备份或检查任务。 */
export function cancelBackup(taskId: string) {
  if (cancelledTasks.size >= 64) cancelledTasks.clear();
  cancelledTasks.add(taskId);
  return invokeTauriCommand<void>("backup_cancel", { taskId });
}
