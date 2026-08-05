/**
 * 应用根组件。
 * 职责：校验配置目录，并按窗口类型挂载对应运行单元。
 */
import { useEffect, useState } from "react";
import AppShell from "@/main/AppShell";
import SubAppRoot from "@/subapps/SubAppRoot";
import { parseSubAppIdFromHash } from "@/subapps/core/lifecycle";
import ConfigDirectoryRecovery from "@/features/config-directory/components/ConfigDirectoryRecovery";
import {
  getConfigDirectoryStatus,
  type ConfigDirectoryStatus,
} from "@/features/config-directory/core/commands";

/** 应用根入口。 */
export default function AppRoot() {
  const [status, setStatus] = useState<ConfigDirectoryStatus | null>(null);

  useEffect(() => {
    let active = true;
    void getConfigDirectoryStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((error) => {
        if (!active) return;
        setStatus({
          activeDir: "",
          source: "default",
          ready: false,
          error: error instanceof Error ? error.message : String(error),
          pendingDir: null,
          envOverride: false,
          locale: null,
        });
      });
    return () => {
      active = false;
    };
  }, []);

  if (!status) return null;
  if (!status.ready) return <ConfigDirectoryRecovery status={status} />;
  if (parseSubAppIdFromHash(window.location.hash)) {
    return <SubAppRoot />;
  }
  return <AppShell />;
}
