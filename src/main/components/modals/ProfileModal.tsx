/** 主机 Profile 编辑弹窗容器，负责分区导航、草稿提交和弹窗生命周期。 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FiPlus, FiServer } from "react-icons/fi";
import type { Translate } from "@/i18n";
import type {
  CredentialReuseMode,
  CredentialSummary,
  HostProfile,
} from "@/types";
import type { CredentialSaveInput } from "@/features/credential/core/commands";
import ProfileCredentialSelector from "@/features/credential/components/ProfileCredentialSelector";
import { ROOT_PROFILE_GROUP_VALUE } from "@/constants/hostGroups";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import Modal from "@/components/ui/modal/Modal";
import Button from "@/components/ui/button";
import Select from "@/components/ui/select";
import {
  DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
  DEFAULT_TERMINAL_BELL_MODE,
  TERMINAL_BELL_COOLDOWN_OPTIONS,
} from "@/constants/terminalBell";
import {
  DEFAULT_TERMINAL_WORD_SEPARATORS,
  TERMINAL_WORD_SEPARATORS_PRESET_A,
  TERMINAL_WORD_SEPARATORS_PRESET_B,
} from "@/constants/terminalWordSeparators";
import {
  PROFILE_ICON_OPTIONS,
  resolveProfileIcon,
} from "@/features/profile/profileIcons";
import ProfileSshSection from "@/main/components/modals/profile-modal/ProfileSshSection";
import {
  resolveSshRoutingMode,
  type SshRoutingMode,
} from "@/main/components/modals/profile-modal/ProfileSshSection.utils";
import "@/main/components/modals/ProfileModal.css";

// 与后端 profile_save 的名称校验保持一致，避免保存前后出现不同结果。
const PROFILE_NAME_MAX_LENGTH = 14;

type ProfileModalProps = {
  open: boolean;
  mode: "new" | "edit";
  draft: HostProfile;
  profiles: HostProfile[];
  sshGroups: string[];
  credentials: CredentialSummary[];
  credentialReuseDefault: CredentialReuseMode;
  onCredentialSave?: (input: CredentialSaveInput) => Promise<CredentialSummary>;
  onDraftChange: (draft: HostProfile) => void;
  onClose: () => void;
  onSubmit: () => void;
  t: Translate;
};

type ProfileModalSection = "session" | "terminal" | "window" | "ssh" | "modem";
type SshAuthenticationMethod = HostProfile["authType"] | "credential";

/** 主机配置编辑弹窗。 */
export default function ProfileModal({
  open,
  mode,
  draft,
  profiles,
  sshGroups,
  credentials,
  credentialReuseDefault,
  onCredentialSave,
  onDraftChange,
  onClose,
  onSubmit,
  t,
}: ProfileModalProps) {
  const formId = useId();
  const autoFilledRef = useRef(false);
  const wasOpenRef = useRef(false);
  const [activeSection, setActiveSection] =
    useState<ProfileModalSection>("session");
  const [nameError, setNameError] = useState<string | null>(null);
  const [initialDraftSnapshot, setInitialDraftSnapshot] = useState("");
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [credentialCreateOpen, setCredentialCreateOpen] = useState(false);
  const [sshRoutingMode, setSshRoutingMode] =
    useState<SshRoutingMode>("direct");
  const [sshAuthenticationMethod, setSshAuthenticationMethod] =
    useState<SshAuthenticationMethod>(
      draft.credentialId ? "credential" : draft.authType,
    );

  useEffect(() => {
    const becameOpen = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (becameOpen) {
      autoFilledRef.current = false;
      queueMicrotask(() => {
        setShowDiscardConfirm(false);
        setIconPickerOpen(false);
        setCredentialCreateOpen(false);
        setInitialDraftSnapshot(JSON.stringify(draft));
        setActiveSection("session");
        setNameError(null);
        setSshRoutingMode(resolveSshRoutingMode(draft));
        setSshAuthenticationMethod(
          draft.credentialId ? "credential" : draft.authType,
        );
      });
    }
  }, [open, draft]);

  useEffect(() => {
    if (draft.authType !== "privateKey") return;
    if (draft.privateKeyPath) return;
    if (autoFilledRef.current) return;
    autoFilledRef.current = true;
    invoke<string[]>("local_ssh_keys")
      .then((keys) => {
        if (!keys.length) return;
        onDraftChange({ ...draft, privateKeyPath: keys[0] });
      })
      .catch(() => {});
  }, [draft, onDraftChange]);

  /** 打开文件选择器并写入私钥路径。 */
  async function handlePickPrivateKey() {
    try {
      const selection = await openFileDialog({
        title: t("profile.form.privateKeyPath"),
        multiple: false,
        directory: false,
      });
      if (!selection || Array.isArray(selection)) return;
      onDraftChange({ ...draft, privateKeyPath: selection });
    } catch {
      // 忽略选择器异常。
    }
  }

  const visibleSections = useMemo<ProfileModalSection[]>(
    () => ["session", "terminal", "window", "ssh", "modem"],
    [],
  );

  /** 当前产品要求会话名称必填，且限制在较短范围内避免列表与标签过度截断。 */
  function validateProfileName(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return t("profile.nameRequired");
    }
    if (trimmed.length > PROFILE_NAME_MAX_LENGTH) {
      return t("profile.nameTooLong", { max: PROFILE_NAME_MAX_LENGTH });
    }
    return null;
  }

  const canSubmit = true;
  const hasUnsavedChanges =
    open && JSON.stringify(draft) !== initialDraftSnapshot;
  const CurrentProfileIcon = resolveProfileIcon(draft.iconKey);

  /** 统一处理关闭请求：有未保存草稿时显示 UI 确认框而非阻塞式系统对话框。 */
  function handleRequestClose() {
    if (hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }

  /** 恢复当前类型对应的默认配置，避免未来选项增多后需要逐项手工回填。 */
  function handleRestoreDefaults() {
    setActiveSection("session");
    setSshAuthenticationMethod("password");
    onDraftChange({
      id: draft.id,
      name: "",
      credentialId: null,
      iconKey: null,
      host: "",
      port: 22,
      username: "",
      authType: "password",
      privateKeyPath: null,
      privateKeyPassphraseRef: null,
      passwordRef: null,
      knownHost: null,
      proxyMode: "direct",
      proxyConfig: null,
      jumpProfileIds: null,
      tags: null,
      terminalType: null,
      targetSystem: null,
      charset: null,
      wordSeparators: null,
      bellMode: DEFAULT_TERMINAL_BELL_MODE,
      bellCooldownMs: DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
      description: null,
    });
  }

  function renderSectionContent() {
    const terminalOptions = [
      { value: "xterm-256color", label: "xterm-256color" },
      { value: "xterm", label: "xterm" },
      { value: "screen-256color", label: "screen-256color" },
      { value: "tmux-256color", label: "tmux-256color" },
      { value: "vt100", label: "vt100" },
    ];
    const systemOptions = [
      { value: "auto", label: "Auto" },
      { value: "linux", label: "Linux" },
      { value: "macos", label: "macOS" },
      { value: "windows", label: "Windows" },
    ];
    const bellModeOptions = [
      { value: "silent", label: t("profile.terminal.bellMode.silent") },
      { value: "sound", label: t("profile.terminal.bellMode.sound") },
    ];
    const bellCooldownOptions = TERMINAL_BELL_COOLDOWN_OPTIONS.map((value) => ({
      value: String(value),
      label: t("profile.terminal.bellCooldown.option", {
        seconds: (value / 1000).toString(),
      }),
    }));
    const nameInputId = `${formId}-name`;
    const terminalTypeSelectId = `${formId}-terminal-type`;
    const targetSystemSelectId = `${formId}-target-system`;
    const descriptionInputId = `${formId}-description`;
    const wordSeparatorsInputId = `${formId}-word-separators`;
    const groupSelectId = `${formId}-group`;
    const hostInputId = `${formId}-host`;
    const portInputId = `${formId}-port`;
    const usernameInputId = `${formId}-username`;
    const authTypeSelectId = `${formId}-auth-type`;
    const passwordInputId = `${formId}-password`;
    const privateKeyPathInputId = `${formId}-private-key-path`;
    const privateKeyPassphraseInputId = `${formId}-private-key-passphrase`;
    const bellModeSelectId = `${formId}-bell-mode`;
    const bellCooldownSelectId = `${formId}-bell-cooldown`;
    const nameRow = (
      <div className="form-row">
        <label className="form-label" htmlFor={nameInputId}>
          {t("profile.form.name")}
        </label>
        <div className="profile-name-field">
          <input
            id={nameInputId}
            value={draft.name}
            maxLength={PROFILE_NAME_MAX_LENGTH}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              onDraftChange({ ...draft, name: event.target.value });
              if (nameError) {
                setNameError(null);
              }
            }}
            placeholder={t("profile.placeholder.name")}
          />
          <Button
            variant="ghost"
            size="sm"
            className="profile-name-icon-trigger"
            aria-label={t("profile.icon.currentPreview")}
            onClick={() => setIconPickerOpen(true)}
          >
            <CurrentProfileIcon />
          </Button>
        </div>
        {nameError ? (
          <div className="profile-form-error">{nameError}</div>
        ) : null}
      </div>
    );

    const extraSessionRows = (
      <>
        <div className="form-row">
          <label className="form-label" htmlFor={terminalTypeSelectId}>
            {t("profile.sessionTab.terminal")}
          </label>
          <Select
            id={terminalTypeSelectId}
            value={draft.terminalType ?? "xterm-256color"}
            options={terminalOptions}
            onChange={(value) =>
              onDraftChange({ ...draft, terminalType: value })
            }
            aria-label={t("profile.sessionTab.terminal")}
          />
        </div>
        <div className="form-row">
          <label className="form-label" htmlFor={targetSystemSelectId}>
            {t("profile.sessionTab.system")}
          </label>
          <Select
            id={targetSystemSelectId}
            value={draft.targetSystem ?? "auto"}
            options={systemOptions}
            onChange={(value) =>
              onDraftChange({ ...draft, targetSystem: value })
            }
            aria-label={t("profile.sessionTab.system")}
          />
        </div>
        <div className="form-row form-row-textarea">
          <label className="form-label" htmlFor={descriptionInputId}>
            {t("profile.sessionTab.description")}
          </label>
          <textarea
            id={descriptionInputId}
            rows={4}
            value={draft.description ?? ""}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) =>
              onDraftChange({ ...draft, description: event.target.value })
            }
          />
        </div>
      </>
    );

    const windowRows = (
      <div className="profile-settings-page">
        <section className="profile-settings-section">
          <div className="profile-settings-section-body host-editor">
            <div className="form-row">
              <label className="form-label" htmlFor={wordSeparatorsInputId}>
                {t("profile.window.wordSeparators")}
              </label>
              <input
                id={wordSeparatorsInputId}
                value={draft.wordSeparators ?? DEFAULT_TERMINAL_WORD_SEPARATORS}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    wordSeparators: event.target.value,
                  })
                }
              />
              <div className="profile-form-hint">
                {t("profile.window.wordSeparatorsHint")}
              </div>
            </div>
            <div className="form-row">
              <span className="form-label">{t("profile.window.presets")}</span>
              <div className="form-file profile-window-presets">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onDraftChange({
                      ...draft,
                      wordSeparators: TERMINAL_WORD_SEPARATORS_PRESET_A,
                    })
                  }
                >
                  {t("profile.window.presetA")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onDraftChange({
                      ...draft,
                      wordSeparators: TERMINAL_WORD_SEPARATORS_PRESET_B,
                    })
                  }
                >
                  {t("profile.window.presetB")}
                </Button>
              </div>
              <div className="profile-form-hint">
                {t("profile.window.applyHint")}
              </div>
            </div>
          </div>
        </section>
      </div>
    );

    const terminalRows = (
      <div className="profile-settings-page">
        <section className="profile-settings-section">
          <header className="profile-settings-section-header">
            <div>
              <h4>{t("profile.terminal.group.bell")}</h4>
              <p>{t("profile.terminal.group.bellHint")}</p>
            </div>
          </header>
          <div className="profile-settings-section-body host-editor">
            <div className="form-row">
              <label className="form-label" htmlFor={bellModeSelectId}>
                {t("profile.terminal.bellMode")}
              </label>
              <Select
                id={bellModeSelectId}
                value={draft.bellMode ?? DEFAULT_TERMINAL_BELL_MODE}
                options={bellModeOptions}
                onChange={(value) =>
                  onDraftChange({
                    ...draft,
                    bellMode: value as NonNullable<HostProfile["bellMode"]>,
                  })
                }
                aria-label={t("profile.terminal.bellMode")}
              />
              <div className="profile-form-hint">
                {t("profile.terminal.bellModeHint")}
              </div>
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor={bellCooldownSelectId}>
                {t("profile.terminal.bellCooldown")}
              </label>
              <Select
                id={bellCooldownSelectId}
                value={String(
                  draft.bellCooldownMs ?? DEFAULT_TERMINAL_BELL_COOLDOWN_MS,
                )}
                options={bellCooldownOptions}
                onChange={(value) =>
                  onDraftChange({
                    ...draft,
                    bellCooldownMs: Number(value),
                  })
                }
                aria-label={t("profile.terminal.bellCooldown")}
              />
              <div className="profile-form-hint">
                {t("profile.terminal.bellCooldownHint")}
              </div>
            </div>
          </div>
        </section>
      </div>
    );

    if (activeSection === "session") {
      return (
        <div className="host-editor">
          {nameRow}
          <div className="form-row">
            <label className="form-label" htmlFor={groupSelectId}>
              {t("profile.form.group")}
            </label>
            <Select
              id={groupSelectId}
              value={draft.tags?.[0]?.trim() || ROOT_PROFILE_GROUP_VALUE}
              options={[
                {
                  value: ROOT_PROFILE_GROUP_VALUE,
                  label: t("host.ungrouped"),
                },
                ...sshGroups.map((group) => ({
                  value: group,
                  label: group,
                })),
              ]}
              onChange={(value) =>
                onDraftChange({
                  ...draft,
                  tags: value === ROOT_PROFILE_GROUP_VALUE ? null : [value],
                })
              }
              aria-label={t("profile.form.group")}
            />
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor={hostInputId}>
              {t("profile.form.host")}
            </label>
            <input
              id={hostInputId}
              value={draft.host}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) =>
                onDraftChange({ ...draft, host: event.target.value })
              }
              placeholder={t("profile.placeholder.host")}
            />
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor={portInputId}>
              {t("profile.form.port")}
            </label>
            <input
              id={portInputId}
              type="number"
              value={draft.port}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  port: Number(event.target.value),
                })
              }
            />
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor={authTypeSelectId}>
              {t("profile.form.authType")}
            </label>
            <Select
              id={authTypeSelectId}
              value={sshAuthenticationMethod}
              options={[
                { value: "password", label: t("profile.auth.password") },
                {
                  value: "credential",
                  label: t("profile.auth.credential"),
                },
                { value: "privateKey", label: t("profile.auth.privateKey") },
              ]}
              onChange={(next) => {
                const method = next as SshAuthenticationMethod;
                const leavingCredential =
                  sshAuthenticationMethod === "credential";
                setSshAuthenticationMethod(method);
                onDraftChange({
                  ...draft,
                  authType: method === "credential" ? "password" : method,
                  credentialId: null,
                  username:
                    method === "credential" || leavingCredential
                      ? ""
                      : draft.username,
                  passwordRef:
                    method === "credential" || leavingCredential
                      ? null
                      : draft.passwordRef,
                });
              }}
              aria-label={t("profile.form.authType")}
            />
          </div>
          <ProfileCredentialSelector
            kind="ssh"
            credentialId={draft.credentialId}
            credentials={credentials}
            defaultReuseMode={credentialReuseDefault}
            showFields={sshAuthenticationMethod === "credential"}
            createOpen={credentialCreateOpen}
            onCreateOpenChange={setCredentialCreateOpen}
            onCredentialSave={onCredentialSave}
            onChange={(value) => {
              onDraftChange({
                ...draft,
                authType: "password",
                credentialId: value.credentialId,
                username: value.username,
                passwordRef: value.passwordRef,
              });
              if (value.credentialId) {
                setSshAuthenticationMethod("credential");
              } else if (value.username || value.passwordRef) {
                setSshAuthenticationMethod("password");
              }
            }}
            t={t}
          />
          {sshAuthenticationMethod !== "credential" ? (
            <div className="form-row">
              <label className="form-label" htmlFor={usernameInputId}>
                {t("profile.form.username")}
              </label>
              <input
                id={usernameInputId}
                value={draft.username}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) =>
                  onDraftChange({ ...draft, username: event.target.value })
                }
              />
            </div>
          ) : null}
          {sshAuthenticationMethod === "password" ? (
            <div className="form-row">
              <label className="form-label" htmlFor={passwordInputId}>
                {t("profile.form.password")}
              </label>
              <input
                id={passwordInputId}
                type="password"
                value={draft.passwordRef ?? ""}
                autoComplete="off"
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    passwordRef: event.target.value,
                  })
                }
              />
            </div>
          ) : null}
          {sshAuthenticationMethod === "privateKey" && (
            <>
              <div className="form-row">
                <label className="form-label" htmlFor={privateKeyPathInputId}>
                  {t("profile.form.privateKeyPath")}
                </label>
                <div className="form-file">
                  <input
                    id={privateKeyPathInputId}
                    value={draft.privateKeyPath ?? ""}
                    placeholder={t("profile.placeholder.privateKeyPath")}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    readOnly
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void handlePickPrivateKey();
                    }}
                  >
                    {t("profile.actions.pickKey")}
                  </Button>
                </div>
              </div>
              <div className="form-row">
                <label
                  className="form-label"
                  htmlFor={privateKeyPassphraseInputId}
                >
                  {t("profile.form.privateKeyPassphrase")}
                </label>
                <input
                  id={privateKeyPassphraseInputId}
                  type="password"
                  value={draft.privateKeyPassphraseRef ?? ""}
                  autoComplete="off"
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      privateKeyPassphraseRef: event.target.value,
                    })
                  }
                />
              </div>
            </>
          )}
          {extraSessionRows}
        </div>
      );
    }

    if (activeSection === "terminal") {
      return terminalRows;
    }

    if (activeSection === "window") {
      return windowRows;
    }

    if (activeSection === "modem") {
      return (
        <div className="profile-modal-placeholder">
          <h4>{t("profile.section.modem")}</h4>
          <p>{t("profile.section.modemHint")}</p>
        </div>
      );
    }

    if (activeSection === "ssh") {
      return (
        <ProfileSshSection
          formId={formId}
          draft={draft}
          profiles={profiles}
          sshRoutingMode={sshRoutingMode}
          setSshRoutingMode={setSshRoutingMode}
          onDraftChange={onDraftChange}
          t={t}
        />
      );
    }

    return (
      <div className="host-editor">
        <div className="profile-modal-placeholder">
          <h4>{t("profile.section.ssh")}</h4>
          <p>{t("profile.section.sshHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Modal
        open={open}
        title={
          mode === "new"
            ? t("profile.modal.newTitle")
            : t("profile.modal.editTitle")
        }
        bodyClassName="profile-modal-body"
        closeLabel={t("actions.close")}
        onClose={handleRequestClose}
        actions={
          <div className="profile-modal-footer">
            <Button variant="ghost" onClick={handleRestoreDefaults}>
              {t("profile.actions.restoreDefaults")}
            </Button>
            <div className="profile-modal-footer-actions">
              <Button
                className="ghost"
                variant="ghost"
                onClick={handleRequestClose}
              >
                {t("actions.cancel")}
              </Button>
              <Button
                className="ghost"
                variant="ghost"
                onClick={() => {
                  const errorText = validateProfileName(draft.name);
                  if (errorText) {
                    setNameError(errorText);
                    return;
                  }
                  setNameError(null);
                  onSubmit();
                }}
                disabled={!canSubmit}
              >
                {t("actions.save")}
              </Button>
            </div>
          </div>
        }
      >
        <div className="profile-modal">
          <div className="profile-modal-layout">
            <nav className="profile-modal-nav">
              {visibleSections.map((section) => (
                <button
                  key={section}
                  type="button"
                  className={`profile-modal-nav-item ${activeSection === section ? "active" : ""}`}
                  onClick={() => setActiveSection(section)}
                >
                  {t(`profile.section.${section}`)}
                </button>
              ))}
              <div className="profile-modal-nav-actions">
                <button
                  type="button"
                  className="profile-modal-nav-item profile-modal-nav-action"
                  disabled={!onCredentialSave}
                  onClick={() => {
                    setActiveSection("session");
                    setCredentialCreateOpen(true);
                  }}
                  data-ui="ssh-credential-create"
                >
                  <FiPlus aria-hidden="true" />
                  {t("credentials.quickAdd", { kind: "SSH" })}
                </button>
              </div>
            </nav>
            <section className="profile-modal-content">
              {renderSectionContent()}
            </section>
          </div>
        </div>
      </Modal>

      {iconPickerOpen && (
        <Modal
          open
          title={t("profile.icon.pickerTitle")}
          closeLabel={t("actions.close")}
          bodyClassName="profile-icon-picker-body"
          onClose={() => setIconPickerOpen(false)}
          actions={
            <div className="profile-icon-picker-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onDraftChange({ ...draft, iconKey: null });
                  setIconPickerOpen(false);
                }}
              >
                {t("profile.icon.clear")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIconPickerOpen(false)}
              >
                {t("actions.close")}
              </Button>
            </div>
          }
        >
          <div className="profile-icon-picker" data-ui="profile-icon-picker">
            <div className="profile-icon-picker-scroll">
              <div className="profile-icon-grid" data-slot="icon-grid">
                <button
                  type="button"
                  className={`profile-icon-option${
                    !draft.iconKey ? " selected" : ""
                  }`}
                  onClick={() => {
                    onDraftChange({ ...draft, iconKey: null });
                    setIconPickerOpen(false);
                  }}
                >
                  <span className="profile-icon-option-glyph">
                    <FiServer />
                  </span>
                  <span className="profile-icon-option-label">
                    {t("profile.icon.default")}
                  </span>
                </button>
                {PROFILE_ICON_OPTIONS.map((item) => {
                  const Icon = item.Icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`profile-icon-option${
                        draft.iconKey === item.key ? " selected" : ""
                      }`}
                      onClick={() => {
                        onDraftChange({ ...draft, iconKey: item.key });
                        setIconPickerOpen(false);
                      }}
                    >
                      <span className="profile-icon-option-glyph">
                        <Icon />
                      </span>
                      <span className="profile-icon-option-label">
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Modal>
      )}

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
