import type { HostProfile, RdpProfile } from "@/types";

/** 连接前可直接从 Profile 判断的必填字段。 */
export type ConnectionRequiredField =
  | "host"
  | "username"
  | "password"
  | "privateKeyPath";

/** 返回 SSH Profile 当前缺失的连接字段。 */
export function getMissingSshConnectionFields(
  profile: HostProfile,
): ConnectionRequiredField[] {
  const missing: ConnectionRequiredField[] = [];
  if (!profile.host.trim()) missing.push("host");

  // 动态凭据的认证信息只能由后端在解锁后解析，前端不读取或推断密码。
  if (profile.credentialId) return missing;

  if (!profile.username.trim()) missing.push("username");
  if (profile.authType === "password" && !profile.passwordRef) {
    missing.push("password");
  }
  if (profile.authType === "privateKey" && !profile.privateKeyPath?.trim()) {
    missing.push("privateKeyPath");
  }
  return missing;
}

/** 返回 RDP Profile 当前缺失的连接字段。 */
export function getMissingRdpConnectionFields(
  profile: RdpProfile,
): ConnectionRequiredField[] {
  const missing: ConnectionRequiredField[] = [];
  if (!profile.host.trim()) missing.push("host");

  // RDP 动态凭据同样由后端解析，前端只校验非敏感的主机字段。
  if (profile.credentialId) return missing;

  if (!profile.username.trim()) missing.push("username");
  if (!profile.passwordRef) missing.push("password");
  return missing;
}
