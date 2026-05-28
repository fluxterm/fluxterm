import {
  debug as pluginDebug,
  error as pluginError,
  info as pluginInfo,
  warn as pluginWarn,
} from "@tauri-apps/plugin-log";

export type TelemetryLevel = "debug" | "info" | "warn" | "error";

type TelemetryPayload = {
  event: string;
} & Record<string, unknown>;

/** 生成 traceId。 */
export function createTraceId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 输出统一结构化埋点。 */
export async function logTelemetry(
  level: TelemetryLevel,
  event: string,
  fields?: Record<string, unknown>,
) {
  const normalizedEvent = normalizeEventName(event);
  const { traceId, ...restFields } = fields ?? {};
  const payload: TelemetryPayload = {
    event: normalizedEvent,
    ...restFields,
  };
  if (typeof traceId === "string" && traceId.trim()) {
    payload.traceId = traceId;
  }
  const line = JSON.stringify(payload);
  if (level === "debug") return pluginDebug(line);
  if (level === "warn") return pluginWarn(line);
  if (level === "error") return pluginError(line);
  return pluginInfo(line);
}

function normalizeEventName(value: string): string {
  const withDots = value
    .trim()
    .replace(/[:_-]/g, ".")
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
  return withDots.toLowerCase() || "frontend.log.update";
}

function parseTelemetryLikeMessage(input: string): {
  event: string;
  fields?: Record<string, unknown>;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      event: "frontend.log.update",
      fields: { message: "" },
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const event =
        typeof parsed.event === "string" && parsed.event.trim()
          ? parsed.event
          : "frontend.log.update";
      const { event: _event, ...rest } = parsed;
      return {
        event,
        fields: rest,
      };
    }
  } catch {
    // 非 JSON 字符串按 message 透传。
  }
  return {
    event: "frontend.log.update",
    fields: { message: input },
  };
}

async function logRaw(level: TelemetryLevel, message: string) {
  const { event, fields } = parseTelemetryLikeMessage(message);
  return logTelemetry(level, event, fields);
}

export async function debug(message: string) {
  return logRaw("debug", message);
}

export async function info(message: string) {
  return logRaw("info", message);
}

export async function warn(message: string) {
  return logRaw("warn", message);
}

export async function error(message: string) {
  return logRaw("error", message);
}
