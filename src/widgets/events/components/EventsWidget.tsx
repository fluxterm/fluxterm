import type { Locale, Translate } from "@/i18n";
import type { AppEvent } from "@/types";
import { formatDateTimeMs } from "@/utils/format";

type EventsWidgetProps = {
  events: AppEvent[];
  locale: Locale;
  t: Translate;
};

function isVisibleActivityEvent(event: AppEvent) {
  return event.scope === "session" || event.scope === "sftp";
}

function normalizeEventVars(event: AppEvent) {
  if (!event.vars) return undefined;
  return Object.fromEntries(
    Object.entries(event.vars).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number",
    ),
  );
}

/** 全局事件中心 V1 面板。 */
export default function EventsWidget({ events, locale, t }: EventsWidgetProps) {
  const activityEvents = events.filter(isVisibleActivityEvent);

  return (
    <div className="log-widget">
      <div className="log-list">
        <div className="log-list-header">{t("log.history")}</div>
        <div className="log-list-body">
          {activityEvents.length ? (
            activityEvents.map((event) => (
              <div key={event.id} className={`log-item ${event.level}`}>
                <span className="log-time">
                  {formatDateTimeMs(event.timestamp, locale)}
                </span>
                <span className="log-message">
                  {t(event.titleKey, normalizeEventVars(event))}
                </span>
              </div>
            ))
          ) : (
            <div className="log-item">
              <span className="log-message">{t("log.noEvents")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
