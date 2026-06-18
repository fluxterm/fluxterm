/** 布局结构与槽位操作工具，负责默认布局与布局配置规范化。 */
import type { WidgetKey } from "@/types";
import type {
  FloatingWidgetLayout,
  WidgetLayout,
  WidgetGroup,
  WidgetSide,
  WidgetSlotId,
} from "./types";

/** 每侧最大槽位数量。 */
export const MAX_SIDE_SLOTS = 10;

/** 所有可用组件键。 */
export const widgetKeys: WidgetKey[] = [
  "profiles",
  "rdp",
  "files",
  "transfers",
  "events",
  "history",
  "ai",
  "tunnels",
  "broadcast",
];

/** 默认小组件布局。 */
export const defaultWidgetLayout: WidgetLayout = {
  version: 1,
  sizes: {
    left: 320,
    right: 360,
    bottom: 240,
  },
  collapsed: {
    left: false,
    right: false,
    bottom: false,
  },
  sideSlotCounts: {
    left: 1,
    right: 1,
  },
  slots: {
    "left:0": { active: "profiles" },
    "right:0": { active: "files" },
    bottom: { active: "transfers" },
  },
  floating: {},
};

/** 创建侧边槽位 key。 */
export function sideSlotKey(side: WidgetSide, index: number): WidgetSlotId {
  return `${side}:${index}`;
}

/** 创建空组件组。 */
export function createEmptyGroup(): WidgetGroup {
  return { active: null };
}

/** 统一规范组件组，单个槽位同一时刻只保留一个组件。 */
export function normalizeGroup(group: unknown): WidgetGroup {
  if (!group || typeof group !== "object") return createEmptyGroup();
  const raw = group as Partial<WidgetGroup>;
  return {
    active: normalizeWidgetKey(raw.active),
  };
}

/** 获取某侧槽位 key（按索引升序）。 */
export function getSideSlotKeys(
  slots: Record<string, WidgetGroup>,
  side: WidgetSide,
) {
  return Object.keys(slots)
    .map((key) => parseSideSlotKey(key))
    .filter(
      (item): item is { side: WidgetSide; index: number } =>
        item !== null && item.side === side,
    )
    .sort((a, b) => a.index - b.index)
    .map((item) => sideSlotKey(item.side, item.index));
}

/** 深拷贝槽位集合。 */
export function cloneSlots(slots: Record<string, WidgetGroup>) {
  const next: Record<string, WidgetGroup> = {};
  Object.entries(slots).forEach(([slot, group]) => {
    next[slot as WidgetSlotId] = { ...group };
  });
  return next;
}

/** 保证左右槽位索引连续且数量满足 sideSlotCounts。 */
export function normalizeSideSlotStructure(
  slots: Record<string, WidgetGroup>,
  sideSlotCounts: Record<WidgetSide, number>,
) {
  const next: Record<string, WidgetGroup> = {};
  const normalizedCounts: Record<WidgetSide, number> = {
    left: clampNumber(sideSlotCounts.left, 1, MAX_SIDE_SLOTS, 1),
    right: clampNumber(sideSlotCounts.right, 1, MAX_SIDE_SLOTS, 1),
  };
  (["left", "right"] as WidgetSide[]).forEach((side) => {
    const keys = getSideSlotKeys(slots, side);
    for (let index = 0; index < normalizedCounts[side]; index += 1) {
      const source = keys[index];
      next[sideSlotKey(side, index)] = source
        ? normalizeGroup(slots[source])
        : createEmptyGroup();
    }
  });
  next.bottom = normalizeGroup(slots.bottom);
  return { slots: next, sideSlotCounts: normalizedCounts };
}

/** 规范小组件布局配置。 */
export function normalizeWidgetLayout(raw: unknown): WidgetLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !value.sizes || !value.slots) return null;

  const baseSlots = normalizeSlots(value.slots as Record<string, unknown>);
  const initialCounts: Record<WidgetSide, number> = {
    left: clampNumber(
      (value.sideSlotCounts as Record<string, unknown> | undefined)?.left,
      1,
      MAX_SIDE_SLOTS,
      1,
    ),
    right: clampNumber(
      (value.sideSlotCounts as Record<string, unknown> | undefined)?.right,
      1,
      MAX_SIDE_SLOTS,
      1,
    ),
  };
  const structured = normalizeSideSlotStructure(baseSlots, initialCounts);
  const dedupedSlots = dedupeActiveWidgets(structured.slots);
  const floating = normalizeFloating(value.floating, dedupedSlots);

  return {
    version: 1,
    sizes: {
      left: clampNumber(
        (value.sizes as Record<string, unknown>).left,
        220,
        520,
        defaultWidgetLayout.sizes.left,
      ),
      right: clampNumber(
        (value.sizes as Record<string, unknown>).right,
        260,
        560,
        defaultWidgetLayout.sizes.right,
      ),
      bottom: clampNumber(
        (value.sizes as Record<string, unknown>).bottom,
        160,
        420,
        defaultWidgetLayout.sizes.bottom,
      ),
    },
    collapsed: {
      left:
        typeof (value.collapsed as Record<string, unknown> | undefined)
          ?.left === "boolean"
          ? ((value.collapsed as Record<string, unknown>).left as boolean)
          : defaultWidgetLayout.collapsed.left,
      right:
        typeof (value.collapsed as Record<string, unknown> | undefined)
          ?.right === "boolean"
          ? ((value.collapsed as Record<string, unknown>).right as boolean)
          : defaultWidgetLayout.collapsed.right,
      bottom:
        typeof (value.collapsed as Record<string, unknown> | undefined)
          ?.bottom === "boolean"
          ? ((value.collapsed as Record<string, unknown>).bottom as boolean)
          : defaultWidgetLayout.collapsed.bottom,
    },
    sideSlotCounts: structured.sideSlotCounts,
    slots: dedupedSlots,
    floating,
  };
}

