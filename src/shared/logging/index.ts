import {
  debug as pluginDebug,
  error as pluginError,
  info as pluginInfo,
  warn as pluginWarn,
} from "@tauri-apps/plugin-log";
import {
  createOperationId,
  encodeLogRecord,
  type LogFields,
  type StructuredLogError,
} from "./record";

export {
  createOperationId,
  type LogFields,
  type StructuredLogError as LogError,
};

type PluginLogger = (message: string) => Promise<void>;

/** 写入 DEBUG 结构化日志。 */
export function logDebug(
  event: string,
  fields?: LogFields,
  operationId?: string,
): void {
  writeLog(pluginDebug, event, fields, operationId);
}

/** 写入 INFO 结构化日志。 */
export function logInfo(
  event: string,
  fields?: LogFields,
  operationId?: string,
): void {
  writeLog(pluginInfo, event, fields, operationId);
}

/** 写入 WARN 结构化日志。 */
export function logWarn(
  event: string,
  fields?: LogFields,
  operationId?: string,
): void {
  writeLog(pluginWarn, event, fields, operationId);
}

/** 写入 ERROR 结构化日志。 */
export function logError(
  event: string,
  fields?: LogFields,
  operationId?: string,
): void {
  writeLog(pluginError, event, fields, operationId);
}

function writeLog(
  sink: PluginLogger,
  event: string,
  fields?: LogFields,
  operationId?: string,
): void {
  try {
    const line = encodeLogRecord(event, fields, operationId);
    void sink(line).catch(() => {});
  } catch {
    // 日志失败不得影响业务，也不能通过自身递归记录。
  }
}
