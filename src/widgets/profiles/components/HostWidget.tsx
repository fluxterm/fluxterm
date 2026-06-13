/**
 * 主机面板。
 * 负责 SSH 主机、本地 Shell 和分组树展示，并提供主机相关右键菜单操作。
 */
import { useCallback, useMemo, useState } from "react";
import {
  FiCopy,
  FiEdit2,
  FiEye,
  FiFolder,
  FiFolderPlus,
  FiLoader,
  FiPlus,
  FiRefreshCw,
  FiServer,
  FiTerminal,
  FiTrash2,
  FiX,
} from "react-icons/fi";
import type {
  HostProfile,
  LocalShellProfile,
  SshConnectStateMap,
} from "@/types";
import type { Translate } from "@/i18n";
import {
  LOCAL_SHELL_GROUP_VALUE,
  ROOT_PROFILE_GROUP_VALUE,
} from "@/constants/hostGroups";
import ContextMenu from "@/components/ui/menu/ContextMenu";
import type { ContextMenuItem } from "@/components/ui/menu/ContextMenu";
import Modal from "@/components/ui/modal/Modal";
import Button from "@/components/ui/button";
import InputDialog from "@/components/ui/InputDialog";
import PathViewDialog from "@/components/ui/PathViewDialog";
import Select from "@/components/ui/select";
import { resolveProfileIcon } from "@/features/profile/profileIcons";
import "@/widgets/profiles/components/HostWidget.css";

const GROUP_NAME_MAX_LENGTH = 12;

/** 主机面板需要的上层数据与操作。 */
type HostWidgetProps = {
  profiles: HostProfile[];
  sshGroups: string[];
  activeProfileId: string | null;
  sshConnectingProfiles: SshConnectStateMap;
  onPick: (id: string) => void;
  onConnectProfile: (profile: HostProfile) => void;
  onCancelSshConnectProfile: (profileId: string) => void;
  onOpenNewProfile: (defaultGroup?: string | null) => void;
  onImportOpenSshConfig: () => void;
  onOpenEditProfile: (profile: HostProfile) => void;
  onDuplicateProfile: (profile: HostProfile) => void;
  onRemoveProfile: (profile: HostProfile) => void;
  onAddGroup: (groupName: string) => boolean;
  onRenameGroup: (from: string, to: string) => Promise<boolean>;
  onRemoveGroup: (groupName: string) => Promise<boolean>;
  onMoveProfileToGroup: (
    profileId: string,
    targetGroup: string | null,
  ) => Promise<boolean>;
  localShells: LocalShellProfile[];
  onConnectLocalShell: (shell: LocalShellProfile) => void;
  onOpenLocalShellProfile: (shell: LocalShellProfile) => void;
  onRefreshLocalShells: () => Promise<void>;
  t: Translate;
};

