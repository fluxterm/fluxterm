/** 配置目录管理后端命令。 */
import { callTauri } from "@/shared/tauri/commands";
import type { Locale } from "@/i18n";

/** 配置目录来源。 */
export type ConfigDirectorySource = "environment" | "user" | "default";

/** 当前进程与待重启配置目录状态。 */
export type ConfigDirectoryStatus = {
  activeDir: string;
  source: ConfigDirectorySource;
  ready: boolean;
  error: string | null;
  pendingDir: string | null;
  envOverride: boolean;
  locale: Locale | null;
};

/** 获取配置目录状态。 */
export function getConfigDirectoryStatus() {
  return callTauri<ConfigDirectoryStatus>("config_directory_status");
}

/** 保存用户选择的配置目录位置。 */
export function selectConfigDirectoryParent(parentDir: string) {
  return callTauri<ConfigDirectoryStatus>("config_directory_select_parent", {
    parentDir,
  });
}

/** 下次启动恢复默认配置目录。 */
export function resetConfigDirectory() {
  return callTauri<ConfigDirectoryStatus>("config_directory_reset");
}

/** 保存正常配置不可用时仍需使用的应用语言。 */
export function setBootstrapLocale(locale: Locale) {
  return callTauri<ConfigDirectoryStatus>("bootstrap_locale_set", { locale });
}
