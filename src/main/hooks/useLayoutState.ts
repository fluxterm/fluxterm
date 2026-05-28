/**
 * 界面布局状态管理模块。
 * 职责：
 * 1. 读写 layout.json 配置文件。
 * 2. 管理侧边栏/底部面板的折叠状态、槽位数量、组件挂载情况以及浮窗初始位置。
 * 3. 响应窗口调整（Resize）并持久化面板尺寸。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { debug, warn } from "@/shared/logging/telemetry";
import {
  defaultWidgetLayout,
  increaseSideSlots,
  normalizeWidgetLayout,
  sideSlotKey,
} from "@/layout/model";
import type {
  FloatingWidgetLayout,
  WidgetLayout,
  WidgetGroup,
  WidgetSide,
  WidgetSlotId,
} from "@/layout/types";
import type { WidgetKey } from "@/types";
import { getGlobalConfigDir, getLayoutPath } from "@/shared/config/paths";
import { extractErrorMessage } from "@/shared/errors/appError";
import { PERSISTENCE_SAVE_DEBOUNCE_MS } from "@/constants/persistence";

/** useLayoutState 返回的布局控制接口。 */
type LayoutState = {
  layoutCollapsed: Record<WidgetSide | "bottom", boolean>;
  sideSlotCounts: Record<WidgetSide, number>;
  slotGroups: Record<string, WidgetGroup>;
  floatingOrigins: FloatingWidgetLayout;
  widgetSizes: { left: number; right: number; bottom: number };
  leftVisible: boolean;
  rightVisible: boolean;
  bottomVisible: boolean;
  layoutVars: React.CSSProperties;
  setSlotGroups: React.Dispatch<
    React.SetStateAction<Record<string, WidgetGroup>>
  >;
  setFloatingOrigins: React.Dispatch<
    React.SetStateAction<FloatingWidgetLayout>
  >;
  setWidgetCollapsed: (side: WidgetSide | "bottom", collapsed: boolean) => void;
  handleToggleSplit: (side: WidgetSide) => void;
  handleCloseSlot: (slot: WidgetSlotId) => void;
  handleToggleCollapsed: (side: WidgetSide | "bottom") => void;
  startResize: (
    mode: "left" | "right" | "bottom",
    event: React.MouseEvent<HTMLDivElement>,
  ) => void;
};

type UseLayoutStateProps = {
  /** 当前正处于浮动模式的面板 Key，若存在则暂停布局持久化以避免冲突。 */
  floatingWidgetKey: WidgetKey | null;
};

