import type { Locale, Translate } from "@/i18n";
import type { CommandHistoryItem, CommandHistoryLiveCapture } from "@/types";
import { formatDateTimeMs } from "@/utils/format";
import "./CommandHistoryWidget.css";

/** 历史命令面板 props。 */
type CommandHistoryWidgetProps = {
  loaded: boolean;
  hasActiveSession: boolean;
  liveCapture: CommandHistoryLiveCapture | null;
  items: CommandHistoryItem[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onExecute: (command: string) => void;
  locale: Locale;
  t: Translate;
};

/**
 * 历史命令面板。
 * 顶部始终保留一个“实时监听项”槽位：
 * 1. 当前输入行为空时显示监听中
 * 2. 输入中实时展示当前输入行内容
 * 3. 回车提交后由状态层收口为正式历史项
 */
export default function CommandHistoryWidget({
  loaded,
  hasActiveSession,
  liveCapture,
  items,
  searchQuery,
  onSearchQueryChange,
  onExecute,
  locale,
  t,
}: CommandHistoryWidgetProps) {
  const showNoSession = loaded && !hasActiveSession;
  const showLiveCapture = loaded && hasActiveSession && !!liveCapture;
  const showEmpty =
    loaded && hasActiveSession && !searchQuery.trim() && !items.length;
  const showNoMatch =
    loaded && hasActiveSession && !!searchQuery.trim() && !items.length;

  return (
    <div className="history-widget">
      <div className="history-toolbar">
        <input
          className="history-search"
          value={searchQuery}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder={t("history.searchPlaceholder")}
          type="search"
        />
      </div>
      <div className="history-list">
        {showLiveCapture && (
          <div
            className={`history-item history-item-live ${
              liveCapture.state === "tracking"
                ? "history-item-live-active"
                : "history-item-live-idle"
            }`}
          >
            <span className="history-command">
              {liveCapture.command || t("history.listening")}
            </span>
            <span className="history-meta">
              <span>{t("history.liveStatus")}</span>
            </span>
          </div>
        )}
        {showNoSession && (
          <div className="history-empty">{t("history.noSession")}</div>
        )}
        {showEmpty && <div className="history-empty">{t("history.empty")}</div>}
        {showNoMatch && (
          <div className="history-empty">{t("history.noMatch")}</div>
        )}
        {!showNoSession &&
          !showEmpty &&
          !showNoMatch &&
          items.map((item) => (
            <button
              key={item.id}
              className="history-item"
              onDoubleClick={() => onExecute(item.command)}
              type="button"
            >
              <span className="history-command">{item.command}</span>
              <span className="history-meta">
                <span>
                  {t("history.useCount", {
                    count: item.useCount,
                  })}
                </span>
                <span>{formatDateTimeMs(item.lastUsedAt, locale)}</span>
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
