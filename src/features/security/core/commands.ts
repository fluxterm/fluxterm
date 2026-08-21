import { invokeTauriCommand } from "@/shared/tauri/commands";
import type { SecurityStatus } from "@/features/security/types";

/** 读取当前安全状态。 */
export function securityStatusGet() {
  return invokeTauriCommand<SecurityStatus>("security_status");
}

/** 使用安全密码解锁当前密文。 */
export function securityUnlock(password: string) {
  return invokeTauriCommand<SecurityStatus>("security_unlock", {
    input: { password },
  });
}

/** 锁定当前安全会话。 */
export function securityLock() {
  return invokeTauriCommand<SecurityStatus>("security_lock");
}

/** 切换到强保护模式。 */
export function securityEnableStrongProtection(password: string) {
  return invokeTauriCommand<SecurityStatus>(
    "security_enable_strong_protection",
    {
      input: { password },
    },
  );
}

/** 修改当前安全密码。 */
export function securityChangePassword(
  currentPassword: string,
  nextPassword: string,
) {
  return invokeTauriCommand<SecurityStatus>("security_change_password", {
    input: {
      currentPassword,
      nextPassword,
    },
  });
}

/** 切换到弱保护模式。 */
export function securityEnableWeakProtection() {
  return invokeTauriCommand<SecurityStatus>("security_enable_weak_protection");
}