/** 主机管理与分组列表。 */
export default function HostWidget({
  profiles,
  sshGroups,
  activeProfileId,
  sshConnectingProfiles,
  onPick,
  onConnectProfile,
  onCancelSshConnectProfile,
  onOpenNewProfile,
  onImportOpenSshConfig,
  onOpenEditProfile,
  onDuplicateProfile,
  onRemoveProfile,
  onAddGroup,
  onRenameGroup,
  onRemoveGroup,
  onMoveProfileToGroup,
  localShells,
  onConnectLocalShell,
  onOpenLocalShellProfile,
  onRefreshLocalShells,
  t,
}: HostWidgetProps) {
  const localShellKey = LOCAL_SHELL_GROUP_VALUE;
  const localShellLabel = t("host.shellGroup");
  // 自定义分组以“分组名 -> 主机列表”的结构整理，便于统一渲染和筛选。
  const customGroups = useMemo(() => {
    const map = new Map<string, { label: string; items: HostProfile[] }>();
    sshGroups.forEach((group) => {
      const label = group.trim();
      if (!label) return;
      map.set(label.toLowerCase(), { label, items: [] });
    });
    profiles.forEach((profile) => {
      const label = (profile.tags?.[0] ?? "").trim();
      if (!label) return;
      const key = label.toLowerCase();
      const group = map.get(key) ?? { label, items: [] };
      group.items.push(profile);
      map.set(key, group);
    });
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [profiles, sshGroups]);
  // 未设置分组的 SSH 会话直接挂在根级，不再包裹默认 SSH 分组。
  const rootProfiles = useMemo(
    () =>
      profiles.filter((profile) => {
        const tag = profile.tags?.[0]?.trim() ?? "";
        return !tag;
      }),
    [profiles],
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [query, setQuery] = useState("");
  // 所有右键菜单共用同一个浮层状态，点击不同目标时仅替换菜单项。
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  // 分组新增与重命名共用同一个输入对话框。
  const [groupDialog, setGroupDialog] = useState<{
    mode: "add" | "rename";
    sourceGroup?: string;
    initialValue?: string;
  } | null>(null);
  const [groupDialogError, setGroupDialogError] = useState<string | null>(null);
  // 本地 Shell 路径查看对话框。
  const [pathDialog, setPathDialog] = useState<{
    title: string;
    path: string;
  } | null>(null);
  // 删除非空分组前，先弹确认框提示主机会被移回根级。
  const [removeGroupDialog, setRemoveGroupDialog] = useState<{
    name: string;
    hostCount: number;
  } | null>(null);
  // 主机移动分组对话框及当前选中的目标分组值。
  const [moveDialog, setMoveDialog] = useState<HostProfile | null>(null);
  const [moveGroupValue, setMoveGroupValue] = useState<string>(
    ROOT_PROFILE_GROUP_VALUE,
  );

  const normalizedQuery = query.trim().toLowerCase();
  const queryActive = normalizedQuery.length > 0;
  /** 判断某个 SSH 主机是否命中搜索条件。 */
  const matchesProfile = useCallback(
    (profile: HostProfile) => {
      if (!queryActive) return true;
      const text =
        `${profile.name} ${profile.host} ${profile.username}`.toLowerCase();
      return text.includes(normalizedQuery);
    },
    [normalizedQuery, queryActive],
  );
  /** 判断分组标题是否命中搜索条件。 */
  const matchesGroup = useCallback(
    (group: string) =>
      queryActive && group.toLowerCase().includes(normalizedQuery),
    [normalizedQuery, queryActive],
  );
  /** 判断本地 Shell 是否命中搜索条件。 */
  const matchesShell = useCallback(
    (shell: LocalShellProfile) => {
      if (!queryActive) return true;
      const text = `${shell.label} ${shell.path}`.toLowerCase();
      return text.includes(normalizedQuery);
    },
    [normalizedQuery, queryActive],
  );

  const filteredLocalShells = useMemo(() => {
    if (!queryActive) return localShells;
    if (matchesGroup(localShellLabel)) return localShells;
    return localShells.filter(matchesShell);
  }, [localShellLabel, localShells, matchesGroup, matchesShell, queryActive]);

  // 搜索时优先保留命中的整组；如果只命中了组内部分主机，则收缩成过滤后的结果。
  const filteredGroups = useMemo(() => {
    if (!queryActive) return customGroups;
    return customGroups
      .map((group) => {
        if (matchesGroup(group.label)) return group;
        const matched = group.items.filter(matchesProfile);
        return matched.length ? { label: group.label, items: matched } : null;
      })
      .filter(
        (
          item,
        ): item is {
          label: string;
          items: HostProfile[];
        } => item !== null,
      );
  }, [customGroups, matchesGroup, matchesProfile, queryActive]);

  const showLocalShellGroup =
    !queryActive ||
    matchesGroup(localShellLabel) ||
    filteredLocalShells.length > 0;
  const filteredRootProfiles = useMemo(() => {
    if (!queryActive) return rootProfiles;
    return rootProfiles.filter(matchesProfile);
  }, [matchesProfile, queryActive, rootProfiles]);

  // 移动主机时的目标分组选项，根级通过保留值映射为“未分组”。
  const moveGroupOptions = useMemo(
    () => [
      { value: ROOT_PROFILE_GROUP_VALUE, label: t("host.ungrouped") },
      ...customGroups.map((group) => ({
        value: group.label,
        label: group.label,
      })),
    ],
    [customGroups, t],
  );

  const currentMoveGroupValue = useMemo(() => {
    if (!moveDialog) return ROOT_PROFILE_GROUP_VALUE;
    return moveDialog.tags?.[0]?.trim() || ROOT_PROFILE_GROUP_VALUE;
  }, [moveDialog]);

  /** 统计指定分组下当前包含的主机数量，用于删除确认提示。 */
  const getGroupHostCount = (groupName: string) =>
    profiles.filter(
      (profile) =>
        (profile.tags?.[0]?.trim().toLowerCase() ?? "") ===
        groupName.trim().toLowerCase(),
    ).length;

  /** 打开右键菜单，并阻止原生菜单继续冒泡。 */
  function openMenu(
    event: {
      preventDefault: () => void;
      stopPropagation: () => void;
      clientX: number;
      clientY: number;
    },
    items: ContextMenuItem[],
  ) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  /** 切换分组展开状态；空分组或不可展开项不处理。 */
  function toggleGroup(group: string, expandable: boolean) {
    if (!expandable) return;
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }

  /** 打开新增分组输入框，并关闭当前右键菜单。 */
  function openAddGroupDialog() {
    setMenu(null);
    setGroupDialogError(null);
    setGroupDialog({ mode: "add", initialValue: "" });
  }

  /** 校验分组名：不能为空，且长度不能超过限定上限。 */
  function validateGroupName(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return t("host.groupNameRequired");
    }
    if (trimmed.length > GROUP_NAME_MAX_LENGTH) {
      return t("host.groupNameTooLong", {
        max: GROUP_NAME_MAX_LENGTH,
      });
    }
    return null;
  }

  /** 根级空白区域右键菜单。 */
  function buildRootBlankMenuItems(): ContextMenuItem[] {
    return [
      {
        label: t("profile.menu.new"),
        icon: <FiPlus />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onOpenNewProfile();
        },
      },
      {
        label: t("host.addGroup"),
        icon: <FiFolderPlus />,
        disabled: false,
        onClick: openAddGroupDialog,
      },
      {
        label: t("host.menu.importOpenSshConfig"),
        icon: <FiServer />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onImportOpenSshConfig();
        },
      },
    ];
  }

  /** 本地 Shell 分组标题右键菜单。 */
  function buildLocalShellGroupMenuItems(): ContextMenuItem[] {
    return [
      {
        label: t("host.menu.rescanLocalShells"),
        icon: <FiRefreshCw />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          // 本地 Shell 安装状态可能在应用运行期间变化，这里提供主动重新发现入口。
          void onRefreshLocalShells();
        },
      },
      {
        label: t("host.menu.importOpenSshConfig"),
        icon: <FiServer />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onImportOpenSshConfig();
        },
      },
    ];
  }

  /** 单个本地 Shell 条目右键菜单。 */
  function buildLocalShellItemMenuItems(
    shell: LocalShellProfile,
  ): ContextMenuItem[] {
    return [
      {
        label: t("actions.settings"),
        icon: <FiEdit2 />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onOpenLocalShellProfile(shell);
        },
      },
      {
        label: t("host.menu.importOpenSshConfig"),
        icon: <FiServer />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onImportOpenSshConfig();
        },
      },
      {
        label: t("host.addGroup"),
        icon: <FiFolderPlus />,
        disabled: false,
        onClick: openAddGroupDialog,
      },
      {
        label: t("host.menu.viewShellPath"),
        icon: <FiEye />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          setPathDialog({
            title: t("host.pathDialogTitle", {
              name: shell.label,
            }),
            path: shell.path,
          });
        },
      },
    ];
  }

  /** 自定义分组标题右键菜单。 */
  function buildCustomGroupMenuItems(groupLabel: string): ContextMenuItem[] {
    return [
      {
        label: t("profile.menu.new"),
        icon: <FiPlus />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onOpenNewProfile(groupLabel);
        },
      },
      {
        label: t("host.addGroup"),
        icon: <FiFolderPlus />,
        disabled: false,
        onClick: openAddGroupDialog,
      },
      {
        label: t("host.menu.renameGroup"),
        icon: <FiEdit2 />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          setGroupDialog({
            mode: "rename",
            sourceGroup: groupLabel,
            initialValue: groupLabel,
          });
        },
      },
      {
        label: t("host.menu.deleteGroup"),
        icon: <FiTrash2 />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          const hostCount = getGroupHostCount(groupLabel);
          if (hostCount === 0) {
            onRemoveGroup(groupLabel).catch(() => {});
            return;
          }
          setRemoveGroupDialog({ name: groupLabel, hostCount });
        },
      },
    ];
  }

  /** 分组内 SSH 主机右键菜单。 */
  function buildGroupedProfileMenuItems(
    profile: HostProfile,
  ): ContextMenuItem[] {
    return [
      {
        label: t("host.addGroup"),
        icon: <FiFolderPlus />,
        disabled: false,
        onClick: openAddGroupDialog,
      },
      {
        label: t("profile.menu.edit"),
        icon: <FiEdit2 />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onOpenEditProfile(profile);
        },
      },
      {
        label: t("profile.menu.copy"),
        icon: <FiCopy />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onDuplicateProfile(profile);
        },
      },
      {
        label: t("host.menu.moveTo"),
        icon: <FiFolder />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          setMoveDialog(profile);
          setMoveGroupValue(
            profile.tags?.[0]?.trim() || ROOT_PROFILE_GROUP_VALUE,
          );
        },
      },
      {
        label: t("profile.menu.delete"),
        icon: <FiTrash2 />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onRemoveProfile(profile);
        },
      },
    ];
  }

  /** 根级 SSH 主机右键菜单。 */
  function buildRootProfileMenuItems(profile: HostProfile): ContextMenuItem[] {
    return [
      {
        label: t("host.addGroup"),
        icon: <FiFolderPlus />,
        disabled: false,
        onClick: openAddGroupDialog,
      },
      {
        label: t("profile.menu.edit"),
        icon: <FiEdit2 />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onOpenEditProfile(profile);
        },
      },
      {
        label: t("profile.menu.copy"),
        icon: <FiCopy />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onDuplicateProfile(profile);
        },
      },
      {
        label: t("host.menu.moveTo"),
        icon: <FiFolder />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          setMoveDialog(profile);
          setMoveGroupValue(
            profile.tags?.[0]?.trim() || ROOT_PROFILE_GROUP_VALUE,
          );
        },
      },
      {
        label: t("profile.menu.delete"),
        icon: <FiTrash2 />,
        disabled: false,
        onClick: () => {
          setMenu(null);
          onRemoveProfile(profile);
        },
      },
    ];
  }

  function renderConnectingChip(profileId: string) {
    if (!sshConnectingProfiles[profileId]) return null;
    return (
      <span className="host-connecting-chip">
        <FiLoader className="host-connecting-icon" />
        <span
          className="host-connecting-cancel"
          role="button"
          aria-label={t("actions.cancel")}
          title={t("actions.cancel")}
          tabIndex={0}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onCancelSshConnectProfile(profileId);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onCancelSshConnectProfile(profileId);
          }}
        >
          <FiX />
        </span>
      </span>
    );
  }

  function renderProfileIcon(profile: HostProfile) {
    const Icon = resolveProfileIcon(profile.iconKey);
    return <Icon className="host-row-icon" />;
  }

  return (
    <div className="host-widget">
      <div className="host-list">
        <div className="host-list-header">
          <input
            className="host-search"
            placeholder={t("host.searchPlaceholder")}
            value={query}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          className="host-list-body"
          onContextMenu={(event) => {
            openMenu(event, buildRootBlankMenuItems());
          }}
        >
          {showLocalShellGroup && (
            <div key={localShellKey} className="host-group">
              <Button
                className={`host-group-title ${
                  filteredLocalShells.length > 0 &&
                  expandedGroups.has(localShellKey)
                    ? "expanded"
                    : ""
                }`}
                variant="ghost"
                size="sm"
                onContextMenu={(event) =>
                  openMenu(event, buildLocalShellGroupMenuItems())
                }
                onClick={() =>
                  toggleGroup(localShellKey, filteredLocalShells.length > 0)
                }
              >
                <span className="host-row-label">
                  <FiFolder className="host-row-icon" />
                  <span>{localShellLabel}</span>
                </span>
                <em>{filteredLocalShells.length}</em>
              </Button>
              {(queryActive || expandedGroups.has(localShellKey)) && (
                <div className="host-group-list host-group-list--nested">
                  {filteredLocalShells.map((shell) => (
                    <Button
                      key={shell.id}
                      variant="ghost"
                      size="sm"
                      onContextMenu={(event) =>
                        openMenu(event, buildLocalShellItemMenuItems(shell))
                      }
                      onDoubleClick={() => onConnectLocalShell(shell)}
                    >
                      <span className="host-row-label">
                        <FiTerminal className="host-row-icon" />
                        <span>{shell.label}</span>
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
          {filteredGroups.map((group) => (
            <div key={group.label} className="host-group">
              <Button
                className={`host-group-title ${
                  group.items.length > 0 && expandedGroups.has(group.label)
                    ? "expanded"
                    : ""
                }`}
                variant="ghost"
                size="sm"
                onContextMenu={(event) =>
                  openMenu(event, buildCustomGroupMenuItems(group.label))
                }
                onClick={() => toggleGroup(group.label, group.items.length > 0)}
              >
                <span className="host-row-label">
                  <FiFolder className="host-row-icon" />
                  <span>{group.label}</span>
                </span>
                <em>{group.items.length}</em>
              </Button>
              {(queryActive || expandedGroups.has(group.label)) && (
                <div className="host-group-list host-group-list--nested">
                  {group.items.map((profile) => (
                    <Button
                      key={profile.id}
                      className={profile.id === activeProfileId ? "active" : ""}
                      variant="ghost"
                      size="sm"
                      onContextMenu={(event) =>
                        openMenu(event, buildGroupedProfileMenuItems(profile))
                      }
                      onClick={() => onPick(profile.id)}
                      onDoubleClick={() => {
                        if (sshConnectingProfiles[profile.id]) return;
                        onConnectProfile(profile);
                      }}
                    >
                      <span className="host-row-label">
                        {renderProfileIcon(profile)}
                        <span>{profile.name || profile.host}</span>
                        {renderConnectingChip(profile.id)}
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {filteredRootProfiles.map((profile) => (
            <Button
              key={profile.id}
              className={`host-root-profile${
                profile.id === activeProfileId ? " active" : ""
              }`}
              variant="ghost"
              size="sm"
              onContextMenu={(event) =>
                openMenu(event, buildRootProfileMenuItems(profile))
              }
              onClick={() => onPick(profile.id)}
              onDoubleClick={() => {
                if (sshConnectingProfiles[profile.id]) return;
                onConnectProfile(profile);
              }}
            >
              {/* 根级会话固定排在所有分组之后。 */}
              <span className="host-row-label">
                {renderProfileIcon(profile)}
                <span>{profile.name || profile.host}</span>
                {renderConnectingChip(profile.id)}
              </span>
            </Button>
          ))}
          {!profiles.length && localShells.length === 0 && (
            <div className="empty-hint">{t("host.empty")}</div>
          )}
          {(profiles.length > 0 ||
            localShells.length > 0 ||
            customGroups.length > 0) &&
            !filteredRootProfiles.length &&
            !filteredGroups.length &&
            !filteredLocalShells.length && (
              <div className="empty-hint">{t("host.noMatch")}</div>
            )}
        </div>
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={menu.items}
            onClose={() => setMenu(null)}
          />
        )}
        {groupDialog && (
          <InputDialog
            open
            title={
              groupDialog.mode === "add"
                ? t("host.addGroup")
                : t("host.menu.renameGroup")
            }
            label={t("profile.form.group")}
            placeholder={t("profile.placeholder.group")}
            initialValue={groupDialog.initialValue ?? ""}
            maxLength={GROUP_NAME_MAX_LENGTH}
            confirmText={t("actions.save")}
            cancelText={t("actions.cancel")}
            closeText={t("actions.close")}
            errorText={groupDialogError}
            onClose={() => {
              setGroupDialog(null);
              setGroupDialogError(null);
            }}
            onValueChange={() => setGroupDialogError(null)}
            onConfirm={(value) => {
              const errorText = validateGroupName(value);
              if (errorText) {
                setGroupDialogError(errorText);
                return;
              }
              if (groupDialog.mode === "add") {
                if (!onAddGroup(value)) {
                  setGroupDialogError(t("host.groupNameDuplicate"));
                  return;
                }
                setGroupDialog(null);
                setGroupDialogError(null);
                return;
              }
              if (
                !groupDialog.sourceGroup ||
                value === groupDialog.sourceGroup
              ) {
                setGroupDialog(null);
                setGroupDialogError(null);
                return;
              }
              onRenameGroup(groupDialog.sourceGroup, value)
                .then((ok) => {
                  if (!ok) {
                    setGroupDialogError(t("host.groupNameDuplicate"));
                    return;
                  }
                  setGroupDialogError(null);
                  setGroupDialog(null);
                })
                .catch(() => {});
            }}
          />
        )}
        {pathDialog && (
          <PathViewDialog
            open
            title={pathDialog.title}
            path={pathDialog.path}
            copyText={t("actions.copy")}
            copiedText={t("actions.copied")}
            closeText={t("actions.close")}
            onClose={() => setPathDialog(null)}
          />
        )}
        {moveDialog && (
          <Modal
            open
            title={t("host.moveDialogTitle")}
            closeLabel={t("actions.close")}
            bodyClassName="host-move-modal-body"
            onClose={() => setMoveDialog(null)}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMoveDialog(null)}
                >
                  {t("actions.cancel")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onMoveProfileToGroup(
                      moveDialog.id,
                      moveGroupValue === ROOT_PROFILE_GROUP_VALUE
                        ? null
                        : moveGroupValue,
                    )
                      .then(() => setMoveDialog(null))
                      .catch(() => {});
                  }}
                >
                  {t("actions.save")}
                </Button>
              </>
            }
          >
            <div className="host-move-dialog">
              <label>{t("host.moveTargetLabel")}</label>
              <Select
                value={moveGroupValue}
                options={moveGroupOptions.map((item) => ({
                  ...item,
                  disabled: item.value === currentMoveGroupValue,
                }))}
                onChange={(value) => setMoveGroupValue(value)}
                aria-label={t("host.moveTargetLabel")}
              />
            </div>
          </Modal>
        )}
        {removeGroupDialog && (
          <Modal
            open
            title={t("host.deleteGroupTitle")}
            closeLabel={t("actions.close")}
            bodyClassName="host-remove-group-modal-body"
            onClose={() => setRemoveGroupDialog(null)}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoveGroupDialog(null)}
                >
                  {t("actions.cancel")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onRemoveGroup(removeGroupDialog.name)
                      .then(() => setRemoveGroupDialog(null))
                      .catch(() => {});
                  }}
                >
                  {t("actions.remove")}
                </Button>
              </>
            }
          >
            <div className="host-remove-group-dialog">
              <p>
                {t("host.deleteGroupConfirm", {
                  name: removeGroupDialog.name,
                })}
              </p>
              <p>
                {t("host.deleteGroupHint", {
                  target: t("host.ungrouped"),
                  count: removeGroupDialog.hostCount,
                })}
              </p>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}
