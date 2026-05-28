/**
 * 快捷命令栏状态管理模块。
 * 职责：
 * 1. 读写 quickbar.json 配置文件。
 * 2. 管理快捷命令的分组（新增、重命名、删除、可见性切换）。
 * 3. 管理具体的命令项（新增、更新、删除）。
 * 4. 提供当前活动会话可见的命令视图。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { debug, warn } from "@/shared/logging/telemetry";
import type { Translate, TranslationKey } from "@/i18n";
import type {
  QuickBarConfig,
  QuickCommandGroup,
  QuickCommandItem,
} from "@/types";
import { getGlobalConfigDir, getQuickbarPath } from "@/shared/config/paths";
import { extractErrorMessage } from "@/shared/errors/appError";
import {
  DEFAULT_QUICKBAR_GROUP_ID,
  LEGACY_DEFAULT_QUICKBAR_GROUP_ID,
} from "@/constants/quickbar";
import { PERSISTENCE_SAVE_DEBOUNCE_MS } from "@/constants/persistence";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";

const defaultGroupId = DEFAULT_QUICKBAR_GROUP_ID;

/** 命令操作的原子返回结构。 */
type GroupMutationResult =
  | { ok: true; id?: string }
  | { ok: false; errorKey: TranslationKey };

/** useQuickBarState 返回的命令管理接口。 */
type UseQuickBarStateResult = {
  showGroupTitle: boolean;
  setShowGroupTitle: React.Dispatch<React.SetStateAction<boolean>>;
  groups: QuickCommandGroup[];
  commands: QuickCommandItem[];
  visibleGroupIds: string[];
  addGroup: (name: string) => GroupMutationResult;
  renameGroup: (groupId: string, name: string) => GroupMutationResult;
  removeGroup: (groupId: string) => void;
  toggleGroupVisible: (groupId: string) => void;
  addCommand: (payload: {
    label: string;
    command: string;
    groupId?: string | null;
  }) => string | null;
  updateCommand: (
    commandId: string,
    payload: Partial<QuickCommandItem>,
  ) => void;
  removeCommand: (commandId: string) => void;
  visibleCommands: Array<QuickCommandItem & { groupName: string }>;
};

/** 获取默认分组名。 */
function getDefaultGroupName(t: Translate) {
  return t("quickbar.group.default");
}

/** 快捷栏默认配置生产工厂。 */
function createDefaultQuickBarConfig(t: Translate): QuickBarConfig {
  return {
    version: 1,
    showGroupTitle: true,
    groups: [
      {
        id: defaultGroupId,
        name: getDefaultGroupName(t),
        order: 0,
        visible: true,
      },
    ],
    commands: [],
  };
}

/** 生成分组/命令唯一 ID。 */
function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const r = Math.floor(Math.random() * 16);
    const v = char === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isValidGroup(value: unknown): value is QuickCommandGroup {
  if (!value || typeof value !== "object") return false;
  const item = value as QuickCommandGroup;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.order === "number" &&
    typeof item.visible === "boolean"
  );
}

function isValidCommand(value: unknown): value is QuickCommandItem {
  if (!value || typeof value !== "object") return false;
  const item = value as QuickCommandItem;
  return (
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    typeof item.command === "string" &&
    typeof item.groupId === "string" &&
    (item.type === undefined || item.type === "sendText")
  );
}

function normalizeGroupName(name: string) {
  return name.trim().toLocaleLowerCase();
}

/** 判断分组名是否与现有分组重复。 */
function isDuplicateGroupName(
  groups: QuickCommandGroup[],
  name: string,
  excludeGroupId?: string,
) {
  const normalized = normalizeGroupName(name);
  return groups.some((group) => {
    if (excludeGroupId && group.id === excludeGroupId) return false;
    return normalizeGroupName(group.name) === normalized;
  });
}

/**
 * 快捷栏配置规范化。
 * 职责：
 * 1. 移除重复 ID 分组与命令。
 * 2. 确保默认分组始终存在。
 */
