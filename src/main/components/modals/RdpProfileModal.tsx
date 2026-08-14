import { useCallback, useEffect, useMemo, useState } from "react";
import { FiPlus } from "react-icons/fi";
import Modal from "@/components/ui/modal/Modal";
import Button from "@/components/ui/button";
import Select from "@/components/ui/select";
import { ROOT_PROFILE_GROUP_VALUE } from "@/constants/hostGroups";
import type { Translate, TranslationKey } from "@/i18n";
import { saveRdpProfile } from "@/features/rdp/core/commands";
import { translateAppError } from "@/shared/errors/appError";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import type {
  CredentialReuseMode,
  CredentialSummary,
  RdpDisplayStrategy,
  RdpPerformanceFlags,
  RdpProfile,
} from "@/types";
import type { CredentialSaveInput } from "@/features/credential/core/commands";
import ProfileCredentialSelector from "@/features/credential/components/ProfileCredentialSelector";
import "@/main/components/modals/ProfileModal.css";
import "@/main/components/modals/RdpProfileModal.css";

type RdpProfileModalProps = {
  open: boolean;
  mode: "new" | "edit";
  initialProfile?: RdpProfile | null;
  defaultGroup?: string | null;
  groups: string[];
  credentials: CredentialSummary[];
  credentialReuseDefault: CredentialReuseMode;
  onCredentialSave?: (input: CredentialSaveInput) => Promise<CredentialSummary>;
  onClose: () => void;
  onProfilesChange?: () => Promise<void> | void;
  t: Translate;
};

type RdpProfileSection = "connection" | "display" | "security";

const RDP_RESOLUTION_CUSTOM_VALUE = "custom";
const RDP_RESOLUTION_PRESETS = [
  { value: "1024x768", width: 1024, height: 768 },
  { value: "1280x720", width: 1280, height: 720 },
  { value: "1366x768", width: 1366, height: 768 },
  { value: "1600x900", width: 1600, height: 900 },
  { value: "1920x1080", width: 1920, height: 1080 },
  { value: "2560x1440", width: 2560, height: 1440 },
] as const;

type RdpPerformancePreset = "fluid" | "balanced" | "quality" | "custom";

const RDP_PERFORMANCE_PRESETS: Record<
  Exclude<RdpPerformancePreset, "custom">,
  RdpPerformanceFlags
> = {
  fluid: {
    wallpaper: false,
    fullWindowDrag: false,
    menuAnimations: false,
    theming: false,
    cursorShadow: false,
    cursorSettings: true,
    fontSmoothing: false,
    desktopComposition: false,
  },
  balanced: {
    wallpaper: false,
    fullWindowDrag: true,
    menuAnimations: false,
    theming: true,
    cursorShadow: true,
    cursorSettings: true,
    fontSmoothing: true,
    desktopComposition: false,
  },
  quality: {
    wallpaper: true,
    fullWindowDrag: true,
    menuAnimations: true,
    theming: true,
    cursorShadow: true,
    cursorSettings: true,
    fontSmoothing: true,
    desktopComposition: true,
  },
};

const RDP_PERFORMANCE_FLAG_FIELDS: Array<{
  key: keyof RdpPerformanceFlags;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}> = [
  {
    key: "wallpaper",
    labelKey: "rdp.performance.flag.wallpaper",
    hintKey: "rdp.performance.flag.wallpaperHint",
  },
  {
    key: "fullWindowDrag",
    labelKey: "rdp.performance.flag.fullWindowDrag",
    hintKey: "rdp.performance.flag.fullWindowDragHint",
  },
  {
    key: "menuAnimations",
    labelKey: "rdp.performance.flag.menuAnimations",
    hintKey: "rdp.performance.flag.menuAnimationsHint",
  },
  {
    key: "theming",
    labelKey: "rdp.performance.flag.theming",
    hintKey: "rdp.performance.flag.themingHint",
  },
  {
    key: "cursorShadow",
    labelKey: "rdp.performance.flag.cursorShadow",
    hintKey: "rdp.performance.flag.cursorShadowHint",
  },
  {
    key: "cursorSettings",
    labelKey: "rdp.performance.flag.cursorSettings",
    hintKey: "rdp.performance.flag.cursorSettingsHint",
  },
  {
    key: "fontSmoothing",
    labelKey: "rdp.performance.flag.fontSmoothing",
    hintKey: "rdp.performance.flag.fontSmoothingHint",
  },
  {
    key: "desktopComposition",
    labelKey: "rdp.performance.flag.desktopComposition",
    hintKey: "rdp.performance.flag.desktopCompositionHint",
  },
];

