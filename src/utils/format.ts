import type { Locale } from "@/i18n";

/** 将字节数格式化为可读字符串。 */
export function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** 将秒级时间戳格式化为本地日期时间字符串。 */
export function formatTime(epoch: number, locale: Locale) {
  return new Date(epoch * 1000).toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 将毫秒级时间戳格式化为本地日期时间字符串。 */
export function formatDateTimeMs(timestamp: number, locale: Locale) {
  return new Date(timestamp).toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 将 Date 对象格式化为本地日期时间字符串。 */
export function formatDateTime(value: Date, locale: Locale) {
  return value.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 将本地时区偏移格式化为 GMT 标记。 */
function formatLocalGmtOffset(value: Date) {
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return minutes === 0
    ? `GMT${sign}${hours}`
    : `GMT${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/** 将构建时间格式化为当前系统本地时间，避免直接展示 UTC ISO 字符串。 */
export function formatBuildTime(value: unknown) {
  if (typeof value !== "string") return "unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  const date = new Date(timestamp);
  const localTime = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
  return `${localTime} ${formatLocalGmtOffset(date)}`;
}
