/**
 * 底部区域组件。
 * 负责组合快捷命令栏、状态栏和快捷命令管理弹窗。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { QuickCommandItem } from "@/types";
import type {
  BottomAreaProps,
  TerminalStats,
} from "@/main/components/bottom-area/BottomArea.types";
import QuickbarManagerModal from "@/main/components/bottom-area/QuickbarManagerModal";
import QuickbarRow from "@/main/components/bottom-area/QuickbarRow";
import StatusbarRow from "@/main/components/bottom-area/StatusbarRow";
import "@/main/components/BottomArea.css";

function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const current = new Date();
    const msUntilNextMinute =
      (60 - current.getSeconds()) * 1000 - current.getMilliseconds();
    let interval: number | null = null;
    const firstTimer = window.setTimeout(
      () => {
        setNow(new Date());
        interval = window.setInterval(() => {
          setNow(new Date());
        }, 60_000);
      },
      Math.max(msUntilNextMinute, 0),
    );
    return () => {
      window.clearTimeout(firstTimer);
      if (interval !== null) {
        window.clearInterval(interval);
      }
    };
  }, []);
  return now;
}

/** 快捷栏与状态栏底部区域。 */
export default function BottomArea({
  visibility,
  managerOpen,
  onOpenManager,
  showGroupTitle,
  groups,
  commands,
  onCloseManager,
  onAddGroup,
  onRenameGroup,
  onRemoveGroup,
  onToggleGroupVisible,
  onAddCommand,
  onUpdateCommand,
  onReorderCommands,
  onRemoveCommand,
  onShowGroupTitleChange,
  onRunCommand,
  getActiveTerminalStats,
  resourceMonitorEnabled,
  resourceMonitorStatus,
  resourceSnapshot,
  runningTransfers,
  onOpenTransfersWidget,
  activeAiConfigName,
  securityLocked,
  securityProvider,
  onSecurityAction,
  onLockScreen,
  locale,
  t,
}: BottomAreaProps) {
  const [stats, setStats] = useState<TerminalStats>(() =>
    getActiveTerminalStats(),
  );
  const [pendingFocusCommandId, setPendingFocusCommandId] = useState<
    string | null
  >(null);
  const getActiveTerminalStatsRef = useRef(getActiveTerminalStats);
  const now = useMinuteClock();

  useEffect(() => {
    getActiveTerminalStatsRef.current = getActiveTerminalStats;
  }, [getActiveTerminalStats]);

  useEffect(() => {
    setStats(getActiveTerminalStatsRef.current());
    const timer = window.setInterval(() => {
      setStats(getActiveTerminalStatsRef.current());
    }, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.order - b.order),
    [groups],
  );

  const visibleGroupIds = useMemo(
    () =>
      new Set(
        sortedGroups.filter((group) => group.visible).map((group) => group.id),
      ),
    [sortedGroups],
  );

  const commandsByGroup = useMemo(() => {
    const map = new Map<string, QuickCommandItem[]>();
    commands.forEach((item) => {
      if (!visibleGroupIds.has(item.groupId)) return;
      if (!map.has(item.groupId)) {
        map.set(item.groupId, []);
      }
      map.get(item.groupId)?.push(item);
    });
    return map;
  }, [commands, visibleGroupIds]);

  const hasVisibleCommands = Array.from(commandsByGroup.values()).some(
    (items) => items.length > 0,
  );

  if (!visibility.quickbar && !visibility.statusbar) {
    return null;
  }

  return (
    <>
      <footer className="bottom-area">
        {visibility.quickbar && (
          <QuickbarRow
            showGroupTitle={showGroupTitle}
            sortedGroups={sortedGroups}
            visibleGroupIds={visibleGroupIds}
            commandsByGroup={commandsByGroup}
            hasVisibleCommands={hasVisibleCommands}
            onOpenManager={onOpenManager}
            onToggleGroupVisible={onToggleGroupVisible}
            onRemoveCommand={onRemoveCommand}
            onRunCommand={onRunCommand}
            onFocusCommandInManager={(commandId) => {
              setPendingFocusCommandId(commandId);
              onOpenManager();
            }}
            t={t}
          />
        )}
        {visibility.quickbar && visibility.statusbar ? (
          <div className="bottom-area-divider" aria-hidden="true" />
        ) : null}
        {visibility.statusbar && (
          <StatusbarRow
            stats={stats}
            now={now}
            resourceMonitorEnabled={resourceMonitorEnabled}
            resourceMonitorStatus={resourceMonitorStatus}
            resourceSnapshot={resourceSnapshot}
            runningTransfers={runningTransfers}
            onOpenTransfersWidget={onOpenTransfersWidget}
            activeAiConfigName={activeAiConfigName}
            securityLocked={securityLocked}
            securityProvider={securityProvider}
            onSecurityAction={onSecurityAction}
            onLockScreen={onLockScreen}
            locale={locale}
            t={t}
          />
        )}
      </footer>

      <QuickbarManagerModal
        open={managerOpen}
        showGroupTitle={showGroupTitle}
        sortedGroups={sortedGroups}
        commands={commands}
        pendingFocusCommandId={pendingFocusCommandId}
        onPendingFocusCommandHandled={() => setPendingFocusCommandId(null)}
        onClose={onCloseManager}
        onAddGroup={onAddGroup}
        onRenameGroup={onRenameGroup}
        onRemoveGroup={onRemoveGroup}
        onAddCommand={onAddCommand}
        onUpdateCommand={onUpdateCommand}
        onReorderCommands={onReorderCommands}
        onRemoveCommand={onRemoveCommand}
        onShowGroupTitleChange={onShowGroupTitleChange}
        t={t}
      />
    </>
  );
}
