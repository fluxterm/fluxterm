/** 串口结构化监视器。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  FiCheck,
  FiCopy,
  FiHash,
  FiSave,
  FiSlash,
  FiType,
} from "react-icons/fi";
import ContextMenu, {
  type ContextMenuItem,
} from "@/components/ui/menu/ContextMenu";
import type { Translate } from "@/i18n";
import type { SerialMonitorRecord, SerialProfile } from "@/types";
import {
  resolveTerminalFontFamily,
  type TerminalFontFamilyMode,
} from "@/constants/terminalFontFamily";
import { normalizeTerminalFontSize } from "@/hooks/useSessionSettings";
import "@/widgets/terminal/components/SerialDebugPanel.css";

type DisplayMode = "text" | "hex";
type SendMode = "text" | "hex";

type HexDisplayLine = {
  id: string;
  timestamp: number | null;
  direction: SerialMonitorRecord["direction"];
  data: number[];
  offset: number;
};

type TextDisplayLine = {
  id: string;
  timestamp: number | null;
  direction: SerialMonitorRecord["direction"];
  text: string;
};

const HEX_BYTES_PER_LINE = 16;
const AUTO_SCROLL_THRESHOLD = 24;

type SerialDebugPanelProps = {
  sessionId: string;
  active: boolean;
  profile: SerialProfile;
  records: SerialMonitorRecord[];
  terminalFontFamilyMode: TerminalFontFamilyMode;
  terminalFontSize: number;
  onSendText: (data: string) => Promise<void>;
  onSendBinary: (data: number[]) => Promise<void>;
  onClear: () => void;
  onSave: (mode: DisplayMode) => Promise<void>;
  t: Translate;
};

function resolveEnterData(ending: SerialProfile["lineEnding"]) {
  if (ending === "lf") return "\n";
  if (ending === "crlf") return "\r\n";
  return "\r";
}

function formatAscii(data: number[]) {
  return data
    .map((byte) =>
      byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".",
    )
    .join("");
}

/** 按系统本地时区显示紧凑时间，同时保留毫秒精度。 */
function formatLocalTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 返回终端按键对应的控制序列；普通文本与输入法内容由 textarea change 处理。 */
function resolveControlSequence(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  lineEnding: SerialProfile["lineEnding"],
) {
  const keySequences: Record<string, string> = {
    Enter: resolveEnterData(lineEnding),
    Tab: "\t",
    Backspace: "\u007f",
    Escape: "\u001b",
    ArrowUp: "\u001b[A",
    ArrowDown: "\u001b[B",
    ArrowRight: "\u001b[C",
    ArrowLeft: "\u001b[D",
    Delete: "\u001b[3~",
    Home: "\u001b[H",
    End: "\u001b[F",
    PageUp: "\u001b[5~",
    PageDown: "\u001b[6~",
  };
  if (keySequences[event.key]) return keySequences[event.key];
  if (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    /^[a-z]$/i.test(event.key)
  ) {
    if (event.key.toLowerCase() === "v") return null;
    if (
      event.key.toLowerCase() === "c" &&
      document.getSelection()?.toString()
    ) {
      return null;
    }
    return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
  }
  return null;
}

