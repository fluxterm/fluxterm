/** 串口 Profile 和端口列表状态。 */
import { useCallback, useEffect, useState } from "react";
import {
  listSerialPorts,
  listSerialProfileGroups,
  listSerialProfiles,
  removeSerialProfile,
  saveSerialProfile,
  saveSerialProfileGroups,
} from "@/features/serial/core/commands";
import type { SerialPortInfo, SerialProfile } from "@/types";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";

type UseSerialProfilesOptions = {
  enabled: boolean;
};

/** 在主窗口中维护串口配置和实时端口快照。 */
export default function useSerialProfiles({
  enabled,
}: UseSerialProfilesOptions) {
  const [profiles, setProfiles] = useState<SerialProfile[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextProfiles, nextGroups, nextPorts] = await Promise.all([
        listSerialProfiles(),
        listSerialProfileGroups(),
        listSerialPorts(),
      ]);
      setProfiles(nextProfiles);
      setGroups(nextGroups);
      setPorts(nextPorts);
      return { profiles: nextProfiles, groups: nextGroups, ports: nextPorts };
    } catch (nextError) {
      setError(nextError);
      throw nextError;
    } finally {
      setLoading(false);
    }
  }, []);

  const save = useCallback(async (profile: SerialProfile) => {
    const saved = await saveSerialProfile(profile);
    setProfiles((current) => {
      const exists = current.some((item) => item.id === saved.id);
      return exists
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved];
    });
    return saved;
  }, []);

  const remove = useCallback(async (profileId: string) => {
    const removed = await removeSerialProfile(profileId);
    if (removed) {
      setProfiles((current) => current.filter((item) => item.id !== profileId));
    }
    return removed;
  }, []);

  /** 保存串口分组，并以持久化后的规范化结果更新状态。 */
  const saveGroups = useCallback(async (nextGroups: string[]) => {
    const saved = await saveSerialProfileGroups(nextGroups);
    setGroups(saved);
    return saved;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const cancelInitialRefresh = scheduleDeferredTask(() => {
      void refresh().catch(() => {});
    });
    return () => {
      cancelInitialRefresh();
    };
  }, [enabled, refresh]);

  return {
    profiles,
    groups,
    ports,
    loading,
    error,
    refresh,
    save,
    remove,
    saveGroups,
  };
}
