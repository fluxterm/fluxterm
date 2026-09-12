/** 顶部菜单栏组件，用于布局折叠与个性化入口，支持下拉子菜单与全局点击关闭。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { Translate } from "@/i18n";
import type { WidgetSide } from "@/layout/types";
import type { SubAppId, SubAppRuntimeStatus } from "@/subapps/types";
import Button from "@/components/ui/button";
import {
  buildConfigNavigation,
  type ConfigSectionKey,
} from "@/main/config/configNavigation";

type MenuAction = {
  type?: "action";
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

type MenuCustom = {
  type?: "custom";
  id: string;
  render: React.ReactNode;
};

type MenuSectionTitle = {
  type: "section";
  id: string;
  label: string;
};

type MenuDivider = {
  type: "divider";
  id: string;
};

type MenuEntry = MenuAction | MenuCustom | MenuSectionTitle | MenuDivider;

type MenuItem = {
  id: string;
  label: string;
  actions?: MenuEntry[];
  onClick?: () => void;
  disabled?: boolean;
};

type MenusProps = {
  onOpenConfigSection: (section: ConfigSectionKey) => void;
  layoutCollapsed: Record<WidgetSide | "bottom", boolean>;
  onToggleCollapsed: (side: WidgetSide | "bottom") => void;
  onOpenAbout: () => void;
  footerVisibility?: { quickbar: boolean; statusbar: boolean };
  onToggleFooterPart?: (part: "quickbar" | "statusbar") => void;
  layoutDisabled?: boolean;
  subApps?: Array<{
    id: SubAppId;
    label: string;
    status: SubAppRuntimeStatus;
  }>;
  onLaunchSubApp?: (id: SubAppId) => void;
  onFocusSubApp?: (id: SubAppId) => void;
  onCloseSubApp?: (id: SubAppId) => void;
  t: Translate;
};

export default function Menus({
  onOpenConfigSection,
  layoutCollapsed,
  onToggleCollapsed,
  onOpenAbout,
  footerVisibility = { quickbar: true, statusbar: true },
  onToggleFooterPart,
  layoutDisabled,
  subApps = [],
  onLaunchSubApp,
  onFocusSubApp,
  onCloseSubApp,
  t,
}: MenusProps) {
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenus = useCallback(() => {
    setActiveMenuId(null);
  }, []);

  useEffect(() => {
    const handleGlobalClick = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        closeMenus();
      }
    };
    document.addEventListener("mousedown", handleGlobalClick);
    return () => {
      document.removeEventListener("mousedown", handleGlobalClick);
    };
  }, [closeMenus]);

  const menuItems = useMemo<MenuItem[]>(() => {
    const configNavigation = buildConfigNavigation(t);
    const launchableSubApps = subApps;
    const items: MenuItem[] = [
      {
        id: "config",
        label: t("menu.config"),
        // Windows/Web 自定义菜单里的“配置”入口需要与 macOS 的 useMacAppMenu.ts 保持同步，
        // 后续新增或调整配置分组时，两处都要一起修改，避免某个平台缺入口。
        actions: configNavigation.menuEntries.map((entry) => ({
          id: `config-${entry.key}`,
          label: entry.label,
          onClick: () => onOpenConfigSection(entry.key),
        })),
      },
      {
        id: "layout",
        label: t("menu.layout"),
        disabled: layoutDisabled,
        actions: [
          {
            type: "section",
            id: "widgets-section",
            label: t("menu.layout.sections.widgets"),
          },
          {
            id: "left-collapse",
            label: `${layoutCollapsed.left ? t("layout.expand") : t("layout.collapse")} ${t("layout.left")}`,
            onClick: () => onToggleCollapsed("left"),
            disabled: layoutDisabled,
          },
          {
            id: "right-collapse",
            label: `${layoutCollapsed.right ? t("layout.expand") : t("layout.collapse")} ${t("layout.right")}`,
            onClick: () => onToggleCollapsed("right"),
            disabled: layoutDisabled,
          },
          {
            id: "bottom-collapse",
            label: `${layoutCollapsed.bottom ? t("layout.expand") : t("layout.collapse")} ${t("layout.bottom")}`,
            onClick: () => onToggleCollapsed("bottom"),
            disabled: layoutDisabled,
          },
          { type: "divider", id: "layout-divider" },
          {
            type: "section",
            id: "footer-section",
            label: t("menu.layout.sections.footer"),
          },
          {
            id: "quickbar-visible",
            label: `${footerVisibility.quickbar ? t("layout.hide") : t("layout.show")} ${t("layout.footer.quickbar")}`,
            onClick: () => onToggleFooterPart?.("quickbar"),
            disabled: layoutDisabled,
          },
          {
            id: "statusbar-visible",
            label: `${footerVisibility.statusbar ? t("layout.hide") : t("layout.show")} ${t("layout.footer.statusbar")}`,
            onClick: () => onToggleFooterPart?.("statusbar"),
            disabled: layoutDisabled,
          },
        ],
      },
      {
        id: "about",
        label: t("menu.about"),
        onClick: onOpenAbout,
      },
    ];

    const launchableActions: MenuEntry[] = [
      {
        type: "section",
        id: "apps-launch-section",
        label: t("menu.apps.section.available"),
      },
      ...launchableSubApps.map((subApp) => ({
        id: `apps-launch-${subApp.id}`,
        label: t("menu.apps.open", { name: subApp.label }),
        onClick: () => onLaunchSubApp?.(subApp.id),
        disabled: subApp.status !== "idle",
      })),
      { type: "divider", id: "apps-divider" },
      {
        type: "section",
        id: "apps-running-section",
        label: t("menu.apps.section.running"),
      },
    ];

    const runningApps = subApps.filter((item) => item.status !== "idle");
    const runningActions: MenuEntry[] = runningApps.length
      ? runningApps.flatMap((subApp) => {
          const stateLabel =
            subApp.status === "ready"
              ? t("menu.apps.state.ready")
              : t("menu.apps.state.launching");
          return [
            {
              id: `apps-focus-${subApp.id}`,
              label: `${t("menu.apps.focus", { name: subApp.label })} · ${stateLabel}`,
              onClick: () => onFocusSubApp?.(subApp.id),
            },
            {
              id: `apps-close-${subApp.id}`,
              label: t("menu.apps.close", { name: subApp.label }),
              onClick: () => onCloseSubApp?.(subApp.id),
            },
          ];
        })
      : [
          {
            id: "apps-running-empty",
            label: t("menu.apps.noneRunning"),
            onClick: () => {},
            disabled: true,
          },
        ];

    items.splice(items.length - 1, 0, {
      id: "apps",
      label: t("menu.apps"),
      actions: [...launchableActions, ...runningActions],
    });

    return items;
  }, [
    onOpenConfigSection,
    layoutCollapsed.bottom,
    layoutCollapsed.left,
    layoutCollapsed.right,
    footerVisibility.quickbar,
    footerVisibility.statusbar,
    layoutDisabled,
    subApps,
    onLaunchSubApp,
    onFocusSubApp,
    onCloseSubApp,
    onOpenAbout,
    onToggleFooterPart,
    onToggleCollapsed,
    t,
  ]);

  return (
    <div className="menu-bar" ref={menuRef}>
      {menuItems.map((item) => {
        const hasSubmenu = !!item.actions?.length;
        const isActive = activeMenuId === item.id;
        const isDisabled = item.disabled;
        return (
          <div
            key={item.id}
            className={`menu-item ${isActive ? "active" : ""} ${isDisabled ? "disabled" : ""}`}
            data-tauri-drag-region="false"
            onClick={() => {
              if (isDisabled) return;
              if (hasSubmenu) {
                setActiveMenuId((prev) => (prev === item.id ? null : item.id));
              } else {
                item.onClick?.();
                closeMenus();
              }
            }}
          >
            <span>{item.label}</span>
            {hasSubmenu && isActive && (
              <div
                className="menu-sub"
                data-tauri-drag-region="false"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                {item.actions?.map((action) => {
                  if ("type" in action && action.type === "divider") {
                    return <div key={action.id} className="menu-sub-divider" />;
                  }
                  if ("type" in action && action.type === "section") {
                    return (
                      <div key={action.id} className="menu-sub-section-title">
                        {action.label}
                      </div>
                    );
                  }
                  if ("render" in action) {
                    return (
                      <div
                        key={action.id}
                        className="menu-sub-item menu-sub-custom"
                        data-tauri-drag-region="false"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {action.render}
                      </div>
                    );
                  }
                  return (
                    <Button
                      key={action.id}
                      className="menu-sub-item"
                      variant="ghost"
                      size="sm"
                      data-tauri-drag-region="false"
                      onClick={() => {
                        if (action.disabled) return;
                        action.onClick();
                        closeMenus();
                      }}
                      disabled={action.disabled}
                    >
                      {action.label}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
