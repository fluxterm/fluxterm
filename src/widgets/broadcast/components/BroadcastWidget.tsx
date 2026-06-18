import { useLayoutEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/button";
import Select from "@/components/ui/select";
import type {
  BroadcastTargetScope,
  Session,
  SessionGroup,
  SessionStateUi,
} from "@/types";
import type { Translate } from "@/i18n";
import { DEFAULT_SESSION_GROUP_ID } from "@/constants/sessionGroups";
import "./BroadcastWidget.css";

type BroadcastSendResult = {
  successCount: number;
  failedCount: number;
};

type BroadcastWidgetProps = {
  sessions: Session[];
  activeSessionId: string | null;
  sessionGroups: SessionGroup[];
  sessionStates: Record<string, SessionStateUi>;
  onSend: (
    sessionIds: string[],
    command: string,
  ) => Promise<BroadcastSendResult>;
  t: Translate;
};

type TargetSession = {
  sessionId: string;
  state: SessionStateUi;
  writable: boolean;
};

/** 命令广播面板。 */
export default function BroadcastWidget({
  sessions,
  activeSessionId,
  sessionGroups,
  sessionStates,
  onSend,
  t,
}: BroadcastWidgetProps) {
  const [scope, setScope] = useState<BroadcastTargetScope>("current");
  const [command, setCommand] = useState("");
  const [repeatCount, setRepeatCount] = useState("1");
  const [intervalSeconds, setIntervalSeconds] = useState("1");
  const [sending, setSending] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const [lastSendTotal, setLastSendTotal] = useState<number | null>(null);
  const stopRequestedRef = useRef(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.sessionId, session])),
    [sessions],
  );
  const groupBySessionId = useMemo(() => {
    const next = new Map<string, SessionGroup>();
    sessionGroups.forEach((group) => {
      group.sessionIds.forEach((sessionId) => {
        next.set(sessionId, group);
      });
    });
    return next;
  }, [sessionGroups]);

  const activeGroup = activeSessionId
    ? groupBySessionId.get(activeSessionId)
    : null;
  const activeGroupColor =
    activeGroup && activeGroup.id !== DEFAULT_SESSION_GROUP_ID
      ? (activeGroup.color ?? null)
      : null;
  const scopeOptions = useMemo(
    () =>
      (["current", "group", "all"] as BroadcastTargetScope[]).map((item) => ({
        value: item,
        label: t(`broadcast.scope.${item}`),
      })),
    [t],
  );

  const targetSessionIds = useMemo(() => {
    if (scope === "current") return activeSessionId ? [activeSessionId] : [];
    if (scope === "group") return activeGroup?.sessionIds ?? [];
    return sessions.map((session) => session.sessionId);
  }, [activeGroup, activeSessionId, scope, sessions]);

  const targets = useMemo<TargetSession[]>(() => {
    return targetSessionIds
      .map((sessionId) => {
        const session = sessionById.get(sessionId);
        if (!session) return null;
        const state = sessionStates[sessionId] ?? "connecting";
        return {
          sessionId,
          state,
          writable: isWritableSessionState(state),
        };
      })
      .filter((item): item is TargetSession => Boolean(item));
  }, [sessionById, sessionStates, targetSessionIds]);

  const writableTargets = targets.filter((target) => target.writable);
  const lineCount = Math.max(1, command.split("\n").length);
  const normalizedRepeatCount = normalizeNonNegativeInteger(repeatCount, 1);
  const normalizedIntervalSeconds = normalizePositiveNumber(intervalSeconds, 1);
  const canSend =
    command.trim().length > 0 &&
    writableTargets.length > 0 &&
    normalizedRepeatCount >= 0 &&
    normalizedIntervalSeconds > 0;
  const progressText =
    lastSendTotal === null
      ? null
      : lastSendTotal === 0
        ? t("broadcast.progressInfinite", { sent: sentCount })
        : t("broadcast.progressFinite", {
            sent: sentCount,
            total: lastSendTotal,
          });

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const editor = editorRef.current;
    if (!textarea || !editor) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(textarea.scrollHeight, editor.clientHeight)}px`;
  }, [command]);

  async function handleSend() {
    if (sending) {
      stopRequestedRef.current = true;
      return;
    }
    if (!canSend) return;
    setSending(true);
    setSentCount(0);
    setLastSendTotal(normalizedRepeatCount);
    stopRequestedRef.current = false;
    try {
      const sessionIds = writableTargets.map((target) => target.sessionId);
      for (
        let index = 0;
        normalizedRepeatCount === 0 || index < normalizedRepeatCount;
        index += 1
      ) {
        if (stopRequestedRef.current) break;
        await onSend(sessionIds, command);
        setSentCount(index + 1);
        const hasNextSend =
          normalizedRepeatCount === 0 || index < normalizedRepeatCount - 1;
        if (hasNextSend) {
          await waitUntilNextSend(normalizedIntervalSeconds * 1000, () => {
            return stopRequestedRef.current;
          });
        }
      }
    } finally {
      stopRequestedRef.current = false;
      setSending(false);
    }
  }

  return (
    <div className="broadcast-widget" data-ui="broadcast-widget">
      <div className="broadcast-command" data-slot="command-input">
        <div
          ref={editorRef}
          className="broadcast-editor"
          data-slot="command-editor"
        >
          <div
            className="broadcast-line-numbers"
            data-slot="line-numbers"
            aria-hidden="true"
          >
            {Array.from({ length: lineCount }, (_, index) => (
              <span key={index}>{index + 1}</span>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            className="broadcast-command-input"
            value={command}
            wrap="off"
            placeholder={t("broadcast.commandPlaceholder")}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            readOnly={sending}
            onChange={(event) => {
              setCommand(event.target.value);
            }}
          />
        </div>
        <div className="broadcast-actions">
          <div className="broadcast-status">
            <span className="broadcast-target-summary">
              {activeGroupColor ? (
                <span
                  className="broadcast-group-color"
                  style={{ backgroundColor: activeGroupColor }}
                  aria-hidden="true"
                />
              ) : null}
              {t("broadcast.targetSummary", {
                count: writableTargets.length,
              })}
            </span>
            {progressText ? (
              <span className="broadcast-progress">{progressText}</span>
            ) : null}
          </div>
          <div className="broadcast-send-controls">
            <label className="broadcast-number-field">
              <span>{t("broadcast.repeatCount")}</span>
              <input
                type="text"
                inputMode="numeric"
                value={repeatCount}
                disabled={sending}
                onChange={(event) => setRepeatCount(event.target.value)}
                onBlur={() =>
                  setRepeatCount(
                    String(normalizeNonNegativeInteger(repeatCount, 1)),
                  )
                }
              />
            </label>
            <label className="broadcast-number-field">
              <span>{t("broadcast.intervalSeconds")}</span>
              <input
                type="text"
                inputMode="decimal"
                value={intervalSeconds}
                disabled={sending}
                onChange={(event) => setIntervalSeconds(event.target.value)}
                onBlur={() =>
                  setIntervalSeconds(
                    String(normalizePositiveNumber(intervalSeconds, 1)),
                  )
                }
              />
            </label>
            <Select
              value={scope}
              options={scopeOptions}
              size="sm"
              aria-label={t("broadcast.scopeLabel")}
              disabled={sending}
              onChange={(value) => {
                setScope(value as BroadcastTargetScope);
              }}
            />
            <Button
              size="sm"
              disabled={!sending && !canSend}
              onClick={() => {
                void handleSend();
              }}
            >
              {sending ? t("broadcast.stop") : t("broadcast.send")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function waitUntilNextSend(ms: number, shouldStop: () => boolean) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const tick = () => {
      if (shouldStop() || Date.now() - startTime >= ms) {
        resolve(undefined);
        return;
      }
      window.setTimeout(tick, Math.min(100, ms));
    };
    tick();
  });
}

function normalizeNonNegativeInteger(value: string, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizePositiveNumber(value: string, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(0.01, Math.round(parsed * 100) / 100);
}

function isWritableSessionState(state: SessionStateUi) {
  return (
    state === "connected" || state === "connecting" || state === "reconnecting"
  );
}
