import type { Locale, Translate } from "@/i18n";
import type { AppEvent, DisconnectReason, SessionStateUi } from "@/types";
import { formatDateTimeMs } from "@/utils/format";

type EventsWidgetProps = {
  sessionState: SessionStateUi;
  sessionReason: DisconnectReason | null;
  reconnectInfo: { attempt: number; delayMs: number } | null;
  events: AppEvent[];
  locale: Locale;
  t: Translate;
};

function isVisibleActivityEvent(event: AppEvent) {
  return event.scope === "session" || event.type === "sftp.unsupported";
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
export default function EventsWidget({
  sessionState,
  sessionReason,
  reconnectInfo,
  events,
  locale,
  t,
}: EventsWidgetProps) {
  const sessionLabelMap: Record<SessionStateUi, string> = {
    connected: t("session.connected"),
    disconnected: t("session.disconnected"),
    connecting: t("session.connecting"),
    error: t("session.error"),
    reconnecting: t("session.reconnecting"),
  };
  const sessionLabel = sessionLabelMap[sessionState] ?? sessionState;
  const reasonLabelMap: Record<DisconnectReason, string> = {
    exit: t("session.reason.exit"),
    poweroff: t("session.reason.poweroff"),
    reboot: t("session.reason.reboot"),
    network: t("session.reason.network"),
    unknown: t("session.reason.unknown"),
  };
  const reasonLabel = sessionReason
    ? reasonLabelMap[sessionReason]
    : t("session.reason.unknown");

  const activityEvents = events.filter(isVisibleActivityEvent);

  return (
    <div className="log-widget">
      <div className="log-row">
        <span>{t("log.sessionState")}</span>
        <strong>{sessionLabel}</strong>
      </div>
      {sessionState !== "connected" && sessionReason && (
        <div className="log-row">
          <span>{t("log.disconnectReason")}</span>
          <strong>{reasonLabel}</strong>
        </div>
      )}
      {reconnectInfo && (
        <div className="log-row">
          <span>{t("log.reconnect")}</span>
          <strong>
            {t("log.reconnectAttempt", {
              attempt: String(reconnectInfo.attempt),
              delay: String(Math.ceil(reconnectInfo.delayMs / 1000)),
            })}
          </strong>
        </div>
      )}
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
