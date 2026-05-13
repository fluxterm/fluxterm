import type { AppEvent, AppEventLevel } from "@/types";

export type CreateAppEventInput = Omit<
  AppEvent,
  "id" | "timestamp" | "level"
> & {
  id?: string;
  timestamp?: number;
  level?: AppEventLevel;
};

function createAppEventId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 创建全局事件中心使用的结构化事件。 */
export function createAppEvent(input: CreateAppEventInput): AppEvent {
  return {
    ...input,
    id: input.id ?? createAppEventId(),
    timestamp: input.timestamp ?? Date.now(),
    level: input.level ?? "info",
  };
}
