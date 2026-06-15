/**
 * 终端运行时常量。
 * 职责：集中管理终端交互中的阈值与默认值，避免魔法数字散落在运行时代码中。
 */

/** 默认终端回滚行数。 */
export const DEFAULT_TERMINAL_SCROLLBACK = 3000;

/** 输入行实时监听的防抖时间。 */
export const COMMAND_CAPTURE_DEBOUNCE_MS = 500;

/** 自动复制选区写入剪贴板的防抖时间。 */
export const SELECTION_AUTO_COPY_DEBOUNCE_MS = 120;

/** 终端首次挂载时的最大补偿重试次数。 */
export const TERMINAL_MOUNT_RETRY_LIMIT = 8;

/** 联想浮层最小可用高度。 */
export const AUTOCOMPLETE_MIN_PANEL_HEIGHT = 120;

/** 联想候选最多保留数量，避免补全面板承担历史搜索职责。 */
export const AUTOCOMPLETE_MAX_CANDIDATES = 20;

/** 联想浮层最多显示的可视条目数，超出后滚动展示。 */
export const AUTOCOMPLETE_VISIBLE_ITEMS = 5;

/** 联想候选最低使用次数，小于该值不参与候选。 */
export const AUTOCOMPLETE_MIN_USE_COUNT = 5;

/** 联想近期性打分衰减窗口（天）。 */
export const AUTOCOMPLETE_RECENCY_DECAY_WINDOW_DAYS = 30;

/** 联想频次打分系数，作用于 log2(useCount + 1)。 */
export const AUTOCOMPLETE_FREQUENCY_WEIGHT = 35;

/** 联想近期性打分满分。 */
export const AUTOCOMPLETE_RECENCY_MAX_SCORE = 120;

/** 仅命令名前缀匹配时的命中质量基础分。 */
export const AUTOCOMPLETE_MATCH_SCORE_COMMAND_PREFIX = 280;

/** 命令名精确匹配时的命中质量基础分。 */
export const AUTOCOMPLETE_MATCH_SCORE_COMMAND_EXACT = 320;

/** 含参数前缀匹配时的命中质量基础分。 */
export const AUTOCOMPLETE_MATCH_SCORE_ARGS_PREFIX = 260;

/** 候选长度惩罚系数，越长的候选分值越低。 */
export const AUTOCOMPLETE_LENGTH_PENALTY_PER_CHAR = 2.5;
