import { invokeTauriCommand } from "@/shared/tauri/commands";

/** OpenSSH config 导入摘要。 */
export type OpensshImportSummary = {
  addedCount: number;
  skippedCount: number;
  conflictCount: number;
  unsupportedCount: number;
  errorCount: number;
};

/** 从默认 OpenSSH config 导入会话。 */
export function importOpenSshConfig() {
  return invokeTauriCommand<OpensshImportSummary>("ssh_import_openssh_config");
}
