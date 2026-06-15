import type { Translate } from "@/i18n";
import type { ResourceMonitorUnsupportedReason } from "@/types";

export function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const precision = size >= 100 || index === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[index]}`;
}

export function formatUptime(value?: number | null) {
  if (value == null || !Number.isFinite(value) || value < 0) return "--";
  const totalSeconds = Math.floor(value);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (!parts.length || (parts.length < 2 && seconds > 0 && days === 0)) {
    parts.push(`${seconds}s`);
  }

  return parts.slice(0, 3).join(" ");
}

export function resolveResourceSeverity(value: number) {
  if (!Number.isFinite(value) || value < 60) return "success";
  if (value < 85) return "warning";
  return "danger";
}

export function resolveResourceUnsupportedMessage(
  t: Translate,
  reason?: ResourceMonitorUnsupportedReason | null,
) {
  switch (reason) {
    case "host_key_untrusted":
      return t("status.resource.reason.hostKeyUntrusted");
    case "probe_failed":
      return t("status.resource.reason.probeFailed");
    case "connect_failed":
      return t("status.resource.reason.connectFailed");
    case "unsupported_platform":
      return t("status.resource.reason.unsupportedPlatform");
    case "sample_failed":
      return t("status.resource.reason.sampleFailed");
    default:
      return t("status.resource.unsupported");
  }
}
