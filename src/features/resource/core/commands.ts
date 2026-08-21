/**
 * 资源监控命令封装。
 * 职责：统一前端到 Tauri 的资源监控命令调用入口。
 */
import type { HostProfile } from "@/types";
import { invokeTauriCommand } from "@/shared/tauri/commands";

/** 启动本地资源监控。 */
export function startLocalResourceMonitor(
  sessionId: string,
  intervalSec: number,
) {
  return invokeTauriCommand("resource_monitor_start_local", {
    sessionId,
    intervalSec,
  });
}

/** 启动远端 SSH 资源监控。 */
export function startSshResourceMonitor(
  sessionId: string,
  profile: HostProfile,
  operationId: string,
  intervalSec: number,
) {
  return invokeTauriCommand("resource_monitor_start_ssh", {
    sessionId,
    profile,
    operationId,
    intervalSec,
  });
}

/** 停止资源监控。 */
export function stopResourceMonitor(sessionId: string) {
  return invokeTauriCommand("resource_monitor_stop", {
    sessionId,
  });
}
