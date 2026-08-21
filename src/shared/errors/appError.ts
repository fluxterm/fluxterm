/**
 * 应用统一错误模型。
 * 职责：将后端错误载荷和未知异常归一化为可展示、可记录的应用错误。
 */
import {
  translations,
  type Translate,
  type TranslationKey,
} from "../../i18n/index.ts";

/** 应用错误来源。 */
export type AppErrorSource = "tauri" | "frontend";

/** 错误翻译变量。 */
export type AppErrorMessageVars = Record<string, string | number>;

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MESSAGE_KEY_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;

/** Rust 跨 Tauri 边界发送的标准错误载荷。 */
export type BackendErrorPayload = {
  code: string;
  message: string;
  messageKey?: string;
  messageVars?: AppErrorMessageVars;
  details?: string;
};

/** 应用标准错误结构。 */
export class AppError extends Error {
  code: string;
  messageKey?: string;
  messageVars?: AppErrorMessageVars;
  details?: string;
  diagnostic?: unknown;
  source: AppErrorSource;

  constructor(
    input: BackendErrorPayload & {
      diagnostic?: unknown;
      source?: AppErrorSource;
    },
  ) {
    super(input.message);
    this.name = "AppError";
    this.code = ERROR_CODE_PATTERN.test(input.code)
      ? input.code
      : "unknown_error";
    this.messageKey =
      input.messageKey && MESSAGE_KEY_PATTERN.test(input.messageKey)
        ? input.messageKey
        : undefined;
    this.messageVars = input.messageVars;
    this.details = input.details;
    this.diagnostic = input.diagnostic;
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
      error.details,
      error.detail,
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
    diagnostic?: unknown;
  },
): AppError {
  if (error instanceof AppError) return error;
  const parsedRecord = parseJsonStringRecord(error);
  if (parsedRecord) return normalizeRecordToAppError(parsedRecord, defaults);

  if (error instanceof Error) {
    return new AppError({
      code: defaults.code,
      message: error.message,
      source: defaults.source,
      diagnostic: mergeDiagnostic(defaults.diagnostic, {
        name: error.name,
        stack: error.stack,
      }),
    });
  }
  if (isRecord(error)) return normalizeRecordToAppError(error, defaults);
  return new AppError({
    code: defaults.code,
    message: extractErrorMessage(error),
    source: defaults.source,
    diagnostic: defaults.diagnostic,
  });
}

/** 优先按标准翻译键展示错误，无有效翻译键时回退英文消息。 */
export function translateAppError(error: unknown, t: Translate): string {
  const normalized =
    error instanceof AppError
      ? error
      : normalizeToAppError(error, { code: "unknown_error", source: "tauri" });
  const messageKey = resolveMessageKey(normalized);
  return messageKey
    ? t(messageKey, normalized.messageVars)
    : normalized.message;
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
    if (typeof value === "string" && value.trim()) return value.trim();
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
    diagnostic?: unknown;
  },
) {
  const payload = normalizeBackendErrorPayload(error);
  if (payload) {
    return new AppError({
      ...payload,
      source: defaults.source,
      diagnostic: mergeDiagnostic(defaults.diagnostic, error),
    });
  }
  const candidateCode = pickString(error.code, error.kind, error.type);
  return new AppError({
    code:
      candidateCode && ERROR_CODE_PATTERN.test(candidateCode)
        ? candidateCode
        : defaults.code,
    message: extractErrorMessage(error),
    source: defaults.source,
    diagnostic: mergeDiagnostic(defaults.diagnostic, error),
  });
}

/** 校验并归一化标准后端错误载荷。 */
function normalizeBackendErrorPayload(
  value: Record<string, unknown>,
): BackendErrorPayload | null {
  const code = pickString(value.code);
  const message = pickString(value.message);
  if (!code || !message || !ERROR_CODE_PATTERN.test(code)) return null;
  const rawMessageKey = pickString(value.messageKey);
  const messageKey =
    rawMessageKey && MESSAGE_KEY_PATTERN.test(rawMessageKey)
      ? rawMessageKey
      : undefined;
  const messageVars = normalizeMessageVars(value.messageVars);
  const details = pickString(value.details) ?? undefined;
  return {
    code,
    message,
    ...(messageKey ? { messageKey } : {}),
    ...(messageVars ? { messageVars } : {}),
    ...(details ? { details } : {}),
  };
}

function parseJsonStringMessage(value: string): string | null {
  const parsed = parseJsonStringRecord(value);
  if (!parsed) return null;
  return pickString(
    parsed.message,
    parsed.error,
    parsed.reason,
    parsed.details,
    parsed.detail,
  );
}

function parseJsonStringRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeDiagnostic(base: unknown, raw: unknown): unknown {
  if (base === undefined) return raw;
  return { context: base, raw };
}

function resolveMessageKey(error: AppError): TranslationKey | null {
  if (!error.messageKey) return null;
  return isTranslationKey(error.messageKey) ? error.messageKey : null;
}

function normalizeMessageVars(value: unknown): AppErrorMessageVars | undefined {
  if (!isRecord(value)) return undefined;
  const vars: AppErrorMessageVars = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" && typeof item !== "number") return undefined;
    vars[key] = item;
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

const TRANSLATION_KEYS = Object.keys(translations["zh-CN"]) as TranslationKey[];
