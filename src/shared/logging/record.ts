/** 结构化日志记录编码与安全清洗。 */

export const MAX_LOG_RECORD_BYTES = 4 * 1024;
export const MAX_LOG_STRING_BYTES = 512;
export const MAX_LOG_ERROR_DETAIL_BYTES = 1024;

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_FIELDS = 64;
const EVENT_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)*$/u;
const CORE_FIELDS = new Set([
  "event",
  "message",
  "component",
  "operationId",
  "truncated",
]);

export type LogFields = Record<string, unknown>;

export type StructuredLogError = {
  code: string;
  message: string;
  detail?: string;
};

export type StructuredLogRecord = {
  event: string;
  message: string;
  component: "webview";
  operationId?: string;
  error?: StructuredLogError;
  truncated?: true;
} & LogFields;

/** 创建跨层操作关联 ID。 */
export function createOperationId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 构造已清洗且满足大小限制的日志记录。 */
export function buildLogRecord(
  event: string,
  fields: LogFields = {},
  operationId?: string,
): StructuredLogRecord {
  if (!EVENT_PATTERN.test(event)) {
    return {
      event: "logging.record.invalid",
      message: "Structured log record is invalid",
      component: "webview",
      error: {
        code: "logging_invalid_event",
        message: "Structured log record was rejected",
      },
    };
  }

  const record: StructuredLogRecord = {
    event,
    message: messageFromEvent(event),
    component: "webview",
  };
  if (operationId?.trim()) {
    record.operationId = truncateUtf8(operationId.trim(), MAX_LOG_STRING_BYTES);
  }

  const seen = new WeakSet<object>();
  let fieldCount = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (fieldCount >= MAX_OBJECT_FIELDS) {
      record.truncated = true;
      break;
    }
    fieldCount += 1;
    if (CORE_FIELDS.has(key) || isSensitiveKey(key)) continue;
    if (key === "error") {
      const error = sanitizeError(value, record.message);
      if (error) record.error = error;
      continue;
    }
    const sanitized = sanitizeValue(value, key, 0, seen);
    if (sanitized !== undefined) record[key] = sanitized;
  }

  enforceRecordLimit(record);
  return record;
}

/** 将日志记录编码为 UTF-8 JSON 字符串。 */
export function encodeLogRecord(
  event: string,
  fields: LogFields = {},
  operationId?: string,
): string {
  try {
    return JSON.stringify(buildLogRecord(event, fields, operationId));
  } catch {
    return JSON.stringify({
      event: "logging.record.invalid",
      message: "Structured log record is invalid",
      component: "webview",
      error: {
        code: "logging_serialization_failed",
        message: "Structured log serialization failed",
      },
    });
  }
}

function messageFromEvent(event: string): string {
  const acronyms: Record<string, string> = {
    ai: "AI",
    api: "API",
    rdp: "RDP",
    sftp: "SFTP",
    ssh: "SSH",
    tls: "TLS",
    ui: "UI",
  };
  return event
    .split(".")
    .map((segment) => acronyms[segment] ?? segment)
    .join(" ");
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return new Set([
    "password",
    "passphrase",
    "privatekey",
    "apikey",
    "token",
    "cookie",
    "authorization",
    "secret",
    "path",
    "localpath",
    "remotepath",
    "filename",
    "filepath",
    "terminaloutput",
    "recentterminaloutput",
    "terminalinput",
    "command",
    "clipboard",
    "clipboardtext",
    "messages",
    "prompt",
    "selectiontext",
    "response",
    "content",
  ]).has(normalizedKey(key));
}

function sanitizeValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth >= MAX_DEPTH || isSensitiveKey(key)) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return truncateUtf8(value, MAX_LOG_STRING_BYTES);
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, key, depth + 1, seen))
      .filter((item) => item !== undefined);
  }

  const output: LogFields = {};
  let fieldCount = 0;
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    if (fieldCount >= MAX_OBJECT_FIELDS) break;
    fieldCount += 1;
    if (CORE_FIELDS.has(nestedKey) || isSensitiveKey(nestedKey)) continue;
    const sanitized = sanitizeValue(nestedValue, nestedKey, depth + 1, seen);
    if (sanitized !== undefined) output[nestedKey] = sanitized;
  }
  return output;
}

function sanitizeError(
  value: unknown,
  canonicalMessage: string,
): StructuredLogError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = value as Record<string, unknown>;
  const code =
    typeof error.code === "string" && error.code.trim()
      ? error.code
      : "unknown_error";
  const providedMessage =
    typeof error.message === "string" && error.message.trim()
      ? error.message
      : "Operation failed";
  const rawDetail =
    typeof error.detail === "string"
      ? error.detail
      : typeof error.details === "string"
        ? error.details
        : providedMessage !== canonicalMessage
          ? providedMessage
          : undefined;
  return {
    code: truncateUtf8(code, MAX_LOG_STRING_BYTES),
    message: truncateUtf8(canonicalMessage, MAX_LOG_STRING_BYTES),
    ...(rawDetail
      ? {
          detail: truncateUtf8(
            redactAbsolutePaths(rawDetail),
            MAX_LOG_ERROR_DETAIL_BYTES,
          ),
        }
      : {}),
  };
}

function redactAbsolutePaths(value: string): string {
  return value
    .split(/\s+/u)
    .map((part) => {
      const windowsPath = /^[a-z]:[\\/]/iu.test(part);
      const uncPath = /^\\\\/u.test(part);
      const homePath = /^\/(?:home|Users)\//u.test(part);
      return windowsPath || uncPath || homePath ? "[REDACTED_PATH]" : part;
    })
    .join(" ");
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let start = 0;
  let end = value.length;
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) {
      start = middle;
    } else {
      end = middle - 1;
    }
  }
  return value.slice(0, start);
}

function encodedBytes(record: StructuredLogRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

function enforceRecordLimit(record: StructuredLogRecord): void {
  if (encodedBytes(record) <= MAX_LOG_RECORD_BYTES) return;
  record.truncated = true;
  if (record.error?.detail) delete record.error.detail;
  if (encodedBytes(record) <= MAX_LOG_RECORD_BYTES) return;

  const optionalKeys = Object.keys(record)
    .filter(
      (key) =>
        ![
          "event",
          "message",
          "component",
          "operationId",
          "error",
          "truncated",
        ].includes(key),
    )
    .sort(
      (left, right) =>
        JSON.stringify(record[right]).length -
        JSON.stringify(record[left]).length,
    );
  for (const key of optionalKeys) {
    delete record[key];
    if (encodedBytes(record) <= MAX_LOG_RECORD_BYTES) return;
  }
}
