/**
 * 会话设置持久化模块。
 * 职责：
 * 1. 读写 session.json 配置文件。
 * 2. 管理终端域全局配置（回滚行数、资源监控开关、Host Key 策略等）。
 * 3. 采用“内存态缓存 + 防抖异步落盘”模式，通过 JSON 脏检查避免重复 I/O。
 */
import { useEffect, useRef, useState } from "react";
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { debug, warn } from "@/shared/logging/telemetry";
import { extractErrorMessage } from "@/shared/errors/appError";
import {
  getTerminalConfigDir,
  getSessionSettingsPath,
} from "@/shared/config/paths";
import { PERSISTENCE_SAVE_DEBOUNCE_MS } from "@/constants/persistence";
import {
  DEFAULT_TERMINAL_WORD_SEPARATORS,
  normalizeTerminalWordSeparators,
} from "@/constants/terminalWordSeparators";
import {
  DEFAULT_TERMINAL_CURSOR_STYLE,
  normalizeTerminalCursorStyle,
  type TerminalCursorStyle,
} from "@/constants/terminalCursorStyle";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";

/** 终端域全局配置结构。 */
type SessionSettings = {
  version: 1;
  webLinksEnabled?: boolean;
  commandAutocompleteEnabled?: boolean;
  selectionAutoCopyEnabled?: boolean;
  autoReconnectOnPoweroff?: boolean;
  autoReconnectOnReboot?: boolean;
  cursorStyle?: TerminalCursorStyle;
  wordSeparators?: string;
  scrollback?: number;
  terminalPathSyncEnabled?: boolean;
  resourceMonitorEnabled?: boolean;
  resourceMonitorIntervalSec?: number;
  hostKeyPolicy?: HostKeyPolicy;
};

/** SSH 主机密钥校验策略。 */
export type HostKeyPolicy = "ask" | "strict" | "off";

/** useSessionSettings 返回的配置与操作接口。 */
type UseSessionSettingsResult = {
  webLinksEnabled: boolean;
  commandAutocompleteEnabled: boolean;
  selectionAutoCopyEnabled: boolean;
  autoReconnectOnPoweroff: boolean;
  autoReconnectOnReboot: boolean;
  cursorStyle: TerminalCursorStyle;
  wordSeparators: string;
  scrollback: number;
  terminalPathSyncEnabled: boolean;
  resourceMonitorEnabled: boolean;
  resourceMonitorIntervalSec: number;
  hostKeyPolicy: HostKeyPolicy;
  setWebLinksEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setCommandAutocompleteEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectionAutoCopyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setAutoReconnectOnPoweroff: React.Dispatch<React.SetStateAction<boolean>>;
  setAutoReconnectOnReboot: React.Dispatch<React.SetStateAction<boolean>>;
  setCursorStyle: React.Dispatch<React.SetStateAction<TerminalCursorStyle>>;
  setWordSeparators: React.Dispatch<React.SetStateAction<string>>;
  setScrollback: React.Dispatch<React.SetStateAction<number>>;
  setTerminalPathSyncEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setResourceMonitorEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setResourceMonitorIntervalSec: React.Dispatch<React.SetStateAction<number>>;
  setHostKeyPolicy: React.Dispatch<React.SetStateAction<HostKeyPolicy>>;
  sessionSettingsLoaded: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  retrySave: () => void;
};

/** 终端回滚行数阈值：100 - 50,000。 */
export const MIN_SCROLLBACK = 100;
export const MAX_SCROLLBACK = 50000;
/** 资源监控最小间隔：3 秒。 */
export const MIN_RESOURCE_MONITOR_INTERVAL_SEC = 3;
export const DEFAULT_RESOURCE_MONITOR_INTERVAL_SEC = 5;

/** 归一化回滚行数。 */
function normalizeScrollback(value: number) {
  return Math.max(MIN_SCROLLBACK, Math.min(MAX_SCROLLBACK, Math.round(value)));
}

/** 归一化资源监控间隔。 */
function normalizeResourceMonitorIntervalSec(value: number) {
  return Math.max(MIN_RESOURCE_MONITOR_INTERVAL_SEC, Math.round(value));
}

/** 终端配置默认值。 */
const defaultSessionSettings: Required<
  Pick<
    SessionSettings,
    | "webLinksEnabled"
    | "commandAutocompleteEnabled"
    | "selectionAutoCopyEnabled"
    | "autoReconnectOnPoweroff"
    | "autoReconnectOnReboot"
    | "cursorStyle"
    | "wordSeparators"
    | "scrollback"
    | "terminalPathSyncEnabled"
    | "resourceMonitorEnabled"
    | "resourceMonitorIntervalSec"
    | "hostKeyPolicy"
  >
> = {
  webLinksEnabled: true,
  commandAutocompleteEnabled: true,
  selectionAutoCopyEnabled: false,
  autoReconnectOnPoweroff: false,
  autoReconnectOnReboot: true,
  cursorStyle: DEFAULT_TERMINAL_CURSOR_STYLE,
  wordSeparators: DEFAULT_TERMINAL_WORD_SEPARATORS,
  scrollback: 3000,
  terminalPathSyncEnabled: true,
  resourceMonitorEnabled: false,
  resourceMonitorIntervalSec: DEFAULT_RESOURCE_MONITOR_INTERVAL_SEC,
  hostKeyPolicy: "ask",
};