function normalizeConfig(value: unknown, t: Translate): QuickBarConfig {
  const defaultQuickBarConfig = createDefaultQuickBarConfig(t);
  if (!value || typeof value !== "object") {
    return defaultQuickBarConfig;
  }
  const parsed = value as Partial<QuickBarConfig>;
  const rawGroups = Array.isArray(parsed.groups)
    ? parsed.groups.filter(isValidGroup)
    : [];
  const dedupedGroups: QuickCommandGroup[] = [];
  const seenGroup = new Set<string>();
  rawGroups.forEach((group, index) => {
    const rawId = group.id.trim();
    const id =
      rawId === LEGACY_DEFAULT_QUICKBAR_GROUP_ID ? defaultGroupId : rawId;
    if (!id || seenGroup.has(id)) return;
    seenGroup.add(id);
    dedupedGroups.push({
      id,
      name:
        id === defaultGroupId
          ? getDefaultGroupName(t)
          : group.name.trim() || `Group ${index + 1}`,
      order: Number.isFinite(group.order) ? group.order : index,
      visible: group.visible,
    });
  });
  if (!dedupedGroups.some((group) => group.id === defaultGroupId)) {
    dedupedGroups.unshift({
      id: defaultGroupId,
      name: getDefaultGroupName(t),
      order: -1,
      visible: true,
    });
  }
  const sortedGroups = dedupedGroups
    .sort((a, b) => a.order - b.order)
    .map((group, index) => ({ ...group, order: index }));
  const allowedGroupIds = new Set(sortedGroups.map((group) => group.id));

  const rawCommands = Array.isArray(parsed.commands)
    ? parsed.commands.filter(isValidCommand)
    : [];
  const dedupedCommands: QuickCommandItem[] = [];
  const seenCommand = new Set<string>();
  rawCommands.forEach((item) => {
    if (seenCommand.has(item.id)) return;
    seenCommand.add(item.id);
    const nextGroupId =
      item.groupId === LEGACY_DEFAULT_QUICKBAR_GROUP_ID
        ? defaultGroupId
        : item.groupId;
    dedupedCommands.push({
      ...item,
      groupId: allowedGroupIds.has(nextGroupId) ? nextGroupId : defaultGroupId,
      type: "sendText",
    });
  });
  return {
    version: 1,
    showGroupTitle:
      typeof parsed.showGroupTitle === "boolean" ? parsed.showGroupTitle : true,
    groups: sortedGroups,
    commands: dedupedCommands,
  };
}

