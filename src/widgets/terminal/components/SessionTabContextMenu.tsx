/**
 * 区域工作区栏中的会话菜单。
 * 这里的关闭类语义都以“当前区域内的会话列表”为作用域。
 */
import {
  FiChevronsRight,
  FiColumns,
  FiCornerDownRight,
  FiFolder,
  FiFolderPlus,
  FiMoreHorizontal,
  FiMinusCircle,
  FiRefreshCw,
  FiSave,
  FiTrash2,
  FiXCircle,
} from "react-icons/fi";
import ContextMenu from "@/components/ui/menu/ContextMenu";
import type { Translate } from "@/i18n";
import type { SessionGroup } from "@/types";
import { DEFAULT_SESSION_GROUP_ID } from "@/constants/sessionGroups";

type SessionTabContextMenuProps = {
  x: number;
  y: number;
  onClose: () => void;
  onReconnect: () => void;
  onSave: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  showReconnect?: boolean;
  showSave?: boolean;
  showSplit?: boolean;
  onCloseCurrent: () => void;
  onCloseAll?: (() => void) | null;
  onCloseOthers?: (() => void) | null;
  onCloseRight?: (() => void) | null;
  sessionGroups: SessionGroup[];
  activeGroupId: string;
  onMoveToGroup: (groupId: string) => void;
  onCreateGroup: () => void;
  onOpenMoreGroups: () => void;
  t: Translate;
};

const MAX_VISIBLE_CUSTOM_GROUPS = 3;

/** 标签右键菜单。 */
export default function SessionTabContextMenu({
  x,
  y,
  onClose,
  onReconnect,
  onSave,
  onSplitHorizontal,
  onSplitVertical,
  showReconnect = true,
  showSave = true,
  showSplit = true,
  onCloseCurrent,
  onCloseAll,
  onCloseOthers,
  onCloseRight,
  sessionGroups,
  activeGroupId,
  onMoveToGroup,
  onCreateGroup,
  onOpenMoreGroups,
  t,
}: SessionTabContextMenuProps) {
  const defaultGroup = sessionGroups.find(
    (group) => group.id === DEFAULT_SESSION_GROUP_ID,
  );
  const customGroups = sessionGroups.filter(
    (group) => group.id !== DEFAULT_SESSION_GROUP_ID,
  );
  const visibleGroups = [
    ...(defaultGroup ? [defaultGroup] : []),
    ...customGroups.slice(0, MAX_VISIBLE_CUSTOM_GROUPS),
  ];
  const hasMoreGroups = customGroups.length > MAX_VISIBLE_CUSTOM_GROUPS;
  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        ...(showReconnect
          ? [
              {
                id: "reconnect",
                label: t("terminal.tabMenu.reconnect"),
                icon: <FiRefreshCw />,
                onClick: onReconnect,
              },
            ]
          : []),
        ...(showSave
          ? [
              {
                id: "save",
                label: t("terminal.tabMenu.save"),
                icon: <FiSave />,
                onClick: onSave,
              },
            ]
          : []),
        ...(showSplit
          ? [
              {
                id: "split-horizontal",
                label: t("terminal.tabMenu.splitHorizontal"),
                icon: <FiColumns />,
                onClick: onSplitHorizontal,
              },
              {
                id: "split-vertical",
                label: t("terminal.tabMenu.splitVertical"),
                icon: <FiCornerDownRight />,
                onClick: onSplitVertical,
              },
            ]
          : []),
        {
          id: "group-create",
          label: t("terminal.tabMenu.group.create"),
          icon: <FiFolderPlus />,
          onClick: onCreateGroup,
        },
        ...visibleGroups.map((group) => ({
          id: `group-${group.id}`,
          label:
            group.id === DEFAULT_SESSION_GROUP_ID
              ? t("terminal.tabMenu.group.default")
              : t("terminal.tabMenu.group.join", { name: group.name }),
          icon: <FiFolder />,
          disabled: group.id === activeGroupId,
          onClick: () => onMoveToGroup(group.id),
        })),
        ...(hasMoreGroups
          ? [
              {
                id: "group-more",
                label: t("terminal.tabMenu.group.more"),
                icon: <FiMoreHorizontal />,
                onClick: onOpenMoreGroups,
              },
            ]
          : []),
        {
          id: "close-current",
          label: t("terminal.tabMenu.close"),
          icon: <FiXCircle />,
          danger: true,
          onClick: onCloseCurrent,
        },
        ...(onCloseAll
          ? [
              {
                id: "close-all",
                label: t("terminal.tabMenu.closeAll"),
                icon: <FiTrash2 />,
                danger: true,
                onClick: onCloseAll,
              },
            ]
          : []),
        ...(onCloseOthers
          ? [
              {
                id: "close-others",
                label: t("terminal.tabMenu.closeOthers"),
                icon: <FiMinusCircle />,
                onClick: onCloseOthers,
              },
            ]
          : []),
        ...(onCloseRight
          ? [
              {
                id: "close-right",
                label: t("terminal.tabMenu.closeRight"),
                icon: <FiChevronsRight />,
                onClick: onCloseRight,
              },
            ]
          : []),
      ]}
    />
  );
}
