/**
 * 应用统一错误模型。
 * 职责：将未知异常归一化为可读、可记录、可扩展的标准错误结构。
 */
import { translations, type Translate, type TranslationKey } from "@/i18n";

/** 应用错误来源。 */
export type AppErrorSource = "tauri" | "frontend";

/** 错误翻译变量。 */
export type AppErrorMessageVars = Record<string, string | number>;

/** 应用标准错误结构。 */
export class AppError extends Error {
  code: string;
  messageKey?: string;
  messageVars?: AppErrorMessageVars;
  details?: unknown;
  source: AppErrorSource;

  constructor(input: {
    code: string;
    message: string;
    messageKey?: string;
    messageVars?: AppErrorMessageVars;
    details?: unknown;
    source?: AppErrorSource;
  }) {
    super(input.message);
    this.name = "AppError";
    this.code = input.code;
    this.messageKey = input.messageKey;
    this.messageVars = input.messageVars;
    this.details = input.details;
    this.source = input.source ?? "frontend";
  }
}

/** 从未知异常中提取可读文本，避免出现 `[object Object]`。 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") {
    const parsedMessage = parseJsonStringMessage(error);
    return parsedMessage ?? error;
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }
  if (isRecord(error)) {
    const messageCandidate = pickString(
      error.message,
      error.error,
      error.reason,
      error.kind,
      error.type,
      error.detail,
      error.details,
    );
    if (messageCandidate) return messageCandidate;
    const nestedMessage = pickNestedMessage(error.error);
    if (nestedMessage) return nestedMessage;
    const serialized = safeJsonStringify(error);
    if (serialized) return serialized;
  }
  return String(error);
}

/** 将未知异常归一化为应用标准错误结构。 */
export function normalizeToAppError(
  error: unknown,
  defaults: {
    code: string;
    source: AppErrorSource;
    details?: unknown;
  },
): AppError {
  if (error instanceof AppError) return error;
  const parsedRecord = parseJsonStringRecord(error);
  if (parsedRecord) {
    return normalizeRecordToAppError(parsedRecord, defaults);
  }
  const message = extractErrorMessage(error);
  if (error instanceof Error) {
    return new AppError({
      code: defaults.code,
      message,
      source: defaults.source,
      details: mergeDetails(defaults.details, {
        name: error.name,
        stack: error.stack,
      }),
    });
  }
  if (isRecord(error)) {
    return normalizeRecordToAppError(error, defaults);
  }
  return new AppError({
    code: defaults.code,
    message,
    source: defaults.source,
    details: defaults.details,
  });
}

/** 使用 i18n 优先翻译标准错误码，翻译不到时回退原始消息。 */
export function translateAppError(error: unknown, t: Translate): string {
  const normalized =
    error instanceof AppError
      ? error
      : normalizeToAppError(error, { code: "unknown_error", source: "tauri" });
  const explicitMessageKey = resolveMessageKey(normalized);
  const code = resolveErrorCode(error);
  const key = code ? ERROR_CODE_TRANSLATIONS[code] : null;
  if (explicitMessageKey && !explicitMessageKey.endsWith(".operationFailed")) {
    return t(explicitMessageKey, normalized.messageVars);
  }
  if (key) return t(key);
  if (explicitMessageKey) return t(explicitMessageKey, normalized.messageVars);
  const message = normalized.message;
  const messageKey = findTranslationKey(message);
  if (messageKey) return t(messageKey);
  return message;
}

/** 从后端错误文本中识别前端翻译键。 */
function findTranslationKey(value: string): TranslationKey | null {
  const trimmed = value.trim();
  if (isTranslationKey(trimmed)) return trimmed;
  return TRANSLATION_KEYS.find((key) => trimmed.includes(key)) ?? null;
}

/** 判断文本是否为前端翻译键。 */
function isTranslationKey(value: string): value is TranslationKey {
  return TRANSLATION_KEYS.includes(value as TranslationKey);
}

function pickNestedMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return pickString(value.message, value.error, value.reason);
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRecordToAppError(
  error: Record<string, unknown>,
  defaults: {
    code: string;
    source: AppErrorSource;
    details?: unknown;
  },
) {
  const code = pickString(error.code, error.kind, error.type) ?? defaults.code;
  return new AppError({
    code,
    message: extractErrorMessage(error),
    messageKey: pickString(error.messageKey, error.message_key) ?? undefined,
    messageVars: normalizeMessageVars(error.messageVars ?? error.message_vars),
    source: defaults.source,
    details: mergeDetails(defaults.details, error),
  });
}

function parseJsonStringMessage(value: string): string | null {
  const parsed = parseJsonStringRecord(value);
  if (!parsed) return null;
  return pickString(
    parsed.message,
    parsed.error,
    parsed.reason,
    parsed.detail,
    parsed.details,
  );
}

function parseJsonStringRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function mergeDetails(base: unknown, extra: unknown): unknown {
  if (base === undefined) return extra;
  if (isRecord(base) && isRecord(extra)) {
    return {
      ...base,
      raw: extra,
    };
  }
  return {
    context: base,
    raw: extra,
  };
}

function resolveErrorCode(error: unknown): string | null {
  if (error instanceof AppError) return error.code;
  const parsedRecord = parseJsonStringRecord(error);
  if (parsedRecord) {
    return pickString(parsedRecord.code, parsedRecord.kind, parsedRecord.type);
  }
  if (isRecord(error)) {
    return pickString(error.code, error.kind, error.type);
  }
  return null;
}

function resolveMessageKey(error: AppError): TranslationKey | null {
  if (!error.messageKey) return null;
  return isTranslationKey(error.messageKey) ? error.messageKey : null;
}

function normalizeMessageVars(value: unknown): AppErrorMessageVars | undefined {
  if (!isRecord(value)) return undefined;
  const vars: AppErrorMessageVars = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number") {
      vars[key] = item;
    }
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

const ERROR_CODE_TRANSLATIONS: Partial<Record<string, TranslationKey>> = {
  security_locked: "error.securityLocked",
  security_password_invalid: "error.securityPasswordInvalid",
  security_password_too_short: "error.securityPasswordTooShort",
  security_enable_unavailable: "error.securityEnableUnavailable",
  security_change_unavailable: "error.securityChangeUnavailable",
  security_unlock_unavailable: "error.securityUnlockUnavailable",
  rdp_profile_name_required: "rdp.error.nameRequired",
  rdp_profile_host_required: "rdp.error.hostRequired",
  rdp_profile_username_required: "rdp.error.usernameRequired",
  rdp_profile_required: "messages.missingHostUser",
  rdp_fixed_resolution_required: "rdp.error.fixedResolutionRequired",
  remote_edit_conflict: "sftp.remoteEdit.remoteChanged",
  sftp_stat_failed: "sftp.remoteEdit.remoteMissing",
  remote_edit_not_found: "sftp.remoteEdit.instanceMissing",
  remote_edit_not_pending: "sftp.remoteEdit.notPending",
  remote_edit_snapshot_failed: "sftp.remoteEdit.localReadFailed",
  remote_edit_local_dirty: "sftp.remoteEdit.localDirty",
  remote_edit_workspace_invalid: "sftp.remoteEdit.workspaceInvalid",
  remote_edit_index_failed: "sftp.remoteEdit.workspaceInvalid",
};

const TRANSLATION_KEYS = Object.keys(translations["zh-CN"]) as TranslationKey[];
