/**
 * 终端 AI 配置持久化模块。
 * 职责：
 * 1. 读写 ai/ai.json 配置文件。
 * 2. 管理终端 AI 助手偏好与接入列表（快速接入 + 兼容接入）。
 * 3. 采用“内存态缓存 + 防抖异步落盘”模式。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { debug, warn } from "@/shared/logging/telemetry";
import {
  aiProviderTest,
  aiSettingsGet,
  aiSettingsSave,
} from "@/features/ai/core/commands";
import { extractErrorMessage } from "@/shared/errors/appError";
import type {
  AiProviderInput,
  AiProviderVendor,
  AiSettingsSaveInput,
  AiSettingsView,
  AiProviderView,
  SecretFieldUpdate,
} from "@/features/ai/types";
import { PERSISTENCE_SAVE_DEBOUNCE_MS } from "@/constants/persistence";
import { getAiProviderPreset } from "@/constants/aiProviders";

type UseAiSettingsResult = {
  aiAvailable: boolean;
  aiUnavailableReason: string | null;
  selectionMaxChars: number;
  sessionRecentOutputMaxChars: number;
  requestTimeoutMs: number;
  debugLoggingEnabled: boolean;
  activeProviderId: string;
  providers: AiProviderView[];
  activeProvider: AiProviderView | null;
  aiSettingsLoaded: boolean;
  setSelectionMaxChars: React.Dispatch<React.SetStateAction<number>>;
  setSessionRecentOutputMaxChars: React.Dispatch<React.SetStateAction<number>>;
  setRequestTimeoutMs: React.Dispatch<React.SetStateAction<number>>;
  setDebugLoggingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveProviderId: React.Dispatch<React.SetStateAction<string>>;
  updateProviderName: (providerId: string, value: string) => void;
  updateProviderBaseUrl: (providerId: string, value: string) => void;
  updateProviderModel: (providerId: string, value: string) => void;
  updateProviderVendor: (providerId: string, vendor: AiProviderVendor) => void;
  addPresetProvider: (vendor?: AiProviderVendor, name?: string) => string;
  addPresetProviderWithConfig: (input: {
    vendor?: AiProviderVendor;
    name: string;
    model: string;
    apiKey: string;
  }) => Promise<string>;
  addCompatibleProviderWithConfig: (input: {
    name: string;
    baseUrl: string;
    model: string;
    apiKey: string;
  }) => Promise<string>;
  addCompatibleProvider: () => string;
  removeProvider: (providerId: string) => void;
  testProviderConnection: (providerId?: string) => Promise<void>;
  replaceProviderApiKey: (providerId: string, value: string) => Promise<void>;
  clearProviderApiKey: (providerId: string) => Promise<void>;
  saveState: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  retrySave: () => void;
};

const MIN_AI_TEXT_LIMIT = 100;
const MAX_AI_TEXT_LIMIT = 20_000;
const MIN_AI_REQUEST_TIMEOUT_MS = 1_000;
const MAX_AI_REQUEST_TIMEOUT_MS = 120_000;

const DEFAULT_AI_SETTINGS: AiSettingsView = {
  version: 1,
  selectionMaxChars: 1500,
  sessionRecentOutputMaxChars: 1200,
  sessionRecentOutputMaxSnippets: 4,
  selectionRecentOutputMaxChars: 600,
  selectionRecentOutputMaxSnippets: 2,
  requestCacheTtlMs: 15000,
  requestTimeoutMs: 20000,
  debugLoggingEnabled: true,
  activeProviderId: "",
  providers: [],
};

function normalizeTextLimit(value: number) {
  return Math.max(
    MIN_AI_TEXT_LIMIT,
    Math.min(MAX_AI_TEXT_LIMIT, Math.round(value)),
  );
}

function normalizeRequestTimeoutMs(value: number) {
  return Math.max(
    MIN_AI_REQUEST_TIMEOUT_MS,
    Math.min(MAX_AI_REQUEST_TIMEOUT_MS, Math.round(value)),
  );
}

function computeAiAvailability(config: AiProviderView | null) {
  if (!config?.baseUrl.trim() || !config.model.trim()) {
    return {
      aiAvailable: false,
      aiUnavailableReason: "provider_incomplete",
    };
  }
  return { aiAvailable: true, aiUnavailableReason: null };
}

function buildProviderName(vendor: AiProviderVendor, index: number) {
  const preset = getAiProviderPreset(vendor);
  if (preset) return `${preset.label} ${index}`;
  return `Compatible ${index}`;
}

function buildSaveInput(
  source: {
    selectionMaxChars: number;
    sessionRecentOutputMaxChars: number;
    requestTimeoutMs: number;
    debugLoggingEnabled: boolean;
    activeProviderId: string;
    providers: AiProviderView[];
  },
  lastLoaded: AiSettingsView,
  overrides: Record<string, SecretFieldUpdate> = {},
): AiSettingsSaveInput {
  return {
    selectionMaxChars: normalizeTextLimit(source.selectionMaxChars),
    sessionRecentOutputMaxChars: normalizeTextLimit(
      source.sessionRecentOutputMaxChars,
    ),
    sessionRecentOutputMaxSnippets: lastLoaded.sessionRecentOutputMaxSnippets,
    selectionRecentOutputMaxChars: lastLoaded.selectionRecentOutputMaxChars,
    selectionRecentOutputMaxSnippets:
      lastLoaded.selectionRecentOutputMaxSnippets,
    requestCacheTtlMs: lastLoaded.requestCacheTtlMs,
    requestTimeoutMs: normalizeRequestTimeoutMs(source.requestTimeoutMs),
    debugLoggingEnabled: source.debugLoggingEnabled,
    activeProviderId: source.activeProviderId,
    providers: source.providers.map<AiProviderInput>((provider) => ({
      id: provider.id,
      mode: provider.mode,
      vendor: provider.vendor,
      name: provider.name.trim(),
      baseUrl: provider.baseUrl.trim(),
      model: provider.model.trim(),
      apiKey: overrides[provider.id] ?? { mode: "keep" },
    })),
  };
}

function buildPresetProvider(
  vendor: AiProviderVendor,
  count: number,
): AiProviderView {
  const preset = getAiProviderPreset(vendor);
  return {
    id: crypto.randomUUID(),
    mode: "preset",
    vendor,
    name: buildProviderName(vendor, count + 1),
    baseUrl: preset?.defaultBaseUrl ?? "",
    model: preset?.models[0] ?? "",
    apiKeyConfigured: false,
  };
}

function buildCompatibleProvider(count: number): AiProviderView {
  return {
    id: crypto.randomUUID(),
    mode: "compatible",
    vendor: "custom",
    name: buildProviderName("custom", count + 1),
    baseUrl: "",
    model: "",
    apiKeyConfigured: false,
  };
}

export default function useAiSettings(): UseAiSettingsResult {
  const [selectionMaxChars, setSelectionMaxChars] = useState(
    DEFAULT_AI_SETTINGS.selectionMaxChars,
  );
  const [sessionRecentOutputMaxChars, setSessionRecentOutputMaxChars] =
    useState(DEFAULT_AI_SETTINGS.sessionRecentOutputMaxChars);
  const [requestTimeoutMs, setRequestTimeoutMs] = useState(
    DEFAULT_AI_SETTINGS.requestTimeoutMs,
  );
  const [debugLoggingEnabled, setDebugLoggingEnabled] = useState(
    DEFAULT_AI_SETTINGS.debugLoggingEnabled,
  );
  const [activeProviderId, setActiveProviderId] = useState(
    DEFAULT_AI_SETTINGS.activeProviderId,
  );
  const [providers, setProviders] = useState<AiProviderView[]>(
    DEFAULT_AI_SETTINGS.providers,
  );
  const [aiSettingsLoaded, setAiSettingsLoaded] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveRetryToken, setSaveRetryToken] = useState(0);

  const loadedRef = useRef(false);
  const savingSecretRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const lastSavedConfigRef = useRef<string>("");
  const lastLoadedViewRef = useRef<AiSettingsView>(DEFAULT_AI_SETTINGS);
  const lastLoggedActiveProviderIdRef = useRef("");

  const activeProvider = useMemo(
    () => providers.find((config) => config.id === activeProviderId) ?? null,
    [activeProviderId, providers],
  );
  const availability = useMemo(
    () => computeAiAvailability(activeProvider),
    [activeProvider],
  );

  useEffect(() => {
    let active = true;
    aiSettingsGet()
      .then((settings) => {
        if (!active) return;
        lastLoadedViewRef.current = settings;
        setSelectionMaxChars(settings.selectionMaxChars);
        setSessionRecentOutputMaxChars(settings.sessionRecentOutputMaxChars);
        setRequestTimeoutMs(settings.requestTimeoutMs);
        setDebugLoggingEnabled(settings.debugLoggingEnabled);
        setActiveProviderId(settings.activeProviderId);
        setProviders(settings.providers);
        lastSavedConfigRef.current = JSON.stringify(
          buildSaveInput(
            {
              selectionMaxChars: settings.selectionMaxChars,
              sessionRecentOutputMaxChars: settings.sessionRecentOutputMaxChars,
              requestTimeoutMs: settings.requestTimeoutMs,
              debugLoggingEnabled: settings.debugLoggingEnabled,
              activeProviderId: settings.activeProviderId,
              providers: settings.providers,
            },
            settings,
          ),
        );
        void debug(
          JSON.stringify({
            event: "ai.settings.loaded",
            providerCount: settings.providers.length,
            activeProviderPresent: Boolean(settings.activeProviderId),
            debugLoggingEnabled: settings.debugLoggingEnabled,
            selectionMaxChars: settings.selectionMaxChars,
            sessionRecentOutputMaxChars: settings.sessionRecentOutputMaxChars,
          }),
        );
      })
      .catch((error) => {
        if (!active) return;
        void warn(
          JSON.stringify({
            event: "ai.settings.load.failed",
            error: extractErrorMessage(error),
          }),
        ).catch(() => {});
      })
      .finally(() => {
        if (!active) return;
        loadedRef.current = true;
        setAiSettingsLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!loadedRef.current || savingSecretRef.current) return;
    const nextSaveInput = buildSaveInput(
      {
        selectionMaxChars,
        sessionRecentOutputMaxChars,
        requestTimeoutMs,
        debugLoggingEnabled,
        activeProviderId,
        providers,
      },
      lastLoadedViewRef.current,
    );
    const configStr = JSON.stringify(nextSaveInput);
    if (configStr === lastSavedConfigRef.current) return;

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    setSaveState("saving");
    setSaveError(null);

    void debug(
      JSON.stringify({
        event: "ai.settings.save.scheduled",
        debounce: PERSISTENCE_SAVE_DEBOUNCE_MS,
      }),
    );

    saveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const saved = await aiSettingsSave(nextSaveInput);
          lastLoadedViewRef.current = saved;
          lastSavedConfigRef.current = configStr;
          setSaveState("saved");
          void debug(JSON.stringify({ event: "ai.settings.persisted" }));
        } catch (error) {
          setSaveState("error");
          setSaveError(extractErrorMessage(error));
          void warn(
            JSON.stringify({
              event: "ai.settings.save.failed",
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
    selectionMaxChars,
    sessionRecentOutputMaxChars,
    requestTimeoutMs,
    debugLoggingEnabled,
    activeProviderId,
    providers,
    saveRetryToken,
  ]);

  useEffect(() => {
    if (!loadedRef.current) return;
    if (lastLoggedActiveProviderIdRef.current === activeProviderId) return;
    lastLoggedActiveProviderIdRef.current = activeProviderId;
    debug(
      JSON.stringify({
        event: "ai.settings.active.provider.changed",
        id: activeProviderId,
      }),
    ).catch(() => {});
  }, [activeProviderId]);

  function updateProvider(
    providerId: string,
    updater: (provider: AiProviderView) => AiProviderView,
  ) {
    setProviders((current) =>
      current.map((item) => (item.id === providerId ? updater(item) : item)),
    );
  }

  async function saveWithSecretUpdate(
    overrides: Record<string, SecretFieldUpdate>,
  ) {
    savingSecretRef.current = true;
    try {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      setSaveState("saving");
      setSaveError(null);
      const nextSaveInput = buildSaveInput(
        {
          selectionMaxChars,
          sessionRecentOutputMaxChars,
          requestTimeoutMs,
          debugLoggingEnabled,
          activeProviderId,
          providers,
        },
        lastLoadedViewRef.current,
        overrides,
      );
      const saved = await aiSettingsSave(nextSaveInput);
      lastLoadedViewRef.current = saved;
      lastSavedConfigRef.current = JSON.stringify(nextSaveInput);
      setProviders(saved.providers);
      setActiveProviderId(saved.activeProviderId);
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      setSaveError(extractErrorMessage(error));
      throw error;
    } finally {
      savingSecretRef.current = false;
    }
  }

  function retrySave() {
    setSaveRetryToken((current) => current + 1);
  }

  function addPresetProvider(
    vendor: AiProviderVendor = "deepseek",
    name?: string,
  ) {
    const normalizedVendor = vendor === "custom" ? "deepseek" : vendor;
    const next = buildPresetProvider(normalizedVendor, providers.length);
    if (name?.trim()) {
      next.name = name.trim();
    }
    setProviders((current) => [...current, next]);
    return next.id;
  }

  async function addPresetProviderWithConfig(input: {
    vendor?: AiProviderVendor;
    name: string;
    model: string;
    apiKey: string;
  }) {
    const normalizedVendor =
      input.vendor && input.vendor !== "custom" ? input.vendor : "deepseek";
    const next = buildPresetProvider(normalizedVendor, providers.length);
    next.name = input.name.trim();
    next.model = input.model.trim();
    const apiKey = input.apiKey.trim();
    if (!next.name) {
      throw new Error("provider_name_required");
    }
    if (!next.model) {
      throw new Error("provider_model_required");
    }
    savingSecretRef.current = true;
    try {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      setSaveState("saving");
      setSaveError(null);
      const nextProviders = [...providers, next];
      const nextSaveInput = buildSaveInput(
        {
          selectionMaxChars,
          sessionRecentOutputMaxChars,
          requestTimeoutMs,
          debugLoggingEnabled,
          activeProviderId,
          providers: nextProviders,
        },
        lastLoadedViewRef.current,
        apiKey ? { [next.id]: { mode: "replace", value: apiKey } } : {},
      );
      const saved = await aiSettingsSave(nextSaveInput);
      lastLoadedViewRef.current = saved;
      lastSavedConfigRef.current = JSON.stringify(nextSaveInput);
      setProviders(saved.providers);
      setActiveProviderId(saved.activeProviderId);
      setSaveState("saved");
      return next.id;
    } catch (error) {
      setSaveState("error");
      setSaveError(extractErrorMessage(error));
      throw error;
    } finally {
      savingSecretRef.current = false;
    }
  }

  async function addCompatibleProviderWithConfig(input: {
    name: string;
    baseUrl: string;
    model: string;
    apiKey: string;
  }) {
    const next = buildCompatibleProvider(providers.length);
    next.name = input.name.trim();
    next.baseUrl = input.baseUrl.trim();
    next.model = input.model.trim();
    const apiKey = input.apiKey.trim();
    if (!next.name) {
      throw new Error("provider_name_required");
    }
    if (!next.baseUrl) {
      throw new Error("provider_base_url_required");
    }
    if (!next.model) {
      throw new Error("provider_model_required");
    }
    savingSecretRef.current = true;
    try {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      setSaveState("saving");
      setSaveError(null);
      const nextProviders = [...providers, next];
      const nextSaveInput = buildSaveInput(
        {
          selectionMaxChars,
          sessionRecentOutputMaxChars,
          requestTimeoutMs,
          debugLoggingEnabled,
          activeProviderId,
          providers: nextProviders,
        },
        lastLoadedViewRef.current,
        apiKey ? { [next.id]: { mode: "replace", value: apiKey } } : {},
      );
      const saved = await aiSettingsSave(nextSaveInput);
      lastLoadedViewRef.current = saved;
      lastSavedConfigRef.current = JSON.stringify(nextSaveInput);
      setProviders(saved.providers);
      setActiveProviderId(saved.activeProviderId);
      setSaveState("saved");
      return next.id;
    } catch (error) {
      setSaveState("error");
      setSaveError(extractErrorMessage(error));
      throw error;
    } finally {
      savingSecretRef.current = false;
    }
  }

  function addCompatibleProvider() {
    const next = buildCompatibleProvider(providers.length);
    setProviders((current) => [...current, next]);
    return next.id;
  }

  function removeProvider(providerId: string) {
    const targetId = providerId.trim();
    if (!targetId) return;
    setProviders((current) => {
      const next = current.filter((item) => item.id !== targetId);
      setActiveProviderId((currentActiveId) =>
        currentActiveId === targetId ? "" : currentActiveId,
      );
      return next;
    });
  }

  async function replaceProviderApiKey(providerId: string, value: string) {
    const trimmed = value.trim();
    const targetId = providerId.trim();
    if (!trimmed || !targetId) return;
    await saveWithSecretUpdate({
      [targetId]: { mode: "replace", value: trimmed },
    });
  }

  async function clearProviderApiKey(providerId: string) {
    const targetId = providerId.trim();
    if (!targetId) return;
    await saveWithSecretUpdate({ [targetId]: { mode: "clear" } });
  }

  async function testProviderConnection(providerId?: string) {
    const targetId = providerId?.trim();
    const nextSaveInput = buildSaveInput(
      {
        selectionMaxChars,
        sessionRecentOutputMaxChars,
        requestTimeoutMs,
        debugLoggingEnabled,
        activeProviderId,
        providers,
      },
      lastLoadedViewRef.current,
    );
    // 测试前先强制落盘，避免防抖窗口内后端仍读取到旧配置。
    const saved = await aiSettingsSave(nextSaveInput);
    lastLoadedViewRef.current = saved;
    lastSavedConfigRef.current = JSON.stringify(nextSaveInput);
    setProviders(saved.providers);
    setActiveProviderId(saved.activeProviderId);
    setSaveState("saved");
    await aiProviderTest(targetId || undefined);
  }

  return {
    aiAvailable: availability.aiAvailable,
    aiUnavailableReason: availability.aiUnavailableReason,
    selectionMaxChars: normalizeTextLimit(selectionMaxChars),
    sessionRecentOutputMaxChars: normalizeTextLimit(
      sessionRecentOutputMaxChars,
    ),
    requestTimeoutMs: normalizeRequestTimeoutMs(requestTimeoutMs),
    debugLoggingEnabled,
    activeProviderId,
    providers,
    activeProvider,
    aiSettingsLoaded,
    setSelectionMaxChars,
    setSessionRecentOutputMaxChars,
    setRequestTimeoutMs,
    setDebugLoggingEnabled,
    setActiveProviderId,
    updateProviderName: (providerId, value) => {
      updateProvider(providerId, (provider) => ({ ...provider, name: value }));
    },
    updateProviderBaseUrl: (providerId, value) => {
      updateProvider(providerId, (provider) => ({
        ...provider,
        baseUrl: value,
      }));
    },
    updateProviderModel: (providerId, value) => {
      updateProvider(providerId, (provider) => ({ ...provider, model: value }));
    },
    updateProviderVendor: (providerId, vendor) => {
      updateProvider(providerId, (provider) => {
        const preset = getAiProviderPreset(vendor);
        if (!preset) {
          return {
            ...provider,
            vendor,
            mode: "compatible",
          };
        }
        return {
          ...provider,
          vendor,
          mode: "preset",
          baseUrl: preset.defaultBaseUrl,
          model: preset.models[0] ?? provider.model,
          name: provider.name.trim() || preset.label,
        };
      });
    },
    addPresetProvider,
    addPresetProviderWithConfig,
    addCompatibleProviderWithConfig,
    addCompatibleProvider,
    removeProvider,
    testProviderConnection,
    replaceProviderApiKey,
    clearProviderApiKey,
    saveState,
    saveError,
    retrySave,
  };
}
