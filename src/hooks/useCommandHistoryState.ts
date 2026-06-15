/**
 * 历史命令状态 Hook。
 * 职责：
 * 1. 管理当前运行期会话历史。
 * 2. 管理全局持久化历史，用于联想与后续扩展能力。
 * 3. 管理当前活动会话的实时输入行监听态。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CommandHistoryBucket,
  CommandHistoryItem,
  CommandHistoryLiveCapture,
  CommandHistorySource,
  CommandHistoryStore,
} from "@/types";
import {
  createCommandHistoryItemId,
  trimHistoryItems,
} from "@/features/command-history/core/inputTracker";
import { filterHistoryItems } from "@/features/command-history/core/query";
import {
  loadCommandHistoryStore,
  saveCommandHistoryStore,
} from "@/features/command-history/core/storage";

const HISTORY_ITEMS_LIMIT = 300;
const GLOBAL_SCOPE_KEY = "__global__";

export type CommandHistoryScope = {
  scopeKey: string;
  label: string;
};

type RecordHistoryCommandPayload = {
  sessionId: string | null;
  command: string;
  source: CommandHistorySource;
};

type ExecuteHistoryItemPayload = {
  sessionId: string | null;
  command: string;
};

type UpdateLiveCapturePayload = {
  sessionId: string;
  command: string;
  state: CommandHistoryLiveCapture["state"];
};

type UseCommandHistoryStateProps = {
  activeSessionId: string | null;
  writeToSession: (sessionId: string, data: string) => Promise<unknown>;
  focusActiveTerminal: () => boolean;
};

function normalizeCommandForExecution(command: string) {
  return command
    .replace(/\r\n/g, "\r")
    .replace(/\n/g, "\r")
    .replace(/\r?$/, "\r");
}

/**
 * 将一条命令写入历史分桶。
 * 规则：
 * 1. 同命令去重。
 * 2. 再次命中时仅更新时间、次数和来源。
 * 3. 保留最近使用排序，并做上限裁剪。
 */
function upsertHistoryBucket(
  bucket: CommandHistoryBucket | undefined,
  command: string,
  source: CommandHistorySource,
) {
  const now = Date.now();
  const nextItems = [...(bucket?.items ?? [])];
  const existingIndex = nextItems.findIndex((item) => item.command === command);

  if (existingIndex >= 0) {
    const existing = nextItems[existingIndex];
    nextItems[existingIndex] = {
      ...existing,
      lastUsedAt: now,
      useCount: existing.useCount + 1,
      source,
    };
  } else {
    nextItems.unshift({
      id: createCommandHistoryItemId(command, now),
      command,
      firstUsedAt: now,
      lastUsedAt: now,
      useCount: 1,
      source,
    });
  }

  return {
    scopeKey: bucket?.scopeKey ?? GLOBAL_SCOPE_KEY,
    scopeType: "global" as const,
    label: bucket?.label ?? "Global",
    updatedAt: now,
    items: trimHistoryItems(nextItems, HISTORY_ITEMS_LIMIT),
  };
}

