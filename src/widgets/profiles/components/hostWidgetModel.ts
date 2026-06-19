/**
 * 主机面板展示模型工具。
 * 负责主机显示名、分组归集与列表排序，避免渲染组件隐式依赖原始数组顺序。
 */
import type { HostProfile } from "@/types";

export type HostProfileGroup = {
  label: string;
  items: HostProfile[];
};

const HOST_PROFILE_SORT_LOCALE = "zh-CN";
const HOST_PROFILE_SORT_OPTIONS: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: "base",
};

/** 解析主机在列表中的显示名。 */
export function resolveHostProfileDisplayName(profile: HostProfile) {
  return profile.name || profile.host || profile.id;
}

/** 比较两个 SSH 主机条目的显示顺序。 */
export function compareHostProfiles(left: HostProfile, right: HostProfile) {
  const nameResult = resolveHostProfileDisplayName(left).localeCompare(
    resolveHostProfileDisplayName(right),
    HOST_PROFILE_SORT_LOCALE,
    HOST_PROFILE_SORT_OPTIONS,
  );
  if (nameResult !== 0) return nameResult;
  return left.id.localeCompare(
    right.id,
    HOST_PROFILE_SORT_LOCALE,
    HOST_PROFILE_SORT_OPTIONS,
  );
}

/** 比较两个分组名的显示顺序。 */
export function compareHostGroupLabels(left: string, right: string) {
  return left.localeCompare(
    right,
    HOST_PROFILE_SORT_LOCALE,
    HOST_PROFILE_SORT_OPTIONS,
  );
}

/** 清理主机分组名，空白分组会被视为根级主机。 */
export function normalizeHostProfileGroupName(profile: HostProfile) {
  return profile.tags?.[0]?.trim() ?? "";
}

/** 构建自定义分组，并对分组和组内主机应用稳定展示排序。 */
export function buildHostProfileGroups(
  profiles: HostProfile[],
  sshGroups: string[],
) {
  const map = new Map<string, HostProfileGroup>();
  sshGroups.forEach((group) => {
    const label = group.trim();
    if (!label) return;
    map.set(label.toLowerCase(), { label, items: [] });
  });
  profiles.forEach((profile) => {
    const label = normalizeHostProfileGroupName(profile);
    if (!label) return;
    const key = label.toLowerCase();
    const group = map.get(key) ?? { label, items: [] };
    group.items.push(profile);
    map.set(key, group);
  });
  return Array.from(map.values())
    .map((group) => ({
      ...group,
      items: [...group.items].sort(compareHostProfiles),
    }))
    .sort((a, b) => compareHostGroupLabels(a.label, b.label));
}

/** 提取根级主机，并按主机显示名排序。 */
export function getRootHostProfiles(profiles: HostProfile[]) {
  return profiles
    .filter((profile) => !normalizeHostProfileGroupName(profile))
    .sort(compareHostProfiles);
}
