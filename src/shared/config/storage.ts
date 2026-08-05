/**
 * 前端配置文档存储桥接。
 * 配置路径解析、目录创建与原子写入统一由 Rust 后端负责。
 */
import { callTauri } from "@/shared/tauri/commands";

/** Rust 后端允许访问的配置文档标识。 */
export type ConfigDocument =
  | "appSettings"
  | "layout"
  | "quickbar"
  | "session"
  | "commandHistory";

/** 读取配置文档；文件不存在时返回 null。 */
export function readConfigDocument(document: ConfigDocument) {
  return callTauri<string | null>("config_read_text", { document });
}

/** 原子写入配置文档。 */
export function writeConfigDocument(document: ConfigDocument, content: string) {
  return callTauri<void>("config_write_text", { document, content });
}