const DEFAULT_RDP_PROFILE: RdpProfile = {
  id: "",
  name: "",
  credentialId: null,
  host: "",
  port: 3389,
  username: "",
  tags: null,
  passwordRef: "",
  domain: "",
  ignoreCertificate: true,
  resolutionMode: "window_sync",
  displayStrategy: "fit",
  width: null,
  height: null,
  clipboardMode: "text",
  reconnectPolicy: {
    enabled: true,
    maxAttempts: 3,
  },
  performanceFlags: { ...RDP_PERFORMANCE_PRESETS.fluid },
};

function clonePerformanceFlags(
  flags?: Partial<RdpPerformanceFlags> | null,
): RdpPerformanceFlags {
  return {
    ...RDP_PERFORMANCE_PRESETS.fluid,
    ...flags,
  };
}

function buildDefaultProfile() {
  return {
    ...DEFAULT_RDP_PROFILE,
    width: DEFAULT_RDP_PROFILE.width,
    height: DEFAULT_RDP_PROFILE.height,
    reconnectPolicy: { ...DEFAULT_RDP_PROFILE.reconnectPolicy },
    performanceFlags: clonePerformanceFlags(
      DEFAULT_RDP_PROFILE.performanceFlags,
    ),
  };
}

function resolvePerformancePreset(
  flags: RdpPerformanceFlags,
): RdpPerformancePreset {
  const matched = (
    Object.entries(RDP_PERFORMANCE_PRESETS) as Array<
      [Exclude<RdpPerformancePreset, "custom">, RdpPerformanceFlags]
    >
  ).find(([, presetFlags]) =>
    Object.entries(presetFlags).every(
      ([key, value]) => flags[key as keyof RdpPerformanceFlags] === value,
    ),
  );
  return matched?.[0] ?? "custom";
}

/** 保存前优先执行前端字段校验，避免直接暴露后端兜底文案。 */
function validateDraftProfile(
  profile: RdpProfile,
  t: Translate,
): { message: string; section: RdpProfileSection } | null {
  if (!profile.name.trim()) {
    return {
      message: t("rdp.error.nameRequired"),
      section: "connection",
    };
  }
  if (!profile.host.trim()) {
    return {
      message: t("rdp.error.hostRequired"),
      section: "connection",
    };
  }
  if (!profile.username.trim() && !profile.credentialId) {
    return {
      message: t("rdp.error.usernameRequired"),
      section: "connection",
    };
  }
  if (
    profile.resolutionMode === "fixed" &&
    (!(profile.width && profile.width > 0) ||
      !(profile.height && profile.height > 0))
  ) {
    return {
      message: t("rdp.error.fixedResolutionRequired"),
      section: "display",
    };
  }
  return null;
}

