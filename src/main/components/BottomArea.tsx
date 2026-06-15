/**
 * 底部区域组件。
 * 负责快捷命令栏、状态栏和资源监控展示，并承载快捷命令的上下文菜单。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FiActivity,
  FiDatabase,
  FiEdit2,
  FiLock,
  FiMenu,
  FiUnlock,
  FiRepeat,
  FiSettings,
  FiTrash2,
} from "react-icons/fi";
import type { SecurityProvider } from "@/features/security/types";
import type { Locale, Translate } from "@/i18n";
import type {
  QuickCommandGroup,
  QuickCommandItem,
  ResourceMonitorStatus,
  ResourceMonitorUnsupportedReason,
  SessionResourceSnapshot,
  SftpProgress,
} from "@/types";
import { formatDateTime } from "@/utils/format";
import Modal from "@/components/ui/modal/Modal";
import Button from "@/components/ui/button";
import Select from "@/components/ui/select";
import InputDialog from "@/components/ui/InputDialog";
import ContextMenu from "@/components/ui/menu/ContextMenu";
import { DEFAULT_QUICKBAR_GROUP_ID } from "@/constants/quickbar";
import { FLUXTERM_ISSUES_URL } from "@/constants/links";
import "@/main/components/BottomArea.css";

type GroupMutationResult =
  | { ok: true; id?: string }
  | { ok: false; errorKey: import("@/i18n").TranslationKey };

type FooterVisibility = {
  quickbar: boolean;
  statusbar: boolean;
};

type TerminalStats = {
  windowRows: number;
  windowCols: number;
  bufferLines: number;
};

type BottomAreaProps = {
  visibility: FooterVisibility;
  managerOpen: boolean;
  onOpenManager: () => void;
  showGroupTitle: boolean;
  groups: QuickCommandGroup[];
  commands: QuickCommandItem[];
  onCloseManager: () => void;
  onAddGroup: (name: string) => GroupMutationResult;
  onRenameGroup: (groupId: string, name: string) => GroupMutationResult;
  onRemoveGroup: (groupId: string) => void;
  onToggleGroupVisible: (groupId: string) => void;
  onAddCommand: (payload: {
    label: string;
    command: string;
    groupId?: string | null;
  }) => string | null;
  onUpdateCommand: (
    commandId: string,
    payload: Partial<QuickCommandItem>,
  ) => void;
  onReorderCommands: (groupId: string, commandIds: string[]) => void;
  onRemoveCommand: (commandId: string) => void;
  onShowGroupTitleChange: React.Dispatch<React.SetStateAction<boolean>>;
  onRunCommand: (command: string) => void;
  getActiveTerminalStats: () => TerminalStats;
  resourceMonitorEnabled: boolean;
  resourceMonitorStatus: ResourceMonitorStatus;
  resourceSnapshot: SessionResourceSnapshot | null;
  sftpProgressBySession: Record<string, SftpProgress>;
  onOpenTransfersWidget: () => void;
  activeAiConfigName: string | null;
  securityLocked: boolean;
  securityProvider: SecurityProvider;
  onSecurityAction: () => void;
  locale: Locale;
  t: Translate;
};

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function formatBytes(value: number) {
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

function formatUptime(value?: number | null) {
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

function resolveResourceSeverity(value: number) {
  if (!Number.isFinite(value) || value < 60) return "success";
  if (value < 85) return "warning";
  return "danger";
}

function resolveResourceUnsupportedMessage(
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

/** 按目标索引生成命令排序预览。 */
function moveCommandId(
  commandIds: string[],
  sourceCommandId: string,
  targetIndex: number,
) {
  const sourceIndex = commandIds.indexOf(sourceCommandId);
  if (sourceIndex < 0) {
    return commandIds;
  }
  const next = commandIds.slice();
  const [moved] = next.splice(sourceIndex, 1);
  const safeTargetIndex = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(safeTargetIndex, 0, moved);
  return next;
}

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
  sftpProgressBySession,
  onOpenTransfersWidget,
  activeAiConfigName,
  securityLocked,
  securityProvider,
  onSecurityAction,
  locale,
  t,
}: BottomAreaProps) {
  const [stats, setStats] = useState<TerminalStats>(() =>
    getActiveTerminalStats(),
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    commandId: string;
  } | null>(null);
  const [groupDialogMode, setGroupDialogMode] = useState<
    "add" | "rename" | null
  >(null);
  const [groupDialogError, setGroupDialogError] = useState<string | null>(null);
  const [deleteGroupPendingId, setDeleteGroupPendingId] = useState<
    string | null
  >(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(
    null,
  );
  const [pendingFocusCommandId, setPendingFocusCommandId] = useState<
    string | null
  >(null);
  const [draggingCommandId, setDraggingCommandId] = useState<string | null>(
    null,
  );
  const [dragOverCommandId, setDragOverCommandId] = useState<string | null>(
    null,
  );
  const [previewCommandIds, setPreviewCommandIds] = useState<string[] | null>(
    null,
  );
  const now = useMinuteClock();
  const quickbarMenuRef = useRef<HTMLDivElement | null>(null);
  const commandLabelInputRef = useRef<HTMLInputElement | null>(null);
  const getActiveTerminalStatsRef = useRef(getActiveTerminalStats);
  const draggingCommandIdRef = useRef<string | null>(null);
  const suppressCommandClickRef = useRef<string | null>(null);
  const [quickbarMenuOpen, setQuickbarMenuOpen] = useState(false);
  const [resourcePopoverOpen, setResourcePopoverOpen] = useState(false);

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

  function resolveCommandLabel(item: QuickCommandItem) {
    const value = item.label.trim();
    return value || t("quickbar.manager.newLabel");
  }

  const commandCountByGroup = useMemo(() => {
    const map = new Map<string, number>();
    commands.forEach((item) => {
      map.set(item.groupId, (map.get(item.groupId) ?? 0) + 1);
    });
    return map;
  }, [commands]);

  const managerGroupOptions = useMemo(
    () =>
      sortedGroups.map((group) => ({
        value: group.id,
        label: `${group.name} (${commandCountByGroup.get(group.id) ?? 0})`,
      })),
    [sortedGroups, commandCountByGroup],
  );

  const selectedGroup = useMemo(
    () => sortedGroups.find((group) => group.id === selectedGroupId) ?? null,
    [sortedGroups, selectedGroupId],
  );
  const deleteGroupPending = useMemo(
    () =>
      sortedGroups.find((group) => group.id === deleteGroupPendingId) ?? null,
    [sortedGroups, deleteGroupPendingId],
  );

  const groupCommands = useMemo(
    () => commands.filter((item) => item.groupId === selectedGroupId),
    [commands, selectedGroupId],
  );
  const previewGroupCommands = useMemo(() => {
    if (!previewCommandIds) return groupCommands;
    const commandById = new Map(groupCommands.map((item) => [item.id, item]));
    const previewCommands = previewCommandIds
      .map((id) => commandById.get(id))
      .filter((item): item is QuickCommandItem => Boolean(item));
    if (previewCommands.length !== groupCommands.length) return groupCommands;
    return previewCommands;
  }, [groupCommands, previewCommandIds]);

  const selectedCommand = useMemo(
    () => groupCommands.find((item) => item.id === selectedCommandId) ?? null,
    [groupCommands, selectedCommandId],
  );

  useEffect(() => {
    if (!quickbarMenuOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!quickbarMenuRef.current) return;
      if (!quickbarMenuRef.current.contains(event.target as Node)) {
        setQuickbarMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
    };
  }, [quickbarMenuOpen]);

  useEffect(() => {
    if (!groupDialogMode) {
      queueMicrotask(() => {
        setGroupDialogError(null);
      });
    }
  }, [groupDialogMode]);

  useEffect(() => {
    if (!managerOpen) return;
    if (!sortedGroups.length) {
      queueMicrotask(() => {
        setSelectedGroupId(null);
        setSelectedCommandId(null);
      });
      return;
    }
    const focusCommand = pendingFocusCommandId
      ? (commands.find((item) => item.id === pendingFocusCommandId) ?? null)
      : null;
    if (focusCommand) {
      queueMicrotask(() => {
        setSelectedGroupId(focusCommand.groupId);
        setSelectedCommandId(focusCommand.id);
      });
      return;
    }
    const nextGroupId =
      selectedGroupId && sortedGroups.some((g) => g.id === selectedGroupId)
        ? selectedGroupId
        : sortedGroups[0].id;
    queueMicrotask(() => {
      setSelectedGroupId(nextGroupId);
    });
    const nextCommands = commands.filter(
      (item) => item.groupId === nextGroupId,
    );
    queueMicrotask(() => {
      setSelectedCommandId((prev) => {
        if (prev && nextCommands.some((item) => item.id === prev)) return prev;
        return nextCommands[0]?.id ?? null;
      });
    });
  }, [
    managerOpen,
    sortedGroups,
    commands,
    pendingFocusCommandId,
    selectedGroupId,
  ]);

  useEffect(() => {
    if (!selectedGroupId) return;
    if (groupCommands.some((item) => item.id === selectedCommandId)) return;
    queueMicrotask(() => {
      setSelectedCommandId(groupCommands[0]?.id ?? null);
    });
  }, [selectedGroupId, groupCommands, selectedCommandId]);

  useEffect(() => {
    if (!managerOpen || !pendingFocusCommandId) return;
    if (selectedCommand?.id !== pendingFocusCommandId) return;
    const input = commandLabelInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    setPendingFocusCommandId(null);
  }, [managerOpen, pendingFocusCommandId, selectedCommand?.id]);

  function handleAddGroup() {
    setGroupDialogMode("add");
  }

  function handleRenameGroup() {
    if (!selectedGroup || selectedGroup.id === DEFAULT_QUICKBAR_GROUP_ID)
      return;
    setGroupDialogMode("rename");
  }

  function handleDeleteGroup() {
    if (!selectedGroup || selectedGroup.id === DEFAULT_QUICKBAR_GROUP_ID)
      return;
    setDeleteGroupPendingId(selectedGroup.id);
  }

  function handleAddCommand() {
    if (!selectedGroupId) return;
    const commandId = onAddCommand({
      label: t("quickbar.manager.newLabel"),
      command: "",
      groupId: selectedGroupId,
    });
    if (!commandId) return;
    setSelectedCommandId(commandId);
    setPendingFocusCommandId(commandId);
  }

  function handleDeleteCommand() {
    if (!selectedCommandId) return;
    onRemoveCommand(selectedCommandId);
  }

  function handleCopyCommand() {
    if (!selectedCommand) return;
    onAddCommand({
      label: `${selectedCommand.label} ${t("quickbar.manager.copySuffix")}`,
      command: selectedCommand.command,
      groupId: selectedCommand.groupId,
    });
  }

  function clearCommandDragState() {
    draggingCommandIdRef.current = null;
    setDraggingCommandId(null);
    setDragOverCommandId(null);
    setPreviewCommandIds(null);
  }

  function handleCommandPointerDown(
    event: React.PointerEvent<HTMLButtonElement>,
    commandId: string,
  ) {
    if (event.button !== 0 || groupCommands.length < 2) return;
    event.preventDefault();
    const commandList = event.currentTarget.closest(".qm-command-list");
    if (!commandList) return;
    const activeCommandList = commandList;
    const commandIds = groupCommands.map((item) => item.id);
    let currentPreviewCommandIds = commandIds;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let lastPreviewCommandIds = commandIds;

    function resolvePreviewCommandIds(clientY: number) {
      const items = Array.from(
        activeCommandList.querySelectorAll<HTMLElement>("[data-command-id]"),
      );
      const orderedIds = items
        .map((item) => item.dataset.commandId)
        .filter((id): id is string => Boolean(id && commandIds.includes(id)));
      const idsWithoutSource = orderedIds.filter((id) => id !== commandId);
      let insertIndex = idsWithoutSource.length;

      for (const item of items) {
        const itemCommandId = item.dataset.commandId;
        if (!itemCommandId || itemCommandId === commandId) continue;
        const rect = item.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          insertIndex = idsWithoutSource.indexOf(itemCommandId);
          break;
        }
      }

      return moveCommandId(orderedIds, commandId, insertIndex);
    }

    function cleanup() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onPointerCancel);
      clearCommandDragState();
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (
        !moved &&
        (Math.abs(moveEvent.clientX - startX) > 4 ||
          Math.abs(moveEvent.clientY - startY) > 4)
      ) {
        moved = true;
        draggingCommandIdRef.current = commandId;
        setDraggingCommandId(commandId);
        setPreviewCommandIds(currentPreviewCommandIds);
      }
      if (!moved) return;
      const nextPreviewCommandIds = resolvePreviewCommandIds(moveEvent.clientY);
      if (
        nextPreviewCommandIds.join("\u0000") ===
        lastPreviewCommandIds.join("\u0000")
      ) {
        return;
      }
      lastPreviewCommandIds = nextPreviewCommandIds;
      currentPreviewCommandIds = nextPreviewCommandIds;
      setPreviewCommandIds(nextPreviewCommandIds);
      const sourceIndex = nextPreviewCommandIds.indexOf(commandId);
      const nextTargetCommandId =
        sourceIndex >= 0
          ? (nextPreviewCommandIds[sourceIndex + 1] ??
            nextPreviewCommandIds[sourceIndex - 1] ??
            null)
          : null;
      setDragOverCommandId(nextTargetCommandId);
    };

    const onPointerUp = () => {
      cleanup();
      if (!moved) return;
      suppressCommandClickRef.current = commandId;
      if (
        !selectedGroupId ||
        currentPreviewCommandIds.join("\u0000") === commandIds.join("\u0000")
      ) {
        return;
      }
      onReorderCommands(selectedGroupId, currentPreviewCommandIds);
    };

    const onPointerCancel = () => cleanup();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerCancel, { once: true });
    window.addEventListener("blur", onPointerCancel, { once: true });
  }

  const transferHint = useMemo(() => {
    // 仅统计运行中的上传/下载任务，用于状态栏常驻指示器与点击行为控制。
    const progresses = Object.values(sftpProgressBySession);
    const runningUploads = progresses.filter(
      (item) => item.status === "running" && item.op === "upload",
    ).length;
    const runningDownloads = progresses.filter(
      (item) => item.status === "running" && item.op === "download",
    ).length;
    return {
      runningUploads,
      runningDownloads,
      hasTransfer: runningUploads > 0 || runningDownloads > 0,
    };
  }, [sftpProgressBySession]);

  if (!visibility.quickbar && !visibility.statusbar) {
    return null;
  }

  const showResourceStatus = resourceMonitorEnabled;
  const resourceStatus = resourceMonitorStatus;
  const resourceCpu = resourceSnapshot?.cpu ?? null;
  const resourceMemory = resourceSnapshot?.memory ?? null;
  const resourceUnsupportedMessage = resolveResourceUnsupportedMessage(
    t,
    resourceSnapshot?.unsupportedReason,
  );
  const allowResourcePopover =
    resourceStatus === "ready" && Boolean(resourceCpu && resourceMemory);
  const readyResourceCpu = allowResourcePopover ? resourceCpu : null;
  const readyResourceMemory = allowResourcePopover ? resourceMemory : null;
  const readyResourceCpuCount = readyResourceCpu?.logicalCpuCount ?? null;
  const readyResourceUptime = allowResourcePopover
    ? (resourceSnapshot?.uptimeSeconds ?? null)
    : null;
  const resourceMemoryPercent =
    resourceMemory && resourceMemory.totalBytes > 0
      ? (resourceMemory.usedBytes / resourceMemory.totalBytes) * 100
      : 0;
  const cpuSeverity = resourceCpu
    ? resolveResourceSeverity(resourceCpu.totalPercent)
    : "success";
  const memorySeverity = resourceMemory
    ? resolveResourceSeverity(resourceMemoryPercent)
    : "success";

  return (
    <>
      <footer className="bottom-area">
        {visibility.quickbar && (
          <div className="quickbar-row">
            <div className="quickbar">
              <Button
                variant="ghost"
                size="icon"
                className="quickbar-manage-button"
                aria-label={t("quickbar.manager.open")}
                onClick={() => setQuickbarMenuOpen((prev) => !prev)}
              >
                <FiSettings />
              </Button>
              {quickbarMenuOpen && (
                <div className="quickbar-menu" ref={quickbarMenuRef}>
                  <div className="quickbar-menu-section-title">
                    {t("quickbar.menu.config")}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="quickbar-menu-item"
                    onClick={() => {
                      setQuickbarMenuOpen(false);
                      onOpenManager();
                    }}
                  >
                    {t("quickbar.manager.title")}
                  </Button>
                  <div className="quickbar-menu-divider" />
                  <div className="quickbar-menu-section-title">
                    {t("quickbar.menu.groups")}
                  </div>
                  <div className="quickbar-menu-group-list">
                    {sortedGroups.map((group) => (
                      <label
                        key={group.id}
                        className="quickbar-menu-group-item"
                      >
                        <input
                          type="checkbox"
                          checked={group.visible}
                          onChange={() => onToggleGroupVisible(group.id)}
                        />
                        <span>{group.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="quickbar-scroll">
                {hasVisibleCommands ? (
                  sortedGroups
                    .filter((group) => visibleGroupIds.has(group.id))
                    .map((group) => {
                      const groupCommandsForBar =
                        commandsByGroup.get(group.id) ?? [];
                      if (!groupCommandsForBar.length) return null;
                      return (
                        <div className="quickbar-group" key={group.id}>
                          {showGroupTitle && (
                            <span className="quickbar-group-name">
                              {group.name}
                            </span>
                          )}
                          <div className="quickbar-command-list">
                            {groupCommandsForBar.map((item) => (
                              <Button
                                key={item.id}
                                variant="ghost"
                                size="sm"
                                className="quickbar-command"
                                onClick={() => onRunCommand(item.command)}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  setContextMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    commandId: item.id,
                                  });
                                }}
                              >
                                {resolveCommandLabel(item)}
                              </Button>
                            ))}
                          </div>
                        </div>
                      );
                    })
                ) : (
                  <span className="quickbar-empty">{t("quickbar.empty")}</span>
                )}
              </div>
            </div>
          </div>
        )}
        {visibility.quickbar && visibility.statusbar ? (
          <div className="bottom-area-divider" aria-hidden="true" />
        ) : null}
        {visibility.statusbar && (
          <div className="statusbar-row">
            <div className="statusbar">
              <div className="statusbar-left">
                {showResourceStatus && (
                  <div
                    className="statusbar-resource"
                    onMouseEnter={() => {
                      if (allowResourcePopover) setResourcePopoverOpen(true);
                    }}
                    onMouseLeave={() => {
                      if (resourcePopoverOpen) setResourcePopoverOpen(false);
                    }}
                  >
                    {resourceStatus === "ready" &&
                    resourceCpu &&
                    resourceMemory ? (
                      <>
                        <span
                          className={`statusbar-resource-chip ${cpuSeverity}`.trim()}
                        >
                          <FiActivity />
                          <span>
                            {t("status.resource.cpu")}{" "}
                            {formatPercent(resourceCpu.totalPercent)}
                          </span>
                        </span>
                        <span
                          className={`statusbar-resource-chip ${memorySeverity}`.trim()}
                        >
                          <FiDatabase />
                          <span>
                            {t("status.resource.memory")}{" "}
                            {formatPercent(resourceMemoryPercent)}
                          </span>
                        </span>
                      </>
                    ) : (
                      <span className="statusbar-resource-chip muted">
                        {resourceStatus === "disabled"
                          ? t("status.resource.inactive")
                          : resourceStatus === "unsupported"
                            ? resourceUnsupportedMessage
                            : t("status.resource.checking")}
                      </span>
                    )}
                    {allowResourcePopover && resourcePopoverOpen && (
                      <div
                        className="statusbar-resource-popover"
                        data-ui="statusbar-resource-popover"
                      >
                        <>
                          <div className="statusbar-resource-block cpu">
                            <div className="statusbar-resource-title cpu">
                              {t("status.resource.cpu")}
                            </div>
                            <div className="statusbar-resource-grid">
                              <span>{t("status.resource.usage")}</span>
                              <strong>
                                {formatPercent(readyResourceCpu!.totalPercent)}
                              </strong>
                              {readyResourceCpuCount !== null && (
                                <>
                                  <span>
                                    {t("status.resource.cpuLogicalCores")}
                                  </span>
                                  <strong>{readyResourceCpuCount}</strong>
                                </>
                              )}
                              {readyResourceUptime !== null && (
                                <>
                                  <span>{t("status.resource.uptime")}</span>
                                  <strong>
                                    {formatUptime(readyResourceUptime)}
                                  </strong>
                                </>
                              )}
                              {resourceSnapshot?.source === "ssh-linux" && (
                                <>
                                  <span>{t("status.resource.user")}</span>
                                  <strong>
                                    {formatPercent(
                                      readyResourceCpu!.userPercent,
                                    )}
                                  </strong>
                                  <span>{t("status.resource.system")}</span>
                                  <strong>
                                    {formatPercent(
                                      readyResourceCpu!.systemPercent,
                                    )}
                                  </strong>
                                  <span>{t("status.resource.idle")}</span>
                                  <strong>
                                    {formatPercent(
                                      readyResourceCpu!.idlePercent,
                                    )}
                                  </strong>
                                  <span>{t("status.resource.iowait")}</span>
                                  <strong>
                                    {formatPercent(
                                      readyResourceCpu!.iowaitPercent,
                                    )}
                                  </strong>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="statusbar-resource-block memory">
                            <div className="statusbar-resource-title memory">
                              {t("status.resource.memory")}
                            </div>
                            <div className="statusbar-resource-grid">
                              <span>{t("status.resource.total")}</span>
                              <strong>
                                {formatBytes(readyResourceMemory!.totalBytes)}
                              </strong>
                              <span>{t("status.resource.used")}</span>
                              <strong>
                                {formatBytes(readyResourceMemory!.usedBytes)}
                              </strong>
                              <span>{t("status.resource.free")}</span>
                              <strong>
                                {formatBytes(readyResourceMemory!.freeBytes)}
                              </strong>
                              <span>{t("status.resource.available")}</span>
                              <strong>
                                {formatBytes(
                                  readyResourceMemory!.availableBytes,
                                )}
                              </strong>
                              <span>{t("status.resource.cache")}</span>
                              <strong>
                                {formatBytes(readyResourceMemory!.cacheBytes)}
                              </strong>
                            </div>
                          </div>
                        </>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="statusbar-right">
                {/* 约定：右侧状态区中，AI 与传输指示必须固定在最左侧，后续新增状态信息不得插入其前方。 */}
                <span className="statusbar-ai-chip">
                  {t("status.ai")} {activeAiConfigName || t("status.ai.unset")}
                </span>
                <div className="statusbar-transfer" aria-live="polite">
                  <button
                    type="button"
                    className={`statusbar-transfer-token ${transferHint.hasTransfer ? "active" : "idle"}`.trim()}
                    aria-label={
                      transferHint.hasTransfer
                        ? `${t("actions.upload")} ${transferHint.runningUploads} / ${t("actions.download")} ${transferHint.runningDownloads}`
                        : `${t("actions.upload")} / ${t("actions.download")}`
                    }
                    onClick={() => {
                      // 仅在存在运行任务时允许打开传输组件。
                      if (transferHint.hasTransfer) onOpenTransfersWidget();
                    }}
                  >
                    <FiRepeat />
                  </button>
                </div>
                <button
                  type="button"
                  className={`statusbar-security-chip ${
                    securityProvider === "embedded"
                      ? "weak"
                      : securityLocked
                        ? "locked"
                        : "unlocked"
                  }`.trim()}
                  onClick={onSecurityAction}
                  aria-label={
                    securityProvider === "embedded"
                      ? t("status.security.weakAction")
                      : securityLocked
                        ? t("status.security.lockedAction")
                        : t("status.security.unlockedAction")
                  }
                >
                  {securityProvider === "embedded" ? (
                    <FiUnlock />
                  ) : securityLocked ? (
                    <FiLock />
                  ) : (
                    <FiUnlock />
                  )}
                  <span>
                    {securityProvider === "embedded"
                      ? t("status.security.weak")
                      : securityLocked
                        ? t("status.security.locked")
                        : t("status.security.unlocked")}
                  </span>
                </button>
                <span className="statusbar-info-chip">
                  {t("status.window")} {stats.windowRows}x{stats.windowCols}
                </span>
                <span className="statusbar-info-chip">
                  {t("status.buffer")} {stats.bufferLines}
                </span>
                <button
                  type="button"
                  className="statusbar-link-chip"
                  aria-label="Issues"
                  onClick={() => {
                    void openUrl(FLUXTERM_ISSUES_URL);
                  }}
                >
                  <span>Issues</span>
                </button>
                <span className="statusbar-info-chip">
                  {formatDateTime(now, locale)}
                </span>
              </div>
            </div>
          </div>
        )}
      </footer>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              label: t("quickbar.command.edit"),
              icon: <FiEdit2 />,
              disabled: false,
              onClick: () => {
                setPendingFocusCommandId(contextMenu.commandId);
                onOpenManager();
                setContextMenu(null);
              },
            },
            {
              label: t("quickbar.command.delete"),
              icon: <FiTrash2 />,
              disabled: false,
              onClick: () => {
                onRemoveCommand(contextMenu.commandId);
                setContextMenu(null);
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}

      <Modal
        open={managerOpen}
        title={t("quickbar.manager.title")}
        closeLabel={t("actions.close")}
        onClose={onCloseManager}
      >
        <div className="quickbar-manager">
          <section className="qm-top">
            <Select
              value={selectedGroupId}
              options={managerGroupOptions}
              placeholder={t("quickbar.manager.selectGroup")}
              onChange={(value) => setSelectedGroupId(value || null)}
              aria-label={t("quickbar.manager.group")}
            />
            <Button variant="ghost" size="sm" onClick={handleAddGroup}>
              {t("quickbar.manager.addGroup")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                !selectedGroup || selectedGroup.id === DEFAULT_QUICKBAR_GROUP_ID
              }
              onClick={handleDeleteGroup}
            >
              {t("quickbar.manager.deleteGroup")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                !selectedGroup || selectedGroup.id === DEFAULT_QUICKBAR_GROUP_ID
              }
              onClick={handleRenameGroup}
            >
              {t("quickbar.manager.renameGroup")}
            </Button>
          </section>

          <section className="qm-left">
            <div className="qm-title">{t("quickbar.manager.commandList")}</div>
            <div
              className="qm-command-list"
              data-ui="quickbar-manager-command-list"
            >
              {previewGroupCommands.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-ui="quickbar-manager-command-item"
                  data-command-id={item.id}
                  className={`qm-command-item ${selectedCommandId === item.id ? "active" : ""} ${
                    draggingCommandId === item.id ? "dragging" : ""
                  } ${dragOverCommandId === item.id ? "drag-over" : ""}`.trim()}
                  onClick={() => {
                    if (suppressCommandClickRef.current === item.id) {
                      suppressCommandClickRef.current = null;
                      return;
                    }
                    setSelectedCommandId(item.id);
                  }}
                  onPointerDown={(event) =>
                    handleCommandPointerDown(event, item.id)
                  }
                >
                  <FiMenu className="qm-command-drag-handle" aria-hidden />
                  <span className="qm-command-label">
                    {resolveCommandLabel(item)}
                  </span>
                </button>
              ))}
              {!groupCommands.length && (
                <div className="qm-empty">
                  {t("quickbar.manager.emptyGroup")}
                </div>
              )}
            </div>
            <div className="qm-left-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={!selectedGroupId}
                onClick={handleAddCommand}
              >
                {t("quickbar.manager.addCommand")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!selectedCommandId}
                onClick={handleDeleteCommand}
              >
                {t("quickbar.manager.deleteCommand")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!selectedCommandId}
                onClick={handleCopyCommand}
              >
                {t("quickbar.manager.copyCommand")}
              </Button>
            </div>
          </section>

          <section className="qm-right">
            <div className="qm-title">{t("quickbar.manager.detail")}</div>
            {selectedCommand ? (
              <div className="qm-detail-form">
                <label>
                  <span>{t("quickbar.manager.commandLabel")}</span>
                  <input
                    ref={commandLabelInputRef}
                    value={selectedCommand.label}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) =>
                      onUpdateCommand(selectedCommand.id, {
                        label: event.target.value,
                      })
                    }
                    onBlur={(event) => {
                      if (event.target.value.trim()) return;
                      onUpdateCommand(selectedCommand.id, {
                        label: t("quickbar.manager.newLabel"),
                      });
                    }}
                  />
                </label>
                <label>
                  <span>{t("quickbar.manager.commandType")}</span>
                  <Select
                    value="sendText"
                    options={[
                      {
                        value: "sendText",
                        label: t("quickbar.manager.sendText"),
                      },
                    ]}
                    disabled
                    onChange={() => {}}
                    aria-label={t("quickbar.manager.commandType")}
                  />
                </label>
                <label>
                  <span>{t("quickbar.manager.commandText")}</span>
                  <textarea
                    value={selectedCommand.command}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) =>
                      onUpdateCommand(selectedCommand.id, {
                        command: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
            ) : (
              <div className="qm-empty">
                {t("quickbar.manager.noCommandSelected")}
              </div>
            )}
          </section>

          <section className="qm-bottom">
            <label className="qm-option">
              <input
                type="checkbox"
                autoComplete="off"
                checked={showGroupTitle}
                onChange={(event) =>
                  onShowGroupTitleChange(event.target.checked)
                }
              />
              <span>{t("quickbar.manager.showGroupTitle")}</span>
            </label>
          </section>
        </div>
      </Modal>

      <InputDialog
        open={groupDialogMode !== null}
        title={
          groupDialogMode === "add"
            ? t("quickbar.manager.addGroup")
            : t("quickbar.manager.renameGroup")
        }
        label={t("quickbar.manager.group")}
        placeholder={t("quickbar.manager.groupPlaceholder")}
        initialValue={
          groupDialogMode === "rename" ? (selectedGroup?.name ?? "") : ""
        }
        confirmText={t("actions.save")}
        cancelText={t("actions.cancel")}
        closeText={t("actions.close")}
        errorText={groupDialogError}
        onClose={() => {
          setGroupDialogMode(null);
          setGroupDialogError(null);
        }}
        onValueChange={() => setGroupDialogError(null)}
        onConfirm={(value) => {
          const name = value.trim();
          if (!name) {
            setGroupDialogError(t("quickbar.manager.groupNameRequired"));
            return;
          }
          if (groupDialogMode === "add") {
            // 新增分组失败时保留弹窗与输入内容，直接展示校验错误。
            const result = onAddGroup(name);
            if (!result.ok) {
              setGroupDialogError(t(result.errorKey));
              return;
            }
            if (result.id) {
              setSelectedGroupId(result.id);
              setSelectedCommandId(null);
            }
          } else if (groupDialogMode === "rename" && selectedGroup) {
            // 重命名分组失败时同样不关闭弹窗，便于用户直接修正名称。
            const result = onRenameGroup(selectedGroup.id, name);
            if (!result.ok) {
              setGroupDialogError(t(result.errorKey));
              return;
            }
          }
          setGroupDialogError(null);
          setGroupDialogMode(null);
        }}
      />

      <Modal
        open={!!deleteGroupPending}
        title={t("quickbar.manager.deleteGroup")}
        closeLabel={t("actions.close")}
        onClose={() => setDeleteGroupPendingId(null)}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteGroupPendingId(null)}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (!deleteGroupPending) return;
                onRemoveGroup(deleteGroupPending.id);
                setDeleteGroupPendingId(null);
              }}
            >
              {t("actions.remove")}
            </Button>
          </>
        }
      >
        <p className="qm-delete-confirm">
          {deleteGroupPending
            ? t("quickbar.manager.deleteGroupConfirm", {
                name: deleteGroupPending.name,
              })
            : ""}
        </p>
      </Modal>
    </>
  );
}
