import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { error as logError } from "@/shared/logging/telemetry";
import type { Translate } from "@/i18n";
import type { SubAppId, SubAppRuntimeStatus } from "@/subapps/types";
import { isMacOS } from "@/utils/platform";
import { extractErrorMessage } from "@/shared/errors/appError";
import {
  buildConfigNavigation,
  type ConfigSectionKey,
} from "@/main/config/configNavigation";

type UseMacAppMenuOptions = {
  layoutCollapsed: Record<"left" | "right" | "bottom", boolean>;
  onToggleCollapsed: (side: "left" | "right" | "bottom") => void;
  footerVisibility?: { quickbar: boolean; statusbar: boolean };
  onToggleFooterPart?: (part: "quickbar" | "statusbar") => void;
  onOpenConfigSection: (section: ConfigSectionKey) => void;
  subApps?: Array<{
    id: SubAppId;
    label: string;
    status: SubAppRuntimeStatus;
  }>;
  onLaunchSubApp?: (id: SubAppId) => void;
  onFocusSubApp?: (id: SubAppId) => void;
  onCloseSubApp?: (id: SubAppId) => void;
  onOpenAbout: () => void;
  t: Translate;
};

async function createAppMenu({
  appName,
  t,
  onOpenAbout,
}: {
  appName: string;
  t: Translate;
  onOpenAbout: () => void;
}) {
  return Submenu.new({
    id: "app-menu",
    text: appName,
    items: [
      await MenuItem.new({
        id: "app-about",
        text: t("menu.app.about"),
        action: onOpenAbout,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Quit" }),
    ],
  });
}

async function createLayoutMenu(
  layoutCollapsed: Record<"left" | "right" | "bottom", boolean>,
  onToggleCollapsed: (side: "left" | "right" | "bottom") => void,
  footerVisibility: { quickbar: boolean; statusbar: boolean },
  onToggleFooterPart: (part: "quickbar" | "statusbar") => void,
  t: Translate,
) {
  const widgetsMenu = await Submenu.new({
    id: "layout-menu-widgets",
    text: t("menu.layout.sections.widgets"),
    items: [
      await MenuItem.new({
        id: "layout-left",
        text: `${layoutCollapsed.left ? t("layout.expand") : t("layout.collapse")} ${t("layout.left")}`,
        action: () => onToggleCollapsed("left"),
      }),
      await MenuItem.new({
        id: "layout-right",
        text: `${layoutCollapsed.right ? t("layout.expand") : t("layout.collapse")} ${t("layout.right")}`,
        action: () => onToggleCollapsed("right"),
      }),
      await MenuItem.new({
        id: "layout-bottom",
        text: `${layoutCollapsed.bottom ? t("layout.expand") : t("layout.collapse")} ${t("layout.bottom")}`,
        action: () => onToggleCollapsed("bottom"),
      }),
    ],
  });
  const footerMenu = await Submenu.new({
    id: "layout-menu-footer",
    text: t("menu.layout.sections.footer"),
    items: [
      await MenuItem.new({
        id: "layout-quickbar-visible",
        text: `${footerVisibility.quickbar ? t("layout.hide") : t("layout.show")} ${t("layout.footer.quickbar")}`,
        action: () => onToggleFooterPart("quickbar"),
      }),
      await MenuItem.new({
        id: "layout-statusbar-visible",
        text: `${footerVisibility.statusbar ? t("layout.hide") : t("layout.show")} ${t("layout.footer.statusbar")}`,
        action: () => onToggleFooterPart("statusbar"),
      }),
    ],
  });
  return Submenu.new({
    id: "layout-menu",
    text: t("menu.layout"),
    items: [widgetsMenu, footerMenu],
  });
}

async function createConfigMenu(
  onOpenConfigSection: (section: ConfigSectionKey) => void,
  t: Translate,
) {
  const configNavigation = buildConfigNavigation(t);
  return Submenu.new({
    id: "config-menu",
    text: t("menu.config"),
    items: await Promise.all(
      configNavigation.menuEntries.map((entry) =>
        MenuItem.new({
          id: `config-${entry.key}`,
          text: entry.label,
          action: () => onOpenConfigSection(entry.key),
        }),
      ),
    ),
  });
}

async function createSubAppMenu({
  subApps,
  onLaunchSubApp,
  onFocusSubApp,
  onCloseSubApp,
  t,
}: {
  subApps: Array<{
    id: SubAppId;
    label: string;
    status: SubAppRuntimeStatus;
  }>;
  onLaunchSubApp: (id: SubAppId) => void;
  onFocusSubApp: (id: SubAppId) => void;
  onCloseSubApp: (id: SubAppId) => void;
  t: Translate;
}) {
  const launchableSubApps = subApps.filter((subApp) => subApp.id !== "rdp");
  const launchItems = await Promise.all(
    launchableSubApps.map((subApp) =>
      MenuItem.new({
        id: `apps-launch-${subApp.id}`,
        text: t("menu.apps.open", { name: subApp.label }),
        action: () => onLaunchSubApp(subApp.id),
        enabled: subApp.status === "idle",
      }),
    ),
  );

  const running = subApps.filter((item) => item.status !== "idle");
  const runningItems = running.length
    ? await Promise.all(
        running.flatMap((subApp) => [
          MenuItem.new({
            id: `apps-focus-${subApp.id}`,
            text: t("menu.apps.focus", { name: subApp.label }),
            action: () => onFocusSubApp(subApp.id),
          }),
          MenuItem.new({
            id: `apps-close-${subApp.id}`,
            text: t("menu.apps.close", { name: subApp.label }),
            action: () => onCloseSubApp(subApp.id),
          }),
        ]),
      )
    : [
        await MenuItem.new({
          id: "apps-running-empty",
          text: t("menu.apps.noneRunning"),
          enabled: false,
        }),
      ];

  return Submenu.new({
    id: "apps-menu",
    text: t("menu.apps"),
    items: [
      await MenuItem.new({
        id: "apps-section-available",
        text: t("menu.apps.section.available"),
        enabled: false,
      }),
      ...launchItems,
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "apps-section-running",
        text: t("menu.apps.section.running"),
        enabled: false,
      }),
      ...runningItems,
    ],
  });
}