export default function RdpProfileModal({
  open,
  mode,
  initialProfile = null,
  defaultGroup = null,
  groups,
  credentials,
  credentialReuseDefault,
  onCredentialSave,
  onClose,
  onProfilesChange,
  t,
}: RdpProfileModalProps) {
  const [draftProfile, setDraftProfile] = useState<RdpProfile>(() =>
    buildDefaultProfile(),
  );
  const [activeSection, setActiveSection] =
    useState<RdpProfileSection>("connection");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [initialDraftSnapshot, setInitialDraftSnapshot] = useState("");
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [credentialCreateOpen, setCredentialCreateOpen] = useState(false);
  const [authenticationMethod, setAuthenticationMethod] = useState<
    "password" | "credential"
  >("password");

  const resolveInitialDraft = useCallback(() => {
    if (mode === "edit" && initialProfile) {
      return {
        ...initialProfile,
        reconnectPolicy: { ...initialProfile.reconnectPolicy },
        performanceFlags: clonePerformanceFlags(
          initialProfile.performanceFlags,
        ),
      };
    }
    const normalizedDefaultGroup = defaultGroup?.trim() ?? "";
    return {
      ...buildDefaultProfile(),
      tags: normalizedDefaultGroup ? [normalizedDefaultGroup] : null,
    };
  }, [defaultGroup, initialProfile, mode]);

  useEffect(() => {
    if (!open) return;
    const cancel = scheduleDeferredTask(() => {
      setActiveSection("connection");
      setErrorMessage("");
      setShowDiscardConfirm(false);
      setCredentialCreateOpen(false);
      const initial = resolveInitialDraft();
      setDraftProfile(initial);
      setAuthenticationMethod(initial.credentialId ? "credential" : "password");
      // 延迟记录快照，确保状态已应用。
      scheduleDeferredTask(() => {
        setInitialDraftSnapshot(JSON.stringify(initial));
      });
    });
    return cancel;
  }, [open, resolveInitialDraft]);

  const hasUnsavedChanges =
    open && JSON.stringify(draftProfile) !== initialDraftSnapshot;

  function handleRequestClose() {
    if (hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }

  async function handleSaveProfile() {
    const validationError = validateDraftProfile(draftProfile, t);
    if (validationError) {
      setActiveSection(validationError.section);
      setErrorMessage(validationError.message);
      return;
    }
    setBusy(true);
    setErrorMessage("");
    try {
      const saved = await saveRdpProfile(draftProfile);
      setDraftProfile(saved);
      await onProfilesChange?.();
      onClose();
    } catch (error) {
      setErrorMessage(translateAppError(error, t));
    } finally {
      setBusy(false);
    }
  }

  const sectionItems: Array<{ key: RdpProfileSection; label: string }> = [
    { key: "connection", label: t("rdp.drawer.sections.connection") },
    { key: "display", label: t("rdp.drawer.sections.display") },
    { key: "security", label: t("rdp.drawer.sections.security") },
  ];

  const resolutionModeOptions = useMemo(
    () => [
      {
        value: "window_sync",
        label: t("rdp.resolution.windowSync"),
      },
      {
        value: "fixed",
        label: t("rdp.resolution.fixed"),
      },
    ],
    [t],
  );

  const groupOptions = useMemo(
    () => [
      { value: ROOT_PROFILE_GROUP_VALUE, label: t("host.ungrouped") },
      ...groups.map((group) => ({
        value: group,
        label: group,
      })),
    ],
    [groups, t],
  );

  const resolutionPresetOptions = useMemo(
    () => [
      ...RDP_RESOLUTION_PRESETS.map((item) => ({
        value: item.value,
        label: item.value,
      })),
      {
        value: RDP_RESOLUTION_CUSTOM_VALUE,
        label: t("rdp.resolution.custom"),
      },
    ],
    [t],
  );

  const resolutionPresetValue = useMemo(() => {
    const width = draftProfile.width ?? 0;
    const height = draftProfile.height ?? 0;
    const matchedPreset = RDP_RESOLUTION_PRESETS.find(
      (item) => item.width === width && item.height === height,
    );
    return matchedPreset?.value ?? RDP_RESOLUTION_CUSTOM_VALUE;
  }, [draftProfile.height, draftProfile.width]);

  const displayStrategyOptions = useMemo(
    () => [
      {
        value: "fit",
        label: t("rdp.displayStrategy.fit"),
      },
      {
        value: "cover",
        label: t("rdp.displayStrategy.cover"),
      },
      {
        value: "stretch",
        label: t("rdp.displayStrategy.stretch"),
      },
    ],
    [t],
  );

  const performancePresetOptions = useMemo(
    () => [
      {
        value: "fluid",
        label: t("rdp.performance.preset.fluid"),
      },
      {
        value: "balanced",
        label: t("rdp.performance.preset.balanced"),
      },
      {
        value: "quality",
        label: t("rdp.performance.preset.quality"),
      },
      {
        value: "custom",
        label: t("rdp.performance.preset.custom"),
        disabled: true,
      },
    ],
    [t],
  );

  const performancePresetValue = useMemo(
    () => resolvePerformancePreset(draftProfile.performanceFlags),
    [draftProfile.performanceFlags],
  );

  return (
    <>
      <Modal
        open={open}
        busy={busy}
        title={t("rdp.config.title")}
        closeLabel={t("actions.close")}
        onClose={handleRequestClose}
        bodyClassName="profile-modal-body"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={handleRequestClose}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleSaveProfile()}
              disabled={busy}
            >
              {t("actions.save")}
            </Button>
          </>
        }
      >
        <div className="rdp-profile-modal" data-ui="rdp-profile-modal">
          <div className="profile-modal-layout">
            <nav className="profile-modal-nav" data-slot="rdp-profile-nav">
              {sectionItems.map((section) => (
                <button
                  key={section.key}
                  type="button"
                  className={`profile-modal-nav-item ${
                    section.key === activeSection ? "active" : ""
                  }`}
                  onClick={() => setActiveSection(section.key)}
                >
                  {section.label}
                </button>
              ))}
              <div className="profile-modal-nav-actions">
                <button
                  type="button"
                  className="profile-modal-nav-item profile-modal-nav-action"
                  disabled={!onCredentialSave}
                  onClick={() => {
                    setActiveSection("connection");
                    setCredentialCreateOpen(true);
                  }}
                  data-ui="rdp-credential-create"
                >
                  <FiPlus aria-hidden="true" />
                  {t("credentials.quickAdd", { kind: "RDP" })}
                </button>
              </div>
            </nav>
            <section
              className="profile-modal-content"
              data-slot="rdp-profile-content"
            >
              <div className="profile-settings-page">
                {activeSection === "connection" ? (
                  <div className="host-editor">
                    <div className="form-row">
                      <label className="form-label">
                        {t("profile.form.name")}
                      </label>
                      <input
                        value={draftProfile.name}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) =>
                          setDraftProfile((prev) => ({
                            ...prev,
                            name: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="form-row">
                      <label className="form-label">
                        {t("profile.form.group")}
                      </label>
                      <Select
                        value={
                          draftProfile.tags?.[0]?.trim() ||
                          ROOT_PROFILE_GROUP_VALUE
                        }
                        options={groupOptions}
                        onChange={(value) =>
                          setDraftProfile((prev) => ({
                            ...prev,
                            tags:
                              value === ROOT_PROFILE_GROUP_VALUE
                                ? null
                                : [value],
                          }))
                        }
                        aria-label={t("profile.form.group")}
                      />
                    </div>
                    <div className="form-row">
                      <label className="form-label">
                        {t("profile.form.host")}
                      </label>
                      <input
                        value={draftProfile.host}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) =>
                          setDraftProfile((prev) => ({
                            ...prev,
                            host: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="form-row">
                      <label className="form-label">
                        {t("profile.form.port")}
                      </label>
                      <input
                        inputMode="numeric"
                        value={String(draftProfile.port)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) =>
                          setDraftProfile((prev) => ({
                            ...prev,
                            port: Number(
                              event.target.value.replace(/[^\d]/g, "") ||
                                "3389",
                            ),
                          }))
                        }
                      />
                    </div>
                    <div className="form-row">
                      <label className="form-label">
                        {t("profile.form.authType")}
                      </label>
                      <Select
                        value={authenticationMethod}
                        options={[
                          {
                            value: "password",
                            label: t("profile.auth.password"),
                          },
                          {
                            value: "credential",
                            label: t("profile.auth.credential"),
                          },
                        ]}
                        onChange={(value) => {
                          setAuthenticationMethod(
                            value as "password" | "credential",
                          );
                          setDraftProfile((prev) => ({
                            ...prev,
                            credentialId: null,
                            username: "",
                            passwordRef: null,
                          }));
                        }}
                        aria-label={t("profile.form.authType")}
                      />
                    </div>
                    <ProfileCredentialSelector
                      kind="rdp"
                      credentialId={draftProfile.credentialId}
                      credentials={credentials}
                      defaultReuseMode={credentialReuseDefault}
                      showFields={authenticationMethod === "credential"}
                      createOpen={credentialCreateOpen}
                      onCreateOpenChange={setCredentialCreateOpen}
                      onCredentialSave={onCredentialSave}
                      onChange={(value) => {
                        setDraftProfile((prev) => ({
                          ...prev,
                          credentialId: value.credentialId,
                          username: value.username,
                          passwordRef: value.passwordRef,
                        }));
                        if (value.credentialId) {
                          setAuthenticationMethod("credential");
                        } else if (value.username || value.passwordRef) {
                          setAuthenticationMethod("password");
                        }
                      }}
                      t={t}
                    />
                    {authenticationMethod !== "credential" ? (
                      <>
                        <div className="form-row">
                          <label className="form-label">
                            {t("profile.form.username")}
                          </label>
                          <input
                            value={draftProfile.username}
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(event) =>
                              setDraftProfile((prev) => ({
                                ...prev,
                                username: event.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="form-row">
                          <label className="form-label">
                            {t("profile.form.password")}
                          </label>
                          <input
                            type="password"
                            value={draftProfile.passwordRef ?? ""}
                            autoComplete="off"
                            onChange={(event) =>
                              setDraftProfile((prev) => ({
                                ...prev,
                                passwordRef: event.target.value,
                              }))
                            }
                          />
                        </div>
                      </>
                    ) : null}
                    <div className="form-row">
                      <label className="form-label">
                        {t("rdp.form.domain")}
                      </label>
                      <input
                        value={draftProfile.domain ?? ""}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) =>
                          setDraftProfile((prev) => ({
                            ...prev,
                            domain: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                ) : null}

                {activeSection === "display" ? (
                  <>
                    <section className="profile-settings-section rdp-profile-settings-group">
                      <div className="profile-settings-section-body host-editor rdp-profile-group-head">
                        <div className="form-row">
                          <label className="form-label">
                            {t("rdp.form.resolutionMode")}
                          </label>
                          <div className="config-select-control rdp-profile-select-control">
                            <Select
                              value={draftProfile.resolutionMode}
                              options={resolutionModeOptions}
                              aria-label={t("rdp.form.resolutionMode")}
                              onChange={(value) =>
                                setDraftProfile((prev) => ({
                                  ...prev,
                                  resolutionMode:
                                    value as RdpProfile["resolutionMode"],
                                  width:
                                    value === "fixed"
                                      ? (prev.width ?? 1920)
                                      : null,
                                  height:
                                    value === "fixed"
                                      ? (prev.height ?? 1080)
                                      : null,
                                }))
                              }
                            />
                          </div>
                        </div>
                      </div>
                      {draftProfile.resolutionMode === "fixed" ? (
                        <div className="rdp-profile-group-body host-editor">
                          <div className="form-row">
                            <label className="form-label">
                              {t("rdp.form.fixedResolution")}
                            </label>
                            <Select
                              value={resolutionPresetValue}
                              options={resolutionPresetOptions}
                              aria-label={t("rdp.form.fixedResolution")}
                              onChange={(value) => {
                                if (value === RDP_RESOLUTION_CUSTOM_VALUE) {
                                  return;
                                }
                                const preset = RDP_RESOLUTION_PRESETS.find(
                                  (item) => item.value === value,
                                );
                                if (!preset) return;
                                setDraftProfile((prev) => ({
                                  ...prev,
                                  width: preset.width,
                                  height: preset.height,
                                }));
                              }}
                            />
                          </div>
                          {resolutionPresetValue ===
                          RDP_RESOLUTION_CUSTOM_VALUE ? (
                            <>
                              <div className="form-row">
                                <label className="form-label">
                                  {t("rdp.form.width")}
                                </label>
                                <input
                                  inputMode="numeric"
                                  value={String(draftProfile.width ?? "")}
                                  autoComplete="off"
                                  autoCorrect="off"
                                  spellCheck={false}
                                  onChange={(event) =>
                                    setDraftProfile((prev) => ({
                                      ...prev,
                                      width: Number(
                                        event.target.value.replace(
                                          /[^\d]/g,
                                          "",
                                        ) || "0",
                                      ),
                                    }))
                                  }
                                />
                              </div>
                              <div className="form-row">
                                <label className="form-label">
                                  {t("rdp.form.height")}
                                </label>
                                <input
                                  inputMode="numeric"
                                  value={String(draftProfile.height ?? "")}
                                  autoComplete="off"
                                  autoCorrect="off"
                                  spellCheck={false}
                                  onChange={(event) =>
                                    setDraftProfile((prev) => ({
                                      ...prev,
                                      height: Number(
                                        event.target.value.replace(
                                          /[^\d]/g,
                                          "",
                                        ) || "0",
                                      ),
                                    }))
                                  }
                                />
                              </div>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                    <section className="profile-settings-section rdp-profile-settings-group">
                      <div className="rdp-profile-group-card">
                        <div className="profile-settings-section-body host-editor rdp-profile-group-head">
                          <div className="form-row">
                            <label className="form-label">
                              {t("rdp.form.displayStrategy")}
                            </label>
                            <Select
                              value={draftProfile.displayStrategy}
                              options={displayStrategyOptions}
                              aria-label={t("rdp.form.displayStrategy")}
                              onChange={(value) =>
                                setDraftProfile((prev) => ({
                                  ...prev,
                                  displayStrategy: value as RdpDisplayStrategy,
                                }))
                              }
                            />
                          </div>
                          <div className="profile-form-hint">
                            {t("rdp.displayStrategy.hint")}
                          </div>
                        </div>
                      </div>
                    </section>
                    <section className="profile-settings-section rdp-profile-settings-group rdp-profile-settings-group-unified">
                      <div className="rdp-profile-group-card">
                        <div className="profile-settings-section-body host-editor rdp-profile-group-head">
                          <div className="form-row">
                            <label className="form-label">
                              {t("rdp.form.performancePreset")}
                            </label>
                            <Select
                              value={performancePresetValue}
                              options={performancePresetOptions}
                              aria-label={t("rdp.form.performancePreset")}
                              onChange={(value) => {
                                if (value === "custom") return;
                                setDraftProfile((prev) => ({
                                  ...prev,
                                  performanceFlags: {
                                    ...RDP_PERFORMANCE_PRESETS[
                                      value as Exclude<
                                        RdpPerformancePreset,
                                        "custom"
                                      >
                                    ],
                                  },
                                }));
                              }}
                            />
                          </div>
                          <div className="profile-form-hint">
                            {t("rdp.performance.presetHint")}
                          </div>
                        </div>
                        <div className="rdp-profile-group-body rdp-performance-flags">
                          {RDP_PERFORMANCE_FLAG_FIELDS.map((field) => (
                            <label
                              className="config-toggle-card"
                              key={field.key}
                            >
                              <div className="config-toggle-copy">
                                <span className="config-toggle-title">
                                  {t(field.labelKey)}
                                </span>
                                <span className="config-toggle-desc">
                                  {t(field.hintKey)}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                autoComplete="off"
                                checked={
                                  draftProfile.performanceFlags[field.key]
                                }
                                onChange={(event) =>
                                  setDraftProfile((prev) => ({
                                    ...prev,
                                    performanceFlags: {
                                      ...prev.performanceFlags,
                                      [field.key]: event.target.checked,
                                    },
                                  }))
                                }
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    </section>
                  </>
                ) : null}

                {activeSection === "security" ? (
                  <section className="profile-settings-section rdp-profile-settings-single-card">
                    <div className="profile-settings-section-body rdp-profile-group-head">
                      <label className="config-toggle-card">
                        <div className="config-toggle-copy">
                          <span className="config-toggle-title">
                            {t("rdp.form.ignoreCertificate")}
                          </span>
                          <span className="config-toggle-desc">
                            {t("rdp.security.ignoreCertificateHint")}
                          </span>
                        </div>
                        <input
                          type="checkbox"
                          checked={draftProfile.ignoreCertificate}
                          onChange={(event) =>
                            setDraftProfile((prev) => ({
                              ...prev,
                              ignoreCertificate: event.target.checked,
                            }))
                          }
                        />
                      </label>
                    </div>
                  </section>
                ) : null}

                {errorMessage ? (
                  <div className="rdp-profile-modal-error">{errorMessage}</div>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      </Modal>

      {showDiscardConfirm && (
        <Modal
          open
          title={
            t("profile.unsavedChangesConfirmTitle") || t("actions.confirm")
          }
          closeLabel={t("actions.close")}
          onClose={() => setShowDiscardConfirm(false)}
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDiscardConfirm(false)}
              >
                {t("profile.actions.continueEditing") || t("actions.cancel")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowDiscardConfirm(false);
                  onClose();
                }}
              >
                {t("profile.actions.discardAndClose") || t("actions.ok")}
              </Button>
            </>
          }
        >
          <div className="profile-discard-confirm-dialog">
            <p>{t("profile.unsavedChangesConfirm")}</p>
          </div>
        </Modal>
      )}
    </>
  );
}