/** 快捷栏分组与命令状态管理。 */
export default function useQuickBarState(t: Translate): UseQuickBarStateResult {
  const defaultQuickBarConfig = useMemo(
    () => createDefaultQuickBarConfig(t),
    [t],
  );
  const [showGroupTitle, setShowGroupTitle] = useState(
    defaultQuickBarConfig.showGroupTitle ?? true,
  );
  const [groups, setGroups] = useState<QuickCommandGroup[]>(
    defaultQuickBarConfig.groups,
  );
  const [commands, setCommands] = useState<QuickCommandItem[]>(
    defaultQuickBarConfig.commands,
  );

  // 持久化辅助。
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const lastSavedConfigRef = useRef<string>("");

  /** 执行配置文件加载。 */
  const loadConfig = useCallback(async () => {
    try {
      const path = await getQuickbarPath();
      const existsFile = await exists(path);
      if (!existsFile) {
        loadedRef.current = true;
        void debug(
          JSON.stringify({
            event: "quickbar.load.skip",
            reason: "file-not-exists",
          }),
        );
        return;
      }
      const raw = await readTextFile(path);
      if (!raw) {
        loadedRef.current = true;
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizeConfig(parsed, t);
      setShowGroupTitle(normalized.showGroupTitle ?? true);
      setGroups(normalized.groups);
      setCommands(normalized.commands);
      void debug(
        JSON.stringify({
          event: "quickbar.loaded",
          groups: normalized.groups.length,
          commands: normalized.commands.length,
        }),
      );
    } catch (error) {
      void warn(
        JSON.stringify({
          event: "quickbar.load.failed",
          error: extractErrorMessage(error),
        }),
      );
    } finally {
      loadedRef.current = true;
    }
  }, [t]);

  /** 将最新配置落盘。 */
  async function saveConfig(payload: QuickBarConfig) {
    const dir = await getGlobalConfigDir();
    await mkdir(dir, { recursive: true });
    const path = await getQuickbarPath();
    await writeTextFile(path, JSON.stringify(payload, null, 2));
  }

  // 启动加载与语言跟随。
  useEffect(() => {
    const cancel = scheduleDeferredTask(() => {
      void loadConfig().catch(() => {});
    });
    return cancel;
  }, [loadConfig]);

  useEffect(() => {
    // 默认分组名称始终跟随当前语言切换。
    const cancel = scheduleDeferredTask(() => {
      setGroups((prev) =>
        prev.map((group) =>
          group.id === defaultGroupId
            ? { ...group, name: getDefaultGroupName(t) }
            : group,
        ),
      );
    });
    return cancel;
  }, [t]);

  // 防抖异步保存逻辑。
  useEffect(() => {
    if (!loadedRef.current) return;

    const currentConfig: QuickBarConfig = {
      version: 1,
      showGroupTitle,
      groups,
      commands,
    };

    const configStr = JSON.stringify(currentConfig);
    if (configStr === lastSavedConfigRef.current) {
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    void debug(
      JSON.stringify({
        event: "quickbar.save.scheduled",
        debounce: PERSISTENCE_SAVE_DEBOUNCE_MS,
      }),
    );

    saveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          await saveConfig(currentConfig);
          lastSavedConfigRef.current = configStr;
          void debug(JSON.stringify({ event: "quickbar.persisted" }));
        } catch (error) {
          void warn(
            JSON.stringify({
              event: "quickbar.save.failed",
              error: extractErrorMessage(error),
            }),
          );
        }
      })();
    }, PERSISTENCE_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [showGroupTitle, groups, commands]);

  /** 过滤出当前可见的分组 ID 列表。 */
  const visibleGroupIds = useMemo(
    () =>
      groups
        .filter((group) => group.visible)
        .sort((a, b) => a.order - b.order)
        .map((group) => group.id),
    [groups],
  );

  /** 过滤出当前可见的命令列表，并注入所属分组名。 */
  const visibleCommands = useMemo(() => {
    const groupNameById = new Map(
      groups.map((group) => [group.id, group.name]),
    );
    const visibleSet = new Set(visibleGroupIds);
    return commands
      .filter((item) => visibleSet.has(item.groupId))
      .map((item) => ({
        ...item,
        groupName:
          groupNameById.get(item.groupId) ??
          defaultQuickBarConfig.groups[0].name,
      }));
  }, [commands, defaultQuickBarConfig.groups, groups, visibleGroupIds]);

  /** 新增分组。 */
  function addGroup(name: string): GroupMutationResult {
    const trimmed = name.trim();
    if (!trimmed)
      return { ok: false, errorKey: "quickbar.manager.groupNameRequired" };
    if (isDuplicateGroupName(groups, trimmed))
      return { ok: false, errorKey: "quickbar.manager.groupNameDuplicate" };
    const id = createId();
    setGroups((prev) => [
      ...prev,
      { id, name: trimmed, order: prev.length, visible: false },
    ]);
    return { ok: true, id };
  }

  /** 分组重命名。 */
  function renameGroup(groupId: string, name: string): GroupMutationResult {
    const trimmed = name.trim();
    if (!trimmed)
      return { ok: false, errorKey: "quickbar.manager.groupNameRequired" };
    if (isDuplicateGroupName(groups, trimmed, groupId))
      return { ok: false, errorKey: "quickbar.manager.groupNameDuplicate" };
    setGroups((prev) =>
      prev.map((group) =>
        group.id === groupId ? { ...group, name: trimmed } : group,
      ),
    );
    return { ok: true };
  }

  /** 删除分组（默认分组禁止删除，命令会回退至默认分组）。 */
  function removeGroup(groupId: string) {
    if (groupId === defaultGroupId) return;
    setGroups((prev) =>
      prev
        .filter((group) => group.id !== groupId)
        .map((group, index) => ({ ...group, order: index })),
    );
    setCommands((prev) =>
      prev.map((item) =>
        item.groupId === groupId ? { ...item, groupId: defaultGroupId } : item,
      ),
    );
  }

  function toggleGroupVisible(groupId: string) {
    setGroups((prev) =>
      prev.map((group) =>
        group.id === groupId ? { ...group, visible: !group.visible } : group,
      ),
    );
  }

  /** 新增快捷命令并返回新命令 ID。 */
  function addCommand(payload: {
    label: string;
    command: string;
    groupId?: string | null;
  }): string | null {
    const label = payload.label.trim();
    const command = payload.command;
    if (!label) return null;
    const groupIds = new Set(groups.map((group) => group.id));
    const groupId =
      payload.groupId && groupIds.has(payload.groupId)
        ? payload.groupId
        : defaultGroupId;
    const id = createId();
    setCommands((prev) => [
      ...prev,
      { id, label, command, groupId, type: "sendText" },
    ]);
    return id;
  }

  /** 更新快捷命令内容。 */
  function updateCommand(
    commandId: string,
    payload: Partial<QuickCommandItem>,
  ) {
    setCommands((prev) =>
      prev.map((item) => {
        if (item.id !== commandId) return item;
        const groupIds = new Set(groups.map((group) => group.id));
        const nextGroupId =
          payload.groupId && groupIds.has(payload.groupId)
            ? payload.groupId
            : item.groupId;
        return {
          ...item,
          label: payload.label !== undefined ? payload.label : item.label,
          command: payload.command ?? item.command,
          groupId: nextGroupId,
          type: "sendText",
        };
      }),
    );
  }

  function removeCommand(commandId: string) {
    setCommands((prev) => prev.filter((item) => item.id !== commandId));
  }

  return {
    showGroupTitle,
    setShowGroupTitle,
    groups,
    commands,
    visibleGroupIds,
    addGroup,
    renameGroup,
    removeGroup,
    toggleGroupVisible,
    addCommand,
    updateCommand,
    removeCommand,
    visibleCommands,
  };
}
