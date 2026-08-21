import type { ProxyRuntime, ProxySpec } from "@/types";
import { invokeTauriCommand } from "@/shared/tauri/commands";

/** 创建全局代理实例。 */
export function openProxy(spec: ProxySpec, operationId?: string) {
  return invokeTauriCommand<ProxyRuntime>("proxy_open", { spec, operationId });
}

/** 关闭指定代理实例。 */
export function closeProxy(proxyId: string, operationId?: string) {
  return invokeTauriCommand("proxy_close", { proxyId, operationId });
}

/** 获取全部代理实例。 */
export function listProxies() {
  return invokeTauriCommand<ProxyRuntime[]>("proxy_list");
}

/** 关闭全部代理实例。 */
export function closeAllProxies(operationId?: string) {
  return invokeTauriCommand("proxy_close_all", { operationId });
}