/** 将组件放入槽位：从其他槽位移除后，直接替换目标槽位当前组件。 */
export function moveWidgetToSlot(
  slots: Record<string, WidgetGroup>,
  widget: WidgetKey,
  target: WidgetSlotId,
) {
  const next = cloneSlots(slots);
  Object.values(next).forEach((group) => {
    if (group.active === widget) {
      group.active = null;
    }
  });
  if (!next[target]) next[target] = createEmptyGroup();
  next[target].active = widget;
  return next;
}

/** 某一侧增加一个槽位（上限 MAX_SIDE_SLOTS）。 */
export function increaseSideSlots(
  slots: Record<string, WidgetGroup>,
  side: WidgetSide,
  currentCount: number,
) {
  const nextCount = Math.min(MAX_SIDE_SLOTS, currentCount + 1);
  if (nextCount === currentCount) {
    return { slots: cloneSlots(slots), nextCount };
  }
  const next = cloneSlots(slots);
  next[sideSlotKey(side, nextCount - 1)] = createEmptyGroup();
  return { slots: next, nextCount };
}

/** 关闭槽位中当前激活组件。 */
export function closeActiveWidgetInSlot(
  slots: Record<string, WidgetGroup>,
  slot: WidgetSlotId,
) {
  const next = cloneSlots(slots);
  const group = next[slot];
  if (!group || !group.active) return next;
  group.active = null;
  return next;
}

function normalizeSlots(rawSlots: Record<string, unknown>) {
  const next: Record<string, WidgetGroup> = { bottom: createEmptyGroup() };
  Object.entries(rawSlots).forEach(([key, value]) => {
    if (key === "bottom") {
      next.bottom = normalizeGroup(value);
      return;
    }
    const parsed = parseSideSlotKey(key);
    if (!parsed) return;
    next[sideSlotKey(parsed.side, parsed.index)] = normalizeGroup(value);
  });
  return next;
}

function normalizeFloating(
  raw: unknown,
  slots: Record<string, WidgetGroup>,
): FloatingWidgetLayout {
  if (!raw || typeof raw !== "object") return {};
  const activeWidgets = new Set<WidgetKey>();
  Object.values(slots).forEach((group) => {
    if (group.active) activeWidgets.add(group.active);
  });
  const next: FloatingWidgetLayout = {};
  Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
    const widget = normalizeWidgetKey(key);
    if (!widget || activeWidgets.has(widget)) return;
    if (!value || typeof value !== "object") return;
    const origin = (value as { origin?: unknown }).origin;
    if (origin !== "bottom") {
      const parsed =
        typeof origin === "string" ? parseSideSlotKey(origin) : null;
      if (!parsed) return;
      next[widget] = { origin: sideSlotKey(parsed.side, parsed.index) };
      return;
    }
    next[widget] = { origin: "bottom" };
  });
  return next;
}

function dedupeActiveWidgets(slots: Record<string, WidgetGroup>) {
  const next = cloneSlots(slots);
  const used = new Set<WidgetKey>();
  const orderedKeys = [
    ...getSideSlotKeys(next, "left"),
    ...getSideSlotKeys(next, "right"),
    "bottom" as WidgetSlotId,
  ];
  orderedKeys.forEach((slot) => {
    const group = next[slot];
    if (!group?.active) return;
    if (used.has(group.active)) {
      group.active = null;
      return;
    }
    used.add(group.active);
  });
  return next;
}

function parseSideSlotKey(value: string) {
  const match = value.match(/^(left|right):(\d+)$/);
  if (!match) return null;
  const side = match[1] as WidgetSide;
  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SIDE_SLOTS) {
    return null;
  }
  return { side, index };
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeWidgetKey(value: unknown): WidgetKey | null {
  if (value === "profiles") return "profiles";
  if (value === "rdp") return "rdp";
  if (value === "files") return "files";
  if (value === "transfers") return "transfers";
  if (value === "events") return "events";
  if (value === "history") return "history";
  if (value === "ai") return "ai";
  if (value === "tunnels") return "tunnels";
  if (value === "broadcast") return "broadcast";
  if (value === "logs") return "events";
  return null;
}
