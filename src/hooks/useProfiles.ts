/**
 * 主机配置状态管理。
 * 负责加载主机列表与分组、维护当前选中的主机条目，并封装主机与分组的持久化操作。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  importOpenSshConfig as importOpenSshConfigCommand,
  type OpensshImportSummary,
} from "@/features/profile/core/commands";
import {
  DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
  DEFAULT_TERMINAL_BELL_MODE,
} from "@/constants/terminalBell";
import type { HostProfile } from "@/types";

/** 主机配置状态 hook 的返回值。 */
type UseProfilesResult = {
  profiles: HostProfile[];
  sshGroups: string[];
  activeProfileId: string | null;
  editingProfile: HostProfile;
  defaultProfile: HostProfile;
  pickProfile: (profileId: string) => void;
  saveProfile: (profile: HostProfile) => Promise<HostProfile>;
  duplicateProfile: (
    profile: HostProfile,
    copySuffix: string,
  ) => Promise<HostProfile>;
  removeProfile: (profileId: string) => Promise<void>;
  reloadProfiles: () => Promise<void>;
  importOpenSshConfig: () => Promise<OpensshImportSummary>;
  addGroup: (groupName: string) => boolean;
  renameGroup: (from: string, to: string) => Promise<boolean>;
  removeGroup: (groupName: string) => Promise<boolean>;
  moveProfileToGroup: (
    profileId: string,
    targetGroup: string | null,
  ) => Promise<boolean>;
};

/** 新建主机表单使用的空白默认值。 */
const defaultProfile: HostProfile = {
  id: "",
  name: "",
  iconKey: null,
  host: "",
  port: 22,
  username: "",
  authType: "password",
  privateKeyPath: null,
  privateKeyPassphraseRef: null,
  passwordRef: null,
  knownHost: null,
  proxyMode: "direct",
  proxyConfig: null,
  jumpProfileIds: null,
  tags: null,
  wordSeparators: null,
  bellMode: DEFAULT_TERMINAL_BELL_MODE,
  bellCooldownMs: DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
};

const PROFILE_NAME_MAX_LENGTH = 14;

/** 统一清理分组名的首尾空白，避免分组展示与持久化出现幽灵差异。 */
function normalizeGroupName(value: string) {
  return value.trim();
}

/** 为复制出的主机生成可直接保存的名称，并遵守后端名称长度限制。 */
function buildDuplicateProfileName(profile: HostProfile, copySuffix: string) {
  const fallbackName = profile.name || profile.host || copySuffix;
  const baseChars = Array.from(fallbackName.trim());
  const suffixChars = Array.from(copySuffix.trim() || "Copy");
  const suffix = suffixChars.slice(0, PROFILE_NAME_MAX_LENGTH).join("");
  const separatorLength = baseChars.length && suffix.length ? 1 : 0;
  const baseLimit = Math.max(
    0,
    PROFILE_NAME_MAX_LENGTH - suffixChars.length - separatorLength,
  );
  const base = baseChars.slice(0, baseLimit).join("").trim();
  const name = [base, suffix].filter(Boolean).join(" ").trim();
  return Array.from(name).slice(0, PROFILE_NAME_MAX_LENGTH).join("");
}

/** 对分组列表做去重和排序，确保分组展示顺序稳定。 */
function dedupeGroups(values: string[]) {
  const seen = new Set<string>();
  const list: string[] = [];
  values.forEach((item) => {
    const normalized = normalizeGroupName(item);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(normalized);
  });
  return list.sort((a, b) => a.localeCompare(b));
}

