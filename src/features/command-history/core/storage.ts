/**
 * 历史命令存储读写层。
 * 职责：
 * 1. 负责 command-history.json 的加载与保存。
 * 2. 负责对磁盘中的未知/旧数据做最小规范化。
 */
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { warn } from "@/shared/logging/telemetry";
import { extractErrorMessage } from "@/shared/errors/appError";
import type {
  CommandHistoryBucket,
  CommandHistoryItem,
  CommandHistoryStore,
} from "@/types";
import {
  getCommandHistoryPath,
  getTerminalConfigDir,
} from "@/shared/config/paths";

const STORE_VERSION = 1;

function isValidHistoryItem(value: unknown): value is CommandHistoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as CommandHistoryItem;
  return (
    typeof item.id === "string" &&
    typeof item.command === "string" &&
    typeof item.firstUsedAt === "number" &&
    typeof item.lastUsedAt === "number" &&
    typeof item.useCount === "number" &&
    (item.source === "typed" ||
      item.source === "quickbar" ||
      item.source === "history")
  );
}

/** 校验单个历史命令分桶的结构是否满足当前 schema。 */
function isValidBucket(value: unknown): value is CommandHistoryBucket {
  if (!value || typeof value !== "object") return false;
  const bucket = value as CommandHistoryBucket;
  return (
    typeof bucket.scopeKey === "string" &&
    (bucket.scopeType === "ssh" ||
      bucket.scopeType === "local" ||
      bucket.scopeType === "global") &&
    typeof bucket.label === "string" &&
    typeof bucket.updatedAt === "number" &&
    Array.isArray(bucket.items) &&
    bucket.items.every(isValidHistoryItem)
  );
}

/** 规范化命令历史存储，丢弃非法数据并回退默认结构。 */
export function normalizeCommandHistoryStore(
  value: unknown,
): CommandHistoryStore {
  if (!value || typeof value !== "object") {
    return { version: STORE_VERSION, buckets: {} };
  }
  const parsed = value as Partial<CommandHistoryStore>;
  const rawBuckets =
    parsed.buckets && typeof parsed.buckets === "object" ? parsed.buckets : {};
  const buckets: Record<string, CommandHistoryBucket> = {};

  Object.entries(rawBuckets).forEach(([key, bucket]) => {
    if (!isValidBucket(bucket)) return;
    buckets[key] = {
      ...bucket,
      items: bucket.items.filter(isValidHistoryItem),
    };
  });

  return {
    version: STORE_VERSION,
    buckets,
  };
}

/** 读取历史命令配置文件。 */
export async function loadCommandHistoryStore() {
  try {
    const path = await getCommandHistoryPath();
    const existsFile = await exists(path);
    if (!existsFile) {
      return {
        version: STORE_VERSION,
        buckets: {},
      } satisfies CommandHistoryStore;
    }
    const raw = await readTextFile(path);
    if (!raw) {
      return {
        version: STORE_VERSION,
        buckets: {},
      } satisfies CommandHistoryStore;
    }
    return normalizeCommandHistoryStore(JSON.parse(raw));
  } catch (error) {
    void warn(
      JSON.stringify({
        event: "history.load.failed",
        error: extractErrorMessage(error),
      }),
    );
    return {
      version: STORE_VERSION,
      buckets: {},
    } satisfies CommandHistoryStore;
  }
}

/** 保存历史命令配置文件。写入失败时仅记录日志，不阻塞终端交互。 */
export async function saveCommandHistoryStore(store: CommandHistoryStore) {
  try {
    const dir = await getTerminalConfigDir();
    await mkdir(dir, { recursive: true });
    const path = await getCommandHistoryPath();
    await writeTextFile(path, JSON.stringify(store, null, 2));
  } catch (error) {
    void warn(
      JSON.stringify({
        event: "history.save.failed",
        error: extractErrorMessage(error),
      }),
    );
  }
}
