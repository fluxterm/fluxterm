import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getLockScreenStatus,
  lockScreen,
  setLockScreenPassword,
  unlockScreen,
} from "@/features/lock-screen/core/commands";
import type { LockScreenStatus } from "@/features/lock-screen/types";

const LOCK_SCREEN_CHANGED_EVENT = "lock-screen://changed";

/** 订阅进程内锁屏真相，并提供主窗口锁定操作。 */
export default function useLockScreen() {
  const [status, setStatus] = useState<LockScreenStatus | null>(null);

  const applyStatus = useCallback((next: LockScreenStatus) => {
    setStatus((current) =>
      current && current.revision > next.revision ? current : next,
    );
  }, []);

  useEffect(() => {
    let active = true;
    let stopListening: (() => void) | null = null;

    void listen<LockScreenStatus>(LOCK_SCREEN_CHANGED_EVENT, (event) => {
      if (active) applyStatus(event.payload);
    })
      .then((stop) => {
        if (!active) {
          stop();
          return;
        }
        stopListening = stop;
        return getLockScreenStatus();
      })
      .then((next) => {
        if (active && next) applyStatus(next);
      })
      .catch(() => {
        // 查询失败时保持 pending，独立窗口不会因此短暂泄露业务内容。
      });

    return () => {
      active = false;
      stopListening?.();
    };
  }, [applyStatus]);

  const lock = useCallback(async () => {
    const next = await lockScreen();
    applyStatus(next);
  }, [applyStatus]);

  const unlock = useCallback(
    async (password: string) => {
      const next = await unlockScreen(password);
      applyStatus(next);
    },
    [applyStatus],
  );

  const setPassword = useCallback(
    async (password: string) => {
      const next = await setLockScreenPassword(password);
      applyStatus(next);
    },
    [applyStatus],
  );

  return {
    status,
    pending: status === null,
    locked: status?.locked ?? true,
    lock,
    unlock,
    setPassword,
  };
}