/** 主机配置管理与持久化。 */
export default function useProfiles(): UseProfilesResult {
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [sshGroups, setSshGroups] = useState<string[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] =
    useState<HostProfile>(defaultProfile);

  /** 持久化分组列表，并先同步本地状态让 UI 立即响应。 */
  function persistGroups(nextGroups: string[]) {
    setSshGroups(nextGroups);
    return invoke<string[]>("profile_groups_save", { groups: nextGroups });
  }

  /** 加载主机配置与分组列表，并统一修正旧版本认证类型字段。 */
  async function loadProfiles() {
    const [list, persistedGroups] = await Promise.all([
      invoke<HostProfile[]>("profile_list"),
      invoke<string[]>("profile_groups_list"),
    ]);
    const normalized: HostProfile[] = list.map((profile) => {
      const rawAuth = profile.authType as string;
      const base = {
        ...profile,
        proxyMode: profile.proxyMode ?? "direct",
        proxyConfig: profile.proxyConfig ?? null,
        jumpProfileIds: profile.jumpProfileIds ?? null,
      } satisfies HostProfile;
      if (
        rawAuth === "key" ||
        rawAuth === "public_key" ||
        rawAuth === "publicKey"
      ) {
        return {
          ...base,
          authType: "privateKey",
        } satisfies HostProfile;
      }
      if (rawAuth === "agent") {
        return {
          ...base,
          authType: "privateKey",
        } satisfies HostProfile;
      }
      return base;
    });
    // 分组来源同时包含持久化分组和主机条目里已有的 tags，避免两边数据临时不一致。
    const discoveredGroups = normalized
      .map((item) => normalizeGroupName(item.tags?.[0] ?? ""))
      .filter(Boolean);
    setSshGroups(dedupeGroups([...persistedGroups, ...discoveredGroups]));
    setProfiles(normalized);
  }

  /** 重新加载主机配置与分组列表。 */
  async function reloadProfiles() {
    await loadProfiles();
  }

  /** 选择一个主机作为当前编辑对象。 */
  function pickProfile(profileId: string) {
    setActiveProfileId(profileId);
    const profile = profiles.find((item) => item.id === profileId);
    if (profile) {
      setEditingProfile(profile);
    }
  }

  /** 保存主机配置，并在保存成功后同步当前选中与编辑态。 */
  async function saveProfile(profile: HostProfile) {
    const saved = await invoke<HostProfile>("profile_save", { profile });
    const groupName = normalizeGroupName(saved.tags?.[0] ?? "");
    if (groupName) {
      const nextGroups = dedupeGroups([...sshGroups, groupName]);
      await persistGroups(nextGroups).catch(() => {});
    }
    const exists = profiles.some((item) => item.id === saved.id);
    const nextProfiles = exists
      ? profiles.map((item) => (item.id === saved.id ? saved : item))
      : profiles.concat(saved);
    setProfiles(nextProfiles);
    setActiveProfileId(saved.id);
    setEditingProfile(saved);
    return saved;
  }

  /** 复制主机配置并立即持久化为新条目。 */
  async function duplicateProfile(profile: HostProfile, copySuffix: string) {
    return await saveProfile({
      ...profile,
      id: "",
      name: buildDuplicateProfileName(profile, copySuffix),
      knownHost: null,
    });
  }

  /** 删除主机配置；如果删除的是当前选中项，则回退到列表中的下一项。 */
  async function removeProfile(profileId: string) {
    await invoke("profile_remove", { profileId });
    const next = profiles.filter((item) => item.id !== profileId);
    setProfiles(next);
    if (activeProfileId === profileId) {
      setActiveProfileId(next[0]?.id ?? null);
      setEditingProfile(next[0] ?? defaultProfile);
    }
  }

  /** 新增一个分组名；仅更新分组集合，不直接修改任何主机条目。 */
  function addGroup(groupName: string) {
    const normalized = normalizeGroupName(groupName);
    if (!normalized) return false;
    if (
      sshGroups.some((item) => item.toLowerCase() === normalized.toLowerCase())
    ) {
      return false;
    }
    const nextGroups = dedupeGroups([...sshGroups, normalized]);
    persistGroups(nextGroups).catch(() => {});
    return true;
  }

  /** 重命名分组，并批量更新引用该分组的主机配置。 */
  async function renameGroup(from: string, to: string) {
    const source = normalizeGroupName(from);
    const target = normalizeGroupName(to);
    if (!source || !target) return false;
    if (source.toLowerCase() === target.toLowerCase()) return false;
    if (sshGroups.some((item) => item.toLowerCase() === target.toLowerCase())) {
      return false;
    }

    const affected = profiles.filter(
      (item) =>
        normalizeGroupName(item.tags?.[0] ?? "").toLowerCase() ===
        source.toLowerCase(),
    );
    // 空分组只需要更新分组列表，不需要逐个保存主机。
    if (!affected.length) {
      const nextGroups = dedupeGroups(
        sshGroups.map((item) =>
          item.toLowerCase() === source.toLowerCase() ? target : item,
        ),
      );
      await persistGroups(nextGroups);
      return true;
    }
    try {
      const savedProfiles = await Promise.all(
        affected.map((item) =>
          invoke<HostProfile>("profile_save", {
            profile: { ...item, tags: [target] },
          }),
        ),
      );
      const map = new Map(
        savedProfiles.map((item) => [item.id, item] as const),
      );
      const nextGroups = dedupeGroups(
        sshGroups.map((item) =>
          item.toLowerCase() === source.toLowerCase() ? target : item,
        ),
      );
      await persistGroups(nextGroups);
      // 已保存的主机结果以返回值为准，避免继续依赖旧的本地副本。
      setProfiles((prev) => prev.map((item) => map.get(item.id) ?? item));
      setEditingProfile((prev) => map.get(prev.id) ?? prev);
      return true;
    } catch {
      return false;
    }
  }

  /** 删除分组，并将该分组下的主机回退到根级。 */
  async function removeGroup(groupName: string) {
    const target = normalizeGroupName(groupName);
    if (!target) return false;
    const targetKey = target.toLowerCase();
    const exists = sshGroups.some((item) => item.toLowerCase() === targetKey);
    if (!exists) return false;

    const affected = profiles.filter(
      (item) =>
        normalizeGroupName(item.tags?.[0] ?? "").toLowerCase() === targetKey,
    );
    // 没有关联主机时，只需要清理分组集合。
    if (!affected.length) {
      const nextGroups = sshGroups.filter(
        (item) => item.toLowerCase() !== targetKey,
      );
      await persistGroups(nextGroups);
      return true;
    }

    try {
      const savedProfiles = await Promise.all(
        affected.map((item) =>
          invoke<HostProfile>("profile_save", {
            profile: { ...item, tags: null },
          }),
        ),
      );
      const map = new Map(
        savedProfiles.map((item) => [item.id, item] as const),
      );
      const nextGroups = sshGroups.filter(
        (item) => item.toLowerCase() !== targetKey,
      );
      await persistGroups(nextGroups);
      // 被移出分组的主机会以 tags = null 的最新结果回写到列表和编辑态。
      setProfiles((prev) => prev.map((item) => map.get(item.id) ?? item));
      setEditingProfile((prev) => map.get(prev.id) ?? prev);
      return true;
    } catch {
      return false;
    }
  }

  /** 将单个主机移动到目标分组；传入空值时表示移动回根级。 */
  async function moveProfileToGroup(
    profileId: string,
    targetGroup: string | null,
  ) {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return false;
    const nextGroup = normalizeGroupName(targetGroup ?? "");
    const payload: HostProfile = {
      ...profile,
      tags: nextGroup ? [nextGroup] : null,
    };
    try {
      const saved = await invoke<HostProfile>("profile_save", {
        profile: payload,
      });
      if (nextGroup) {
        const nextGroups = dedupeGroups([...sshGroups, nextGroup]);
        await persistGroups(nextGroups);
      }
      setProfiles((prev) =>
        prev.map((item) => (item.id === saved.id ? saved : item)),
      );
      setEditingProfile((prev) => (prev.id === saved.id ? saved : prev));
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    // 初始仅加载数据，不再默认选中第一个主机，避免列表在进入时出现预设高亮。
    queueMicrotask(() => {
      void loadProfiles().catch(() => {});
    });
  }, []);

  return {
    profiles,
    sshGroups,
    activeProfileId,
    editingProfile,
    defaultProfile,
    pickProfile,
    saveProfile,
    duplicateProfile,
    removeProfile,
    reloadProfiles,
    /** 执行 OpenSSH 导入并在成功后刷新当前主机列表与分组。 */
    importOpenSshConfig: async () => {
      const summary = await importOpenSshConfigCommand();
      await loadProfiles();
      return summary;
    },
    addGroup,
    renameGroup,
    removeGroup,
    moveProfileToGroup,
  };
}
