import { invokeTauriCommand } from "@/shared/tauri/commands";
import type { LockScreenStatus } from "@/features/lock-screen/types";

/** 读取进程内应用锁屏状态。 */
export function getLockScreenStatus() {
  return invokeTauriCommand<LockScreenStatus>("lock_screen_status");
}

/** 从主窗口进入锁屏状态。 */
export function lockScreen() {
  return invokeTauriCommand<LockScreenStatus>("lock_screen");
}

/** 从主窗口验证独立密码并解锁应用。 */
export function unlockScreen(password: string) {
  return invokeTauriCommand<LockScreenStatus>("unlock_screen", {
    input: { password },
  });
}

/** 更新独立锁屏密码，空字符串表示空密码。 */
export function setLockScreenPassword(password: string) {
  return invokeTauriCommand<LockScreenStatus>("lock_screen_password_set", {
    input: { password },
  });
}
