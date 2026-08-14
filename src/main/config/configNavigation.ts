import type { Translate } from "@/i18n";

/** 配置分区唯一键，作为菜单入口、侧栏导航和内容渲染的统一标识。 */
export type ConfigSectionKey =
  | "general"
  | "language"
  | "personalization"
  | "security"
  | "credentials"
  | "ai-settings"
  | "ai-provider-manage"
  | "ai-provider-quick"
  | "ai-provider-compat"
  | "session-settings"
  | "session-window"
  | "session-shell"
  | "app-directory";

export type ConfigSectionItem = {
  key: ConfigSectionKey;
  label: string;
};

export type ConfigMenuGroupKey = "app" | "ai" | "session";

export type ConfigMenuGroup = {
  key: ConfigMenuGroupKey;
  label: string;
  entries: ConfigSectionItem[];
};

export type ConfigNavigationModel = {
  menuEntries: ConfigSectionItem[];
  navEntries: ConfigSectionItem[];
};

/** 根据当前配置分区解析所属领域分组。 */
export function resolveConfigSectionGroup(
  section: ConfigSectionKey,
): ConfigMenuGroupKey {
  if (
    section === "ai-settings" ||
    section === "ai-provider-manage" ||
    section === "ai-provider-quick" ||
    section === "ai-provider-compat"
  ) {
    return "ai";
  }
  if (
    section === "session-settings" ||
    section === "session-window" ||
    section === "session-shell"
  ) {
    return "session";
  }
  return "app";
}

/** 根据当前入口返回配置弹窗侧栏中应展示的同领域导航项。 */
export function getScopedConfigNavEntries(
  navEntries: ConfigSectionItem[],
  activeSection: ConfigSectionKey,
): ConfigSectionItem[] {
  const group = resolveConfigSectionGroup(activeSection);
  if (group === "ai") {
    return navEntries.filter((entry) =>
      [
        "ai-settings",
        "ai-provider-quick",
        "ai-provider-compat",
        "ai-provider-manage",
      ].includes(entry.key),
    );
  }
  if (group === "session") {
    return navEntries.filter((entry) =>
      ["session-settings", "session-window", "session-shell"].includes(
        entry.key,
      ),
    );
  }
  return navEntries.filter((entry) =>
    [
      "general",
      "language",
      "personalization",
      "security",
      "credentials",
      "app-directory",
    ].includes(entry.key),
  );
}

/** 构建配置导航模型，作为标题栏菜单、macOS 菜单和配置弹窗侧栏的唯一来源。 */
export function buildConfigNavigation(t: Translate): ConfigNavigationModel {
  const labels: Record<ConfigSectionKey, string> = {
    general: t("config.section.general"),
    language: t("config.section.language"),
    personalization: t("config.section.personalization"),
    security: t("config.section.security"),
    credentials: t("config.section.credentials"),
    "ai-settings": t("config.section.aiSettings"),
    "ai-provider-manage": t("config.section.aiProviderManage"),
    "ai-provider-quick": t("config.section.aiProviderQuick"),
    "ai-provider-compat": t("config.section.aiProviderCompat"),
    "session-settings": t("config.section.sessionSettings"),
    "session-window": t("config.section.sessionWindow"),
    "session-shell": t("config.section.sessionShell"),
    "app-directory": t("config.section.appDirectory"),
  };

  return {
    menuEntries: [
      { key: "general", label: t("menu.config.app") },
      { key: "ai-settings", label: labels["ai-settings"] },
      { key: "session-settings", label: labels["session-settings"] },
    ],
    navEntries: [
      { key: "general", label: labels.general },
      { key: "language", label: labels.language },
      { key: "personalization", label: labels.personalization },
      { key: "security", label: labels.security },
      { key: "credentials", label: labels.credentials },
      { key: "ai-settings", label: labels["ai-settings"] },
      { key: "ai-provider-quick", label: labels["ai-provider-quick"] },
      { key: "ai-provider-compat", label: labels["ai-provider-compat"] },
      { key: "ai-provider-manage", label: labels["ai-provider-manage"] },
      { key: "session-settings", label: labels["session-settings"] },
      { key: "session-window", label: labels["session-window"] },
      { key: "session-shell", label: labels["session-shell"] },
      { key: "app-directory", label: labels["app-directory"] },
    ],
  };
}