/**
 * 会话设置核心 Hook。
 * 通过内存状态即时响应 UI，并在静默期自动落盘。
 */
export default function useSessionSettings(): UseSessionSettingsResult {
  const [webLinksEnabled, setWebLinksEnabled] = useState(
    defaultSessionSettings.webLinksEnabled,
  );
  const [commandAutocompleteEnabled, setCommandAutocompleteEnabled] = useState(
    defaultSessionSettings.commandAutocompleteEnabled,
  );
  const [selectionAutoCopyEnabled, setSelectionAutoCopyEnabled] = useState(
    defaultSessionSettings.selectionAutoCopyEnabled,
  );
  const [autoReconnectOnPoweroff, setAutoReconnectOnPoweroff] = useState(
    defaultSessionSettings.autoReconnectOnPoweroff,
  );
  const [autoReconnectOnReboot, setAutoReconnectOnReboot] = useState(
    defaultSessionSettings.autoReconnectOnReboot,
  );
  const [cursorStyle, setCursorStyle] = useState<TerminalCursorStyle>(
    defaultSessionSettings.cursorStyle,
  );
  const [wordSeparators, setWordSeparators] = useState(
    defaultSessionSettings.wordSeparators,
  );
  const [scrollback, setScrollback] = useState(
    defaultSessionSettings.scrollback,
  );
  const [terminalPathSyncEnabled, setTerminalPathSyncEnabled] = useState(
    defaultSessionSettings.terminalPathSyncEnabled,
  );
  const [resourceMonitorEnabled, setResourceMonitorEnabled] = useState(
    defaultSessionSettings.resourceMonitorEnabled,
  );
  const [resourceMonitorIntervalSec, setResourceMonitorIntervalSec] = useState(
    defaultSessionSettings.resourceMonitorIntervalSec,
  );
  const [hostKeyPolicy, setHostKeyPolicy] = useState<HostKeyPolicy>(
    defaultSessionSettings.hostKeyPolicy,
  );
  const [sessionSettingsLoaded, setSessionSettingsLoaded] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveRetryToken, setSaveRetryToken] = useState(0);

  // 引用守卫：loadedRef 标记初始数据已就绪，saveTimerRef 控制防抖，lastSavedConfigRef 进行脏检查。
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const lastSavedConfigRef = useRef<string>("");

  /** 执行实际的文件读取与状态反填。 */
  async function loadSessionSettings() {
    try {
      const path = await getSessionSettingsPath();
      if (!(await exists(path))) {
        void debug(
          JSON.stringify({
            event: "session.settings.load.skip",
            reason: "file-not-exists",
          }),
        );
        return;
      }
      const raw = await readTextFile(path);
      const parsed = JSON.parse(raw) as SessionSettings;

      if (typeof parsed?.webLinksEnabled === "boolean") {
        setWebLinksEnabled(parsed.webLinksEnabled);
      }
      if (typeof parsed?.commandAutocompleteEnabled === "boolean") {
        setCommandAutocompleteEnabled(parsed.commandAutocompleteEnabled);
      }
      if (typeof parsed?.selectionAutoCopyEnabled === "boolean") {
        setSelectionAutoCopyEnabled(parsed.selectionAutoCopyEnabled);
      }
      if (typeof parsed?.autoReconnectOnPoweroff === "boolean") {
        setAutoReconnectOnPoweroff(parsed.autoReconnectOnPoweroff);
      }
      if (typeof parsed?.autoReconnectOnReboot === "boolean") {
        setAutoReconnectOnReboot(parsed.autoReconnectOnReboot);
      }
      {
        const nextCursorStyle = normalizeTerminalCursorStyle(
          parsed?.cursorStyle,
        );
        if (nextCursorStyle) {
          setCursorStyle(nextCursorStyle);
        }
      }
      if (typeof parsed?.wordSeparators === "string") {
        setWordSeparators(
          normalizeTerminalWordSeparators(parsed.wordSeparators) ??
            defaultSessionSettings.wordSeparators,
        );
      }
      if (typeof parsed?.terminalPathSyncEnabled === "boolean") {
        setTerminalPathSyncEnabled(parsed.terminalPathSyncEnabled);
      }
      if (typeof parsed?.resourceMonitorEnabled === "boolean") {
        setResourceMonitorEnabled(parsed.resourceMonitorEnabled);
      }
      if (
        parsed?.hostKeyPolicy === "ask" ||
        parsed?.hostKeyPolicy === "strict" ||
        parsed?.hostKeyPolicy === "off"
      ) {
        setHostKeyPolicy(parsed.hostKeyPolicy);
      }
      if (typeof parsed?.scrollback === "number") {
        setScrollback(normalizeScrollback(parsed.scrollback));
      }
      if (typeof parsed?.resourceMonitorIntervalSec === "number") {
        setResourceMonitorIntervalSec(
          normalizeResourceMonitorIntervalSec(
            parsed.resourceMonitorIntervalSec,
          ),
        );
      }
      void debug(
        JSON.stringify({
          event: "session.settings.loaded",
          keyCount: Object.keys(parsed ?? {}).length,
          resourceMonitorEnabled: parsed?.resourceMonitorEnabled === true,
          terminalPathSyncEnabled: parsed?.terminalPathSyncEnabled === true,
        }),
      );
    } catch (error) {
      void warn(
        JSON.stringify({
          event: "session.settings.load.failed",
          error: extractErrorMessage(error),
        }),
      );
    } finally {
      loadedRef.current = true;
      setSessionSettingsLoaded(true);
    }
  }

  /** 将内存配置持久化到文件系统。 */
  async function saveSessionSettings(payload: SessionSettings) {
    const dir = await getTerminalConfigDir();
    await mkdir(dir, { recursive: true });
    const path = await getSessionSettingsPath();
    await writeTextFile(path, JSON.stringify(payload, null, 2));
  }

  // 启动初始化。
  useEffect(() => {
    const cancel = scheduleDeferredTask(() => {
      void loadSessionSettings().catch(() => {
        loadedRef.current = true;
        setSessionSettingsLoaded(true);
      });
    });
    return cancel;
  }, []);

  // 防抖异步落盘逻辑。
  useEffect(() => {
    if (!loadedRef.current) return;

    const currentConfig: SessionSettings = {
      version: 1,
      webLinksEnabled,
      commandAutocompleteEnabled,
      selectionAutoCopyEnabled,
      autoReconnectOnPoweroff,
      autoReconnectOnReboot,
      cursorStyle:
        normalizeTerminalCursorStyle(cursorStyle) ??
        defaultSessionSettings.cursorStyle,
      wordSeparators:
        normalizeTerminalWordSeparators(wordSeparators) ??
        defaultSessionSettings.wordSeparators,
      terminalPathSyncEnabled,
      resourceMonitorEnabled,
      scrollback: normalizeScrollback(scrollback),
      resourceMonitorIntervalSec: normalizeResourceMonitorIntervalSec(
        resourceMonitorIntervalSec,
      ),
      hostKeyPolicy,
    };

    const configStr = JSON.stringify(currentConfig);
    // 脏检查：若序列化结果一致，说明内存状态变更不涉及配置落盘（可能仅是引用变动）。
    if (configStr === lastSavedConfigRef.current) {
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    setSaveState("saving");
    setSaveError(null);

    void debug(
      JSON.stringify({
        event: "session.settings.save.scheduled",
        debounce: PERSISTENCE_SAVE_DEBOUNCE_MS,
      }),
    );

    saveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          await saveSessionSettings(currentConfig);
          lastSavedConfigRef.current = configStr;
          setSaveState("saved");
          void debug(JSON.stringify({ event: "session.settings.persisted" }));
        } catch (error) {
          setSaveState("error");
          setSaveError(extractErrorMessage(error));
          void warn(
            JSON.stringify({
              event: "session.settings.save.failed",
              error: extractErrorMessage(error),
            }),
          );
        }
      })();
    }, PERSISTENCE_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    webLinksEnabled,
    commandAutocompleteEnabled,
    selectionAutoCopyEnabled,
    autoReconnectOnPoweroff,
    autoReconnectOnReboot,
    cursorStyle,
    wordSeparators,
    scrollback,
    terminalPathSyncEnabled,
    resourceMonitorEnabled,
    resourceMonitorIntervalSec,
    hostKeyPolicy,
    saveRetryToken,
  ]);

  /** 手动触发一次会话设置重试保存。 */
  function retrySave() {
    setSaveRetryToken((current) => current + 1);
  }

  return {
    webLinksEnabled,
    commandAutocompleteEnabled,
    selectionAutoCopyEnabled,
    autoReconnectOnPoweroff,
    autoReconnectOnReboot,
    cursorStyle:
      normalizeTerminalCursorStyle(cursorStyle) ??
      defaultSessionSettings.cursorStyle,
    wordSeparators:
      normalizeTerminalWordSeparators(wordSeparators) ??
      defaultSessionSettings.wordSeparators,
    scrollback: normalizeScrollback(scrollback),
    terminalPathSyncEnabled,
    resourceMonitorEnabled,
    resourceMonitorIntervalSec: normalizeResourceMonitorIntervalSec(
      resourceMonitorIntervalSec,
    ),
    hostKeyPolicy,
    setWebLinksEnabled,
    setCommandAutocompleteEnabled,
    setSelectionAutoCopyEnabled,
    setAutoReconnectOnPoweroff,
    setAutoReconnectOnReboot,
    setCursorStyle,
    setWordSeparators,
    setScrollback,
    setTerminalPathSyncEnabled,
    setResourceMonitorEnabled,
    setResourceMonitorIntervalSec,
    setHostKeyPolicy,
    sessionSettingsLoaded,
    saveState,
    saveError,
    retrySave,
  };
}
