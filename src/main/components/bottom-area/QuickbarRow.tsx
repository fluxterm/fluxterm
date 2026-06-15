import { useEffect, useMemo, useRef, useState } from "react";
import { FiEdit2, FiSettings, FiTrash2 } from "react-icons/fi";
import type { Translate } from "@/i18n";
import type { QuickCommandGroup, QuickCommandItem } from "@/types";
import Button from "@/components/ui/button";
import ContextMenu from "@/components/ui/menu/ContextMenu";
import { resolveCommandLabel } from "@/main/components/bottom-area/quickbarUtils";

type QuickbarRowProps = {
  showGroupTitle: boolean;
  sortedGroups: QuickCommandGroup[];
  visibleGroupIds: Set<string>;
  commandsByGroup: Map<string, QuickCommandItem[]>;
  hasVisibleCommands: boolean;
  onOpenManager: () => void;
  onToggleGroupVisible: (groupId: string) => void;
  onRemoveCommand: (commandId: string) => void;
  onRunCommand: (command: string) => void;
  onFocusCommandInManager: (commandId: string) => void;
  t: Translate;
};

/** 底部快捷命令栏。 */
export default function QuickbarRow({
  showGroupTitle,
  sortedGroups,
  visibleGroupIds,
  commandsByGroup,
  hasVisibleCommands,
  onOpenManager,
  onToggleGroupVisible,
  onRemoveCommand,
  onRunCommand,
  onFocusCommandInManager,
  t,
}: QuickbarRowProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    commandId: string;
  } | null>(null);
  const [quickbarMenuOpen, setQuickbarMenuOpen] = useState(false);
  const quickbarMenuRef = useRef<HTMLDivElement | null>(null);

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

  const visibleGroups = useMemo(
    () => sortedGroups.filter((group) => visibleGroupIds.has(group.id)),
    [sortedGroups, visibleGroupIds],
  );

  return (
    <>
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
                  <label key={group.id} className="quickbar-menu-group-item">
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
              visibleGroups.map((group) => {
                const groupCommandsForBar = commandsByGroup.get(group.id) ?? [];
                if (!groupCommandsForBar.length) return null;
                return (
                  <div className="quickbar-group" key={group.id}>
                    {showGroupTitle && (
                      <span className="quickbar-group-name">{group.name}</span>
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
                          {resolveCommandLabel(item, t)}
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
                onFocusCommandInManager(contextMenu.commandId);
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
    </>
  );
}
