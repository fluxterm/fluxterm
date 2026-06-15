import type { Translate } from "@/i18n";
import type { QuickCommandItem } from "@/types";

/** 获取快捷命令展示名称。 */
export function resolveCommandLabel(item: QuickCommandItem, t: Translate) {
  const value = item.label.trim();
  return value || t("quickbar.manager.newLabel");
}

/** 按目标索引生成命令排序预览。 */
export function moveCommandId(
  commandIds: string[],
  sourceCommandId: string,
  targetIndex: number,
) {
  const sourceIndex = commandIds.indexOf(sourceCommandId);
  if (sourceIndex < 0) {
    return commandIds;
  }
  const next = commandIds.slice();
  const [moved] = next.splice(sourceIndex, 1);
  const safeTargetIndex = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(safeTargetIndex, 0, moved);
  return next;
}