async function createEditMenu(title: string) {
  return Submenu.new({
    id: "edit-menu",
    text: title,
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });
}

async function createWindowMenu(title: string) {
  return Submenu.new({
    id: "window-menu",
    text: title,
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
      await PredefinedMenuItem.new({ item: "CloseWindow" }),
    ],
  });
}

async function createHelpMenu(
  title: string,
  onOpenAbout: () => void,
  t: Translate,
) {
  return Submenu.new({
    id: "help-menu",
    text: title,
    items: [
      await MenuItem.new({
        id: "help-about",
        text: t("menu.help.about"),
        action: onOpenAbout,
      }),
    ],
  });
}

/** macOS 原生菜单适配。 */
export default function useMacAppMenu({
  layoutCollapsed,
  onToggleCollapsed,
  footerVisibility = { quickbar: true, statusbar: true },
  onToggleFooterPart,
  onOpenConfigSection,
  subApps = [],
  onLaunchSubApp,
  onFocusSubApp,
  onCloseSubApp,
  onOpenAbout,
  t,
}: UseMacAppMenuOptions) {
  useEffect(() => {
    if (!isMacOS() || !isTauri()) {
      return;
    }
    if (getCurrentWindow().label !== "main") {
      return;
    }

    let cancelled = false;

    const applyMenu = async () => {
      try {
        const appMenu = await createAppMenu({
          appName: t("app.name"),
          t,
          onOpenAbout,
        });
        // macOS 原生菜单的“配置”入口必须与 Windows/Web 的 Menus.tsx 保持同步，
        // 后续新增或调整配置分组时，两处都要一起修改，避免某个平台缺入口。
        const configMenu = await createConfigMenu(onOpenConfigSection, t);
        const layoutMenu = await createLayoutMenu(
          layoutCollapsed,
          onToggleCollapsed,
          footerVisibility,
          onToggleFooterPart ?? (() => {}),
          t,
        );
        const appsMenu =
          onLaunchSubApp && onFocusSubApp && onCloseSubApp
            ? await createSubAppMenu({
                subApps,
                onLaunchSubApp,
                onFocusSubApp,
                onCloseSubApp,
                t,
              })
            : null;
        const editMenu = await createEditMenu(t("menu.edit.title"));
        const windowMenu = await createWindowMenu(t("menu.window.title"));
        const helpMenu = await createHelpMenu(
          t("menu.help.title"),
          onOpenAbout,
          t,
        );

        const menu = await Menu.new();
        await menu.append([
          appMenu,
          configMenu,
          layoutMenu,
          ...(appsMenu ? [appsMenu] : []),
          editMenu,
          windowMenu,
          helpMenu,
        ]);

        if (cancelled) {
          await menu.close();
          return;
        }

        await helpMenu.setAsHelpMenuForNSApp();
        const previousMenu = await menu.setAsAppMenu();
        await windowMenu.setAsWindowsMenuForNSApp();

        if (previousMenu) {
          await previousMenu.close();
        }
      } catch (error) {
        void logError(
          JSON.stringify({
            event: "mac.app.menu.apply.failed",
            message: extractErrorMessage(error),
          }),
        );
      }
    };

    void applyMenu();

    return () => {
      cancelled = true;
    };
  }, [
    layoutCollapsed,
    onToggleCollapsed,
    footerVisibility,
    onToggleFooterPart,
    onOpenConfigSection,
    subApps,
    onLaunchSubApp,
    onFocusSubApp,
    onCloseSubApp,
    onOpenAbout,
    t,
  ]);
}
