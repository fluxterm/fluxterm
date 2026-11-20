/**
 * 持久化方案相关常量。
 * 职责：统一管理配置异步落盘的阈值，避免魔法数字散落在各 Hook 中。
 */

/**
 * 配置保存的防抖时间（毫秒）。
 * 设置为 500ms 可以在连续操作（如拖拽调整窗口、连续输入设置）时有效合并 I/O 请求。
 */
export const PERSISTENCE_SAVE_DEBOUNCE_MS = 500;

/** 备份前等待各窗口提交配置的最长时间。 */
export const PERSISTENCE_FLUSH_TIMEOUT_MS = 15_000;