/** 快捷栏分组与命令状态管理（含本地配置持久化）。 */
export default function useLayoutState({
  floatingWidgetKey,
}: UseLayoutStateProps): LayoutState {
  const [resizeMode, setResizeMode] = useState<
    "left" | "right" | "bottom" | null
  >(null);
  const [layoutCollapsed, setLayoutCollapsed] = useState(
    defaultWidgetLayout.collapsed,
  );
  const [sideSlotCounts, setSideSlotCounts] = useState(
    defaultWidgetLayout.sideSlotCounts,
  );
  const [slotGroups, setSlotGroups] = useState(defaultWidgetLayout.slots);
  const [floatingOrigins, setFloatingOrigins] = useState(
    defaultWidgetLayout.floating,
  );
  const [widgetSizes, setwidgetSizes] = useState(defaultWidgetLayout.sizes);

  // 交互与持久化辅助。
  const dragState = useRef<{
    mode: "left" | "right" | "bottom";
    startX: number;
    startY: number;
    startLeft: number;
    startRight: number;
    startBottom: number;
  } | null>(null);
  const layoutLoadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const lastSavedConfigRef = useRef<string>("");

  /** 转换内存槽位结构为持久化格式。 */
  function buildPersistentSlots(
    slots: Record<string, WidgetGroup>,
  ): Record<string, WidgetGroup> {
    const next: Record<string, WidgetGroup> = {};
    Object.entries(slots).forEach(([slot, group]) => {
      next[slot as WidgetSlotId] = { ...group };
    });
    return next;
  }

  /** 从磁盘加载布局配置。 */
  async function loadLayoutConfig() {
    try {
      const path = await getLayoutPath();
      const existsFile = await exists(path);
      let raw: string | null = null;
      if (existsFile) {
        raw = await readTextFile(path);
      }
      if (!raw) {
        layoutLoadedRef.current = true;
        void debug(
          JSON.stringify({
            event: "layout.load.skip",
            reason: "empty-or-not-found",
          }),
        );
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizeWidgetLayout(parsed);
      if (!normalized) {
        layoutLoadedRef.current = true;
        return;
      }
      const totalWidgets = Object.values(normalized.slots).reduce(
        (count, group) => count + (group.active ? 1 : 0),
        0,
      );
      const totalfloatingWidgets = Object.keys(normalized.floating).length;
      if (totalWidgets === 0 && totalfloatingWidgets === 0) {
        setLayoutCollapsed(defaultWidgetLayout.collapsed);
        setSideSlotCounts(defaultWidgetLayout.sideSlotCounts);
        setSlotGroups(defaultWidgetLayout.slots);
        setFloatingOrigins(defaultWidgetLayout.floating);
        setwidgetSizes(defaultWidgetLayout.sizes);
        layoutLoadedRef.current = true;
        return;
      }
      setLayoutCollapsed(normalized.collapsed);
      setSideSlotCounts(normalized.sideSlotCounts);
      setSlotGroups(normalized.slots);
      setFloatingOrigins(normalized.floating);
      setwidgetSizes(normalized.sizes);
      void debug(
        JSON.stringify({
          event: "layout.loaded",
          collapsedSections: Object.values(normalized.collapsed).filter(Boolean)
            .length,
          slotCount: Object.keys(normalized.slots).length,
          floatingCount: Object.keys(normalized.floating).length,
          sizeCount: Object.keys(normalized.sizes).length,
        }),
      );
    } catch (error) {
      void warn(
        JSON.stringify({
          event: "layout.load.failed",
          error: extractErrorMessage(error),
        }),
      );
    } finally {
      layoutLoadedRef.current = true;
    }
  }

  /** 将当前布局状态写入磁盘。 */
  async function saveLayoutConfig(payload: WidgetLayout) {
    const dir = await getGlobalConfigDir();
    await mkdir(dir, { recursive: true });
    const path = await getLayoutPath();
    await writeTextFile(path, JSON.stringify(payload, null, 2));
  }

  /** 在侧边栏开启/合并分屏。 */
  function handleToggleSplit(side: WidgetSide) {
    setSideSlotCounts((prev) => {
      const currentCount = prev[side];
      const result = increaseSideSlots(slotGroups, side, currentCount);
      setSlotGroups(result.slots);
      return { ...prev, [side]: result.nextCount };
    });
  }

  /** 关闭指定槽位的组件。 */
  function handleCloseSlot(slot: WidgetSlotId) {
    if (slot === "bottom") {
      setSlotGroups((prev) => {
        const group = prev.bottom;
        if (!group?.active) return prev;
        return { ...prev, bottom: { ...group, active: null } };
      });
      return;
    }

    const match = slot.match(/^(left|right):(\d+)$/);
    if (!match) return;
    const side = match[1] as WidgetSide;
    const index = Number(match[2]);
    if (!Number.isInteger(index) || index < 0) return;

    const currentCount = sideSlotCounts[side];
    if (index >= currentCount) return;

    if (currentCount <= 1) {
      setSlotGroups((prev) => {
        const group = prev[slot];
        if (!group?.active) return prev;
        return { ...prev, [slot]: { ...group, active: null } };
      });
      return;
    }

    setSlotGroups((prev) => {
      const next: Record<string, WidgetGroup> = {};
      Object.entries(prev).forEach(([key, group]) => {
        if (key === "bottom") {
          next.bottom = { ...group };
          return;
        }
        const item = key.match(/^(left|right):(\d+)$/);
        if (!item) return;
        const itemSide = item[1] as WidgetSide;
        const itemIndex = Number(item[2]);
        if (itemSide !== side) {
          next[key] = { ...group };
          return;
        }
        if (itemIndex === index) return;
        const targetIndex = itemIndex > index ? itemIndex - 1 : itemIndex;
        next[`${side}:${targetIndex}`] = { ...group };
      });
      return next;
    });
    setSideSlotCounts((prev) => ({
      ...prev,
      [side]: Math.max(1, prev[side] - 1),
    }));
  }

  function handleToggleCollapsed(side: WidgetSide | "bottom") {
    setLayoutCollapsed((prev) => ({ ...prev, [side]: !prev[side] }));
  }

  function setWidgetCollapsed(side: WidgetSide | "bottom", collapsed: boolean) {
    setLayoutCollapsed((prev) => {
      if (prev[side] === collapsed) return prev;
      return { ...prev, [side]: collapsed };
    });
  }

  /** 开始调整面板尺寸。 */
  function startResize(
    mode: "left" | "right" | "bottom",
    event: React.MouseEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragState.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: widgetSizes.left,
      startRight: widgetSizes.right,
      startBottom: widgetSizes.bottom,
    };
    setResizeMode(mode);
  }

  function handleResizeMove(event: MouseEvent) {
    const drag = dragState.current;
    if (!drag) return;
    if (drag.mode === "left") {
      const min = 220;
      const max = Math.max(min, Math.min(520, window.innerWidth * 0.5));
      const next = Math.min(
        max,
        Math.max(min, drag.startLeft + (event.clientX - drag.startX)),
      );
      setwidgetSizes((prev) => ({ ...prev, left: next }));
    } else if (drag.mode === "right") {
      const min = 260;
      const max = Math.max(min, Math.min(560, window.innerWidth * 0.5));
      const next = Math.min(
        max,
        Math.max(min, drag.startRight - (event.clientX - drag.startX)),
      );
      setwidgetSizes((prev) => ({ ...prev, right: next }));
    } else if (drag.mode === "bottom") {
      const min = 160;
      const max = Math.max(min, Math.min(420, window.innerHeight * 0.6));
      const next = Math.min(
        max,
        Math.max(min, drag.startBottom - (event.clientY - drag.startY)),
      );
      setwidgetSizes((prev) => ({ ...prev, bottom: next }));
    }
  }

  function stopResize() {
    dragState.current = null;
    setResizeMode(null);
  }

  const leftVisible = !layoutCollapsed.left;
  const rightVisible = !layoutCollapsed.right;
  const bottomVisible = !layoutCollapsed.bottom;

  /** 将当前尺寸状态映射为 CSS 变量，供样式层实时响应。 */
  const layoutVars = useMemo(() => {
    const hasSideWidgets = leftVisible || rightVisible;
    const hasAnyWidgets = hasSideWidgets || bottomVisible;
    return {
      "--left-width": leftVisible ? `${widgetSizes.left}px` : "0px",
      "--right-width": rightVisible ? `${widgetSizes.right}px` : "0px",
      "--left-resizer": leftVisible ? "8px" : "0px",
      "--right-resizer": rightVisible ? "8px" : "0px",
      "--bottom-resizer": bottomVisible ? "8px" : "0px",
      "--bottom-height": bottomVisible ? `${widgetSizes.bottom}px` : "0px",
      "--workspace-pad": hasAnyWidgets ? "16px" : "0px",
    } as React.CSSProperties;
  }, [leftVisible, rightVisible, bottomVisible, widgetSizes]);

  // 初始化加载布局。
  useEffect(() => {
    queueMicrotask(() => {
      void loadLayoutConfig().catch(() => {});
    });
  }, []);

  useEffect(() => {
    if (!resizeMode) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor =
      resizeMode === "bottom" ? "row-resize" : "col-resize";
    window.addEventListener("mousemove", handleResizeMove);
    window.addEventListener("mouseup", stopResize);
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", handleResizeMove);
      window.removeEventListener("mouseup", stopResize);
    };
  }, [resizeMode]);

  // 防抖异步落盘逻辑。
  useEffect(() => {
    if (!layoutLoadedRef.current || floatingWidgetKey) return;

    const persistedSlots = buildPersistentSlots(slotGroups);
    const normalizedCounts = {
      left: Math.max(1, sideSlotCounts.left),
      right: Math.max(1, sideSlotCounts.right),
    };
    for (let i = 0; i < normalizedCounts.left; i += 1) {
      const key = sideSlotKey("left", i);
      if (!persistedSlots[key]) persistedSlots[key] = { active: null };
    }
    for (let i = 0; i < normalizedCounts.right; i += 1) {
      const key = sideSlotKey("right", i);
      if (!persistedSlots[key]) persistedSlots[key] = { active: null };
    }
    if (!persistedSlots.bottom) persistedSlots.bottom = { active: null };

    const currentLayout: WidgetLayout = {
      version: 1,
      collapsed: layoutCollapsed,
      sideSlotCounts: normalizedCounts,
      slots: persistedSlots,
      floating: floatingOrigins,
      sizes: widgetSizes,
    };

    const layoutStr = JSON.stringify(currentLayout);
    if (layoutStr === lastSavedConfigRef.current) return;

    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    void debug(
      JSON.stringify({
        event: "layout.save.scheduled",
        debounce: PERSISTENCE_SAVE_DEBOUNCE_MS,
      }),
    );

    saveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          await saveLayoutConfig(currentLayout);
          lastSavedConfigRef.current = layoutStr;
          void debug(JSON.stringify({ event: "layout.persisted" }));
        } catch (error) {
          void warn(
            JSON.stringify({
              event: "layout.save.failed",
              error: extractErrorMessage(error),
            }),
          );
        }
      })();
    }, PERSISTENCE_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [
    floatingWidgetKey,
    layoutCollapsed,
    sideSlotCounts,
    slotGroups,
    floatingOrigins,
    widgetSizes,
  ]);

  return {
    layoutCollapsed,
    sideSlotCounts,
    slotGroups,
    floatingOrigins,
    widgetSizes,
    leftVisible,
    rightVisible,
    bottomVisible,
    layoutVars,
    setSlotGroups,
    setFloatingOrigins,
    setWidgetCollapsed,
    handleToggleSplit,
    handleCloseSlot,
    handleToggleCollapsed,
    startResize,
  };
}
