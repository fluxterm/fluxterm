/**
 * 应用数据目录路径桥接。
 * 配置目录及其文件路径由 Rust 后端独占管理，本模块不再向前端暴露。
 */
import { callTauri } from "@/shared/tauri/commands";

let appDataDirPromise: Promise<string> | null = null;

/** 获取应用数据目录。 */
export async function getAppDataDir() {
  if (!appDataDirPromise) {
    appDataDirPromise = callTauri<string>("app_data_dir");
  }
  return appDataDirPromise;
}