/** 历史命令状态与本地持久化。 */
export default function useCommandHistoryState({
  activeSessionId,
  writeToSession,
  focusActiveTerminal,
}: UseCommandHistoryStateProps) {
  const [store, setStore] = useState<CommandHistoryStore>({
    version: 1,
    buckets: {},
  });
  const [loaded, setLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sessionBuckets, setSessionBuckets] = useState<
    Record<string, CommandHistoryBucket>
  >({});
  const [liveCaptureBySession, setLiveCaptureBySession] = useState<
    Record<string, CommandHistoryLiveCapture>
  >({});
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    void loadCommandHistoryStore()
      .then((nextStore) => {
        setStore(nextStore);
      })
      .finally(() => {
        loadedRef.current = true;
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveCommandHistoryStore(store).catch(() => {});
      saveTimerRef.current = null;
    }, 250);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [store]);

  useEffect(() => {
    queueMicrotask(() => {
      setSearchQuery("");
    });
  }, [activeSessionId]);

  const activeItems = useMemo(() => {
    if (!activeSessionId) return [] as CommandHistoryItem[];
    const bucket = sessionBuckets[activeSessionId];
    return filterHistoryItems(bucket?.items ?? [], searchQuery);
  }, [activeSessionId, searchQuery, sessionBuckets]);

  const activeSessionItems = useMemo(() => {
    if (!activeSessionId) return [] as CommandHistoryItem[];
    return filterHistoryItems(sessionBuckets[activeSessionId]?.items ?? [], "");
  }, [activeSessionId, sessionBuckets]);

  const globalItems = useMemo(
    () => store.buckets[GLOBAL_SCOPE_KEY]?.items ?? [],
    [store.buckets],
  );

  const activeLiveCapture = useMemo(() => {
    if (!activeSessionId) return null;
    return (
      liveCaptureBySession[activeSessionId] ?? {
        state: "listening",
        command: "",
        updatedAt: 0,
      }
    );
  }, [activeSessionId, liveCaptureBySession]);

  /**
   * 记录一条已经完成提交的命令。
   * 当前会同时写入：
   * 1. 当前运行期会话历史
   * 2. 全局持久化历史
   */
  function recordCommand(payload: RecordHistoryCommandPayload) {
    const command = payload.command.trim();
    if (!command) return;
    if (payload.sessionId) {
      setSessionBuckets((prev) => ({
        ...prev,
        [payload.sessionId!]: upsertHistoryBucket(
          prev[payload.sessionId!],
          command,
          payload.source,
        ),
      }));
    }
    setStore((prev) => ({
      ...prev,
      buckets: {
        ...prev.buckets,
        [GLOBAL_SCOPE_KEY]: upsertHistoryBucket(
          prev.buckets[GLOBAL_SCOPE_KEY],
          command,
          payload.source,
        ),
      },
    }));
  }

  /**
   * 更新当前会话的实时输入行监听状态。
   * 空命令会退回 listening，有内容时强制视为 tracking。
   */
  function updateLiveCapture(payload: UpdateLiveCapturePayload) {
    const command = payload.command.trim();
    setLiveCaptureBySession((prev) => {
      const nextCapture: CommandHistoryLiveCapture = {
        state: command ? "tracking" : payload.state,
        command,
        updatedAt: Date.now(),
      };
      const current = prev[payload.sessionId];
      if (
        current?.state === nextCapture.state &&
        current.command === nextCapture.command
      ) {
        return prev;
      }
      return {
        ...prev,
        [payload.sessionId]: nextCapture,
      };
    });
  }

  /**
   * 双击历史命令后，将命令写回当前活动会话并附带提交符。
   * 执行前会先尝试聚焦当前终端，避免命令发送到不可见状态。
   */
  async function executeHistoryItem({
    sessionId,
    command,
  }: ExecuteHistoryItemPayload) {
    if (!sessionId) return false;
    focusActiveTerminal();
    await writeToSession(sessionId, normalizeCommandForExecution(command));
    return true;
  }

  /** 从全局历史中删除命令，用于清理不再需要的联想候选。 */
  function removeGlobalCommand(command: string) {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) return;
    setStore((prev) => {
      const bucket = prev.buckets[GLOBAL_SCOPE_KEY];
      if (!bucket) return prev;
      const nextItems = bucket.items.filter(
        (item) => item.command !== normalizedCommand,
      );
      if (nextItems.length === bucket.items.length) return prev;
      return {
        ...prev,
        buckets: {
          ...prev.buckets,
          [GLOBAL_SCOPE_KEY]: {
            ...bucket,
            updatedAt: Date.now(),
            items: nextItems,
          },
        },
      };
    });
  }

  return {
    loaded,
    searchQuery,
    setSearchQuery,
    activeItems,
    activeSessionItems,
    activeLiveCapture,
    globalItems,
    activeScopeKey: activeSessionId,
    recordCommand,
    updateLiveCapture,
    executeHistoryItem,
    removeGlobalCommand,
  };
}