/** 监视器以文本或 HEX 展示原始记录，并通过隐藏输入捕获键盘与输入法。 */
export default function SerialDebugPanel({
  sessionId,
  active,
  profile,
  records,
  terminalFontFamilyMode,
  terminalFontSize,
  onSendText,
  onSendBinary,
  onClear,
  onSave,
  t,
}: SerialDebugPanelProps) {
  const [mode, setMode] = useState<DisplayMode>("text");
  const [sendMode, setSendMode] = useState<SendMode>("text");
  const [hexSendBuffer, setHexSendBuffer] = useState("");
  const [captureValue, setCaptureValue] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    selectedText: string;
  } | null>(null);
  const [textCharsPerLine, setTextCharsPerLine] = useState(80);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const monitorRef = useRef<HTMLDivElement | null>(null);
  const textMeasureRef = useRef<HTMLSpanElement | null>(null);
  const shouldFollowOutputRef = useRef(true);
  const wheelScrollIntentRef = useRef(false);
  const pointerScrollIntentRef = useRef(false);
  const composingRef = useRef(false);
  const normalizedFontSize = normalizeTerminalFontSize(terminalFontSize);
  const rowHeight = Math.max(30, Math.ceil(normalizedFontSize * 1.65));
  const terminalFontFamily = resolveTerminalFontFamily(terminalFontFamilyMode);
  const decodedText = useMemo(() => {
    const label = profile.encoding === "gb18030" ? "gb18030" : "utf-8";
    const decoders = {
      rx: new TextDecoder(label, { fatal: false }),
      tx: new TextDecoder(label, { fatal: false }),
    };
    return new Map(
      records.map((record) => [
        record.id,
        decoders[record.direction].decode(new Uint8Array(record.data), {
          stream: true,
        }),
      ]),
    );
  }, [profile.encoding, records]);
  const textLines = useMemo(() => {
    const lines: TextDisplayLine[] = [];
    let direction: SerialMonitorRecord["direction"] | null = null;
    let timestamp: number | null = null;
    let blockId = "";
    let lineIndex = 0;
    let text = "";
    let previousWasCr = false;

    function flushLine(force = false) {
      if (!direction || (!force && !text)) return;
      lines.push({
        id: `${blockId}:${lineIndex}`,
        timestamp,
        direction,
        text,
      });
      lineIndex += 1;
      timestamp = null;
      text = "";
    }

    records.forEach((record) => {
      if (direction !== record.direction) {
        flushLine();
        direction = record.direction;
        timestamp = record.timestamp;
        blockId = record.id;
        lineIndex = 0;
        previousWasCr = false;
      }
      const decoded = decodedText.get(record.id) ?? "";
      Array.from(decoded).forEach((character) => {
        if (timestamp === null) timestamp = record.timestamp;
        if (character === "\r") {
          flushLine(true);
          previousWasCr = true;
          return;
        }
        if (character === "\n") {
          if (!previousWasCr) {
            flushLine(true);
          } else {
            timestamp = null;
          }
          previousWasCr = false;
          return;
        }
        previousWasCr = false;
        text += character;
        if (Array.from(text).length >= textCharsPerLine) flushLine();
      });
    });
    flushLine();
    return lines;
  }, [decodedText, records, textCharsPerLine]);
  const hexLines = useMemo(() => {
    const lines: HexDisplayLine[] = [];
    let direction: SerialMonitorRecord["direction"] | null = null;
    let timestamp: number | null = null;
    let blockId = "";
    let lineIndex = 0;
    let data: number[] = [];
    let absoluteOffset = 0;
    let lineOffset = 0;

    function flushLine() {
      if (!direction || !data.length) return;
      lines.push({
        id: `${blockId}:${lineIndex}`,
        timestamp,
        direction,
        data,
        offset: lineOffset,
      });
      lineIndex += 1;
      timestamp = null;
      data = [];
    }

    records.forEach((record) => {
      if (direction !== record.direction) {
        flushLine();
        direction = record.direction;
        timestamp = record.timestamp;
        blockId = record.id;
        lineIndex = 0;
      }
      record.data.forEach((byte) => {
        if (!data.length) {
          lineOffset = absoluteOffset;
          timestamp = record.timestamp;
        }
        data.push(byte);
        absoluteOffset += 1;
        if (data.length >= HEX_BYTES_PER_LINE) flushLine();
      });
    });
    flushLine();
    return lines;
  }, [records]);
  const displayLength = mode === "hex" ? hexLines.length : textLines.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 20);
  const endIndex = Math.min(displayLength, startIndex + 120);
  const visibleTextLines = textLines.slice(startIndex, endIndex);
  const visibleHexLines = hexLines.slice(startIndex, endIndex);
  const offsetWidth = Math.max(
    4,
    (hexLines[hexLines.length - 1]?.offset ?? 0).toString(16).toUpperCase()
      .length,
  );

  function focusInput() {
    inputRef.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!active) return;
    queueMicrotask(() => inputRef.current?.focus({ preventScroll: true }));
  }, [active]);

  useEffect(() => {
    const monitor = monitorRef.current;
    const textMeasure = textMeasureRef.current;
    if (!monitor || !textMeasure) return;
    const monitorElement = monitor;
    const textMeasureElement = textMeasure;

    function updateBytesPerLine() {
      const monitorStyle = window.getComputedStyle(monitorElement);
      const horizontalPadding =
        Number.parseFloat(monitorStyle.paddingLeft) +
        Number.parseFloat(monitorStyle.paddingRight);
      const metadataWidth = 170 + 34;
      const rowPadding = 12;
      const textWidth = Math.max(
        1,
        monitorElement.clientWidth -
          horizontalPadding -
          metadataWidth -
          rowPadding -
          16,
      );
      const characterWidth = Math.max(
        1,
        textMeasureElement.getBoundingClientRect().width,
      );
      setTextCharsPerLine(Math.max(1, Math.floor(textWidth / characterWidth)));
    }

    updateBytesPerLine();
    const observer = new ResizeObserver(updateBytesPerLine);
    observer.observe(monitorElement);
    return () => observer.disconnect();
  }, [terminalFontFamilyMode, normalizedFontSize]);

  useLayoutEffect(() => {
    if (!shouldFollowOutputRef.current) return;
    const monitor = monitorRef.current;
    if (!monitor) return;
    monitor.scrollTop = monitor.scrollHeight;
    setScrollTop(monitor.scrollTop);
  }, [displayLength, mode, records, rowHeight, textCharsPerLine]);

  function selectMode(nextMode: DisplayMode) {
    setMode(nextMode);
    setMenu(null);
    queueMicrotask(focusInput);
  }

  function selectSendMode(nextMode: SendMode) {
    setSendMode(nextMode);
    setHexSendBuffer("");
    setCaptureValue("");
    setMenu(null);
    queueMicrotask(focusInput);
  }

  function sendHexInput(value: string) {
    const normalized = value
      .replace(/0x/gi, "")
      .replace(/[^\da-f]/gi, "")
      .toUpperCase();
    if (!normalized) return;
    const combined = `${hexSendBuffer}${normalized}`;
    const completeLength = combined.length - (combined.length % 2);
    const complete = combined.slice(0, completeLength);
    setHexSendBuffer(combined.slice(completeLength));
    if (!complete) return;
    const bytes = complete
      .match(/.{2}/g)
      ?.map((part) => Number.parseInt(part, 16));
    if (bytes?.length) void onSendBinary(bytes);
  }

  const menuItems: ContextMenuItem[] = [
    {
      label: t("terminal.menu.copy"),
      icon: <FiCopy />,
      disabled: !menu?.selectedText,
      onClick: () => {
        const selectedText = menu?.selectedText ?? "";
        setMenu(null);
        if (selectedText) void writeText(selectedText);
      },
    },
    {
      label: t("serial.debug.textDisplay"),
      icon: mode === "text" ? <FiCheck /> : <FiType />,
      onClick: () => selectMode("text"),
    },
    {
      label: t("serial.debug.textSend"),
      icon: sendMode === "text" ? <FiCheck /> : <FiType />,
      onClick: () => selectSendMode("text"),
    },
    {
      label: t("serial.debug.hexSend"),
      icon: sendMode === "hex" ? <FiCheck /> : <FiHash />,
      onClick: () => selectSendMode("hex"),
    },
    {
      label: t("serial.debug.hexDisplay"),
      icon: mode === "hex" ? <FiCheck /> : <FiHash />,
      onClick: () => selectMode("hex"),
    },
    {
      label: t("terminal.menu.clear"),
      icon: <FiSlash />,
      onClick: () => {
        shouldFollowOutputRef.current = true;
        onClear();
        setMenu(null);
      },
    },
    {
      label: t("serial.debug.export"),
      icon: <FiSave />,
      onClick: () => {
        setMenu(null);
        void onSave(mode);
      },
    },
  ];

  return (
    <div
      className="serial-debug-panel"
      data-ui="serial-debug-panel"
      style={
        {
          "--serial-terminal-font-family":
            terminalFontFamilyMode === "system"
              ? "var(--font-family-mono)"
              : terminalFontFamily,
          "--serial-terminal-font-size": `${normalizedFontSize}px`,
          "--serial-monitor-row-height": `${rowHeight}px`,
        } as React.CSSProperties
      }
      onClick={() => {
        if (!window.getSelection()?.toString()) focusInput();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          selectedText: window.getSelection()?.toString() ?? "",
        });
      }}
    >
      <div
        ref={monitorRef}
        className={`serial-monitor serial-monitor-${mode}`}
        data-slot="serial-monitor"
        onScroll={(event) => {
          const monitor = event.currentTarget;
          setScrollTop(monitor.scrollTop);
          if (wheelScrollIntentRef.current || pointerScrollIntentRef.current) {
            shouldFollowOutputRef.current =
              monitor.scrollHeight - monitor.scrollTop - monitor.clientHeight <=
              AUTO_SCROLL_THRESHOLD;
            wheelScrollIntentRef.current = false;
          }
        }}
        onWheel={() => {
          wheelScrollIntentRef.current = true;
        }}
        onPointerDown={() => {
          pointerScrollIntentRef.current = true;
          const handlePointerUp = () => {
            pointerScrollIntentRef.current = false;
          };
          window.addEventListener("pointerup", handlePointerUp, { once: true });
        }}
      >
        {records.length ? (
          <div
            className="serial-monitor-virtual-space"
            style={{ height: `${displayLength * rowHeight}px` }}
          >
            {mode === "hex"
              ? visibleHexLines.map((line, visibleIndex) => (
                  <div
                    key={line.id}
                    className={`serial-monitor-row ${line.direction}`}
                    style={{
                      top: `${(startIndex + visibleIndex) * rowHeight}px`,
                    }}
                  >
                    <time>
                      <span className="serial-monitor-time-value">
                        {line.timestamp === null
                          ? ""
                          : `[${formatLocalTimestamp(line.timestamp)}]`}
                      </span>
                      <span className="serial-monitor-offset">
                        {line.offset
                          .toString(16)
                          .toUpperCase()
                          .padStart(offsetWidth, "0")}
                      </span>
                    </time>
                    <strong>
                      {line.timestamp === null
                        ? ""
                        : line.direction.toUpperCase()}
                    </strong>
                    <code className="serial-monitor-hex-data">
                      {Array.from(
                        { length: Math.ceil(line.data.length / 4) },
                        (_, groupIndex) => (
                          <span
                            key={`${line.id}:group:${groupIndex}`}
                            className="serial-hex-group"
                          >
                            {groupIndex > 0 ? (
                              <span className="serial-hex-copy-space"> </span>
                            ) : null}
                            {line.data
                              .slice(groupIndex * 4, groupIndex * 4 + 4)
                              .map((byte, byteIndex) => (
                                <span
                                  key={`${line.id}:hex:${groupIndex}:${byteIndex}`}
                                  className={`serial-hex-byte ${
                                    byte < 0x20 || byte === 0x7f
                                      ? "control"
                                      : byte <= 0x7e
                                        ? "printable"
                                        : "extended"
                                  }`}
                                >
                                  {byteIndex > 0 ? " " : ""}
                                  {byte
                                    .toString(16)
                                    .padStart(2, "0")
                                    .toUpperCase()}
                                </span>
                              ))}
                          </span>
                        ),
                      )}
                    </code>
                    <code className="serial-monitor-ascii">
                      {formatAscii(line.data)}
                    </code>
                  </div>
                ))
              : visibleTextLines.map((line, visibleIndex) => (
                  <div
                    key={line.id}
                    className={`serial-monitor-row ${line.direction}`}
                    style={{
                      top: `${(startIndex + visibleIndex) * rowHeight}px`,
                    }}
                  >
                    <time>
                      <span className="serial-monitor-time-value">
                        {line.timestamp === null
                          ? ""
                          : `[${formatLocalTimestamp(line.timestamp)}]`}
                      </span>
                    </time>
                    <strong>
                      {line.timestamp === null
                        ? ""
                        : line.direction.toUpperCase()}
                    </strong>
                    <code className="serial-monitor-text">{line.text}</code>
                  </div>
                ))}
          </div>
        ) : (
          <div className="serial-monitor-empty">{t("serial.debug.empty")}</div>
        )}
      </div>
      <span
        ref={textMeasureRef}
        className="serial-text-measure"
        aria-hidden="true"
      >
        M
      </span>
      <textarea
        ref={inputRef}
        className="serial-keyboard-capture"
        value={captureValue}
        aria-label={t("serial.debug.keyboardInput")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          const value = event.target.value;
          if (composingRef.current) {
            setCaptureValue(value);
            return;
          }
          setCaptureValue("");
          if (!value) return;
          if (sendMode === "hex") {
            sendHexInput(value);
          } else {
            void onSendText(value);
          }
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          const value = event.currentTarget.value;
          setCaptureValue("");
          if (!value) return;
          if (sendMode === "hex") {
            sendHexInput(value);
          } else {
            void onSendText(value);
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (sendMode === "hex") {
            if (event.ctrlKey && event.key.toLowerCase() === "v") return;
            if (event.key === "Backspace") {
              event.preventDefault();
              setHexSendBuffer((current) => current.slice(0, -1));
              return;
            }
            if (event.key.length > 1 || /\s/.test(event.key)) {
              event.preventDefault();
            }
            return;
          }
          const sequence = resolveControlSequence(event, profile.lineEnding);
          if (!sequence) return;
          event.preventDefault();
          void onSendText(sequence);
        }}
        onPaste={(event) => {
          event.preventDefault();
          const value = event.clipboardData.getData("text");
          if (!value) return;
          if (sendMode === "hex") {
            sendHexInput(value);
          } else {
            void onSendText(value);
          }
        }}
      />
      {sendMode === "hex" ? (
        <div
          className="serial-send-mode-indicator"
          data-ui="serial-hex-send-state"
        >
          {t("serial.debug.hexSendState", {
            pending: hexSendBuffer ? `${hexSendBuffer}_` : "--",
          })}
        </div>
      ) : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => {
            setMenu(null);
            queueMicrotask(focusInput);
          }}
        />
      ) : null}
      <span className="serial-debug-session-id" aria-hidden="true">
        {sessionId}
      </span>
    </div>
  );
}
