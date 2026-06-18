/** SSH Profile 高级连接配置分区的纯工具类型与状态推导函数。 */
import type { HostProfile } from "@/types";

export type SshRoutingMode = NonNullable<HostProfile["proxyMode"]> | "jump";

export function resolveSshRoutingMode(draft: HostProfile): SshRoutingMode {
  if (draft.jumpProfileIds?.length) return "jump";
  return draft.proxyMode ?? "direct";
}
