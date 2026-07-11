/** 串口结构化收发记录状态。 */
import { useEffect, useRef, useState } from "react";
import { registerSerialOutputListener } from "@/features/terminal/core/listeners";
import type { SerialMonitorRecord } from "@/types";

const MAX_SESSION_BYTES = 10 * 1024 * 1024;

/** 维护每个串口会话最多 10 MiB 的结构化收发记录。 */
export default function useSerialMonitorState() {
  const [recordsBySession, setRecordsBySession] = useState<
    Record<string, SerialMonitorRecord[]>
  >({});
  const nextIdRef = useRef(0);

  function append(
    sessionId: string,
    direction: SerialMonitorRecord["direction"],
    data: number[],
    timestamp = Date.now(),
  ) {
    if (!data.length) return;
    nextIdRef.current += 1;
    const record: SerialMonitorRecord = {
      id: `${sessionId}:${nextIdRef.current}`,
      sessionId,
      direction,
      data: [...data],
      timestamp,
    };
    setRecordsBySession((current) => {
      const nextRecords = [...(current[sessionId] ?? []), record];
      let total = nextRecords.reduce((sum, item) => sum + item.data.length, 0);
      while (total > MAX_SESSION_BYTES && nextRecords.length > 1) {
        total -= nextRecords.shift()?.data.length ?? 0;
      }
      return { ...current, [sessionId]: nextRecords };
    });
  }

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | null = null;
    void registerSerialOutputListener((payload) => {
      append(payload.sessionId, "rx", payload.data, payload.receivedAt);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        teardown = unlisten;
      }
    });
    return () => {
      cancelled = true;
      teardown?.();
    };
  }, []);

  useEffect(() => {
    const handleTransmit = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId?: unknown;
          data?: unknown;
        }>
      ).detail;
      if (
        typeof detail?.sessionId !== "string" ||
        !Array.isArray(detail.data)
      ) {
        return;
      }
      append(
        detail.sessionId,
        "tx",
        detail.data.filter(
          (value): value is number => typeof value === "number",
        ),
      );
    };
    window.addEventListener("fluxterm:serial-transmit", handleTransmit);
    return () =>
      window.removeEventListener("fluxterm:serial-transmit", handleTransmit);
  }, []);

  function clear(sessionId: string) {
    setRecordsBySession((current) => ({ ...current, [sessionId]: [] }));
  }

  return {
    recordsBySession,
    recordTransmit: (sessionId: string, data: number[]) =>
      append(sessionId, "tx", data),
    clear,
  };
}
