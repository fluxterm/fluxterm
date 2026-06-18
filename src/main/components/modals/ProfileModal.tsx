import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FiServer } from "react-icons/fi";
import type { Translate } from "@/i18n";
import type { HostProfile } from "@/types";
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
import "@/main/components/modals/ProfileModal.css";

// 与后端 profile_save 的名称校验保持一致，避免保存前后出现不同结果。
const PROFILE_NAME_MAX_LENGTH = 14;

type ProfileModalProps = {
  open: boolean;
  mode: "new" | "edit";
  draft: HostProfile;
  profiles: HostProfile[];
  sshGroups: string[];
  onDraftChange: (draft: HostProfile) => void;
  onClose: () => void;
  onSubmit: () => void;
  t: Translate;
};

type ProfileModalSection = "session" | "terminal" | "window" | "ssh" | "modem";
type SshRoutingMode = NonNullable<HostProfile["proxyMode"]> | "jump";

function resolveSshRoutingMode(draft: HostProfile): SshRoutingMode {
  if (draft.jumpProfileIds?.length) return "jump";
  return draft.proxyMode ?? "direct";
}

function formatJumpProfileLabel(profile: HostProfile) {
  const name = profile.name || profile.host;
  const group = profile.tags?.[0]?.trim();
  return group ? `${name} (${group})` : name;
}

/** 主机配置编辑弹窗。 */
export default function ProfileModal({
  open,
  mode,
  draft,
  profiles,
  sshGroups,
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
  const [sshRoutingMode, setSshRoutingMode] =
    useState<SshRoutingMode>("direct");

  useEffect(() => {
    const becameOpen = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (becameOpen) {
      autoFilledRef.current = false;
      queueMicrotask(() => {
        setShowDiscardConfirm(false);
        setIconPickerOpen(false);
        setInitialDraftSnapshot(JSON.stringify(draft));
        setActiveSection("session");
        setNameError(null);
        setSshRoutingMode(resolveSshRoutingMode(draft));
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

  /** 更新 SSH 手动代理配置，并保留未编辑字段。 */
  function updateProxyConfig(
    patch: Partial<NonNullable<HostProfile["proxyConfig"]>>,
  ) {
    onDraftChange({
      ...draft,
      proxyConfig: {
        protocol: draft.proxyConfig?.protocol ?? "http",
        host: draft.proxyConfig?.host ?? "",
        port: draft.proxyConfig?.port ?? 8080,
        username: draft.proxyConfig?.username ?? null,
        passwordRef: draft.proxyConfig?.passwordRef ?? null,
        useProxyDns: draft.proxyConfig?.useProxyDns ?? true,
        ...patch,
      },
    });
  }

  /** 按顺序设置跳板链中某个节点。 */
  function setJumpProfileAt(index: number, profileId: string) {
    const current = [...(draft.jumpProfileIds ?? [])];
    current[index] = profileId;
    onDraftChange({ ...draft, jumpProfileIds: current.filter(Boolean) });
  }

  /** 在跳板链末尾追加一个未选择节点。 */
  function addJumpProfile(profileId: string) {
    const current = draft.jumpProfileIds ?? [];
    if (!profileId || current.includes(profileId)) return;
    onDraftChange({ ...draft, jumpProfileIds: [...current, profileId] });
  }

  /** 移除跳板链中的某个节点。 */
  function removeJumpProfile(index: number) {
    const current = [...(draft.jumpProfileIds ?? [])];
    current.splice(index, 1);
    onDraftChange({
      ...draft,
      jumpProfileIds: current.length ? current : null,
    });
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
    onDraftChange({
      id: draft.id,
      name: "",
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
    const proxyModeSelectId = `${formId}-proxy-mode`;
    const proxyProtocolSelectId = `${formId}-proxy-protocol`;
    const proxyHostInputId = `${formId}-proxy-host`;
    const proxyPortInputId = `${formId}-proxy-port`;
    const proxyUsernameInputId = `${formId}-proxy-username`;
    const proxyPasswordInputId = `${formId}-proxy-password`;
    const proxyDnsInputId = `${formId}-proxy-dns`;
    const jumpAddSelectId = `${formId}-jump-add`;

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
          <div className="form-row split">
            <div className="form-inline-field">
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
            <div className="form-inline-field">
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
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor={authTypeSelectId}>
              {t("profile.form.authType")}
            </label>
            <Select
              id={authTypeSelectId}
              value={draft.authType}
              options={[
                { value: "password", label: t("profile.auth.password") },
                { value: "privateKey", label: t("profile.auth.privateKey") },
              ]}
              onChange={(next) =>
                onDraftChange({
                  ...draft,
                  authType: next as HostProfile["authType"],
                })
              }
              aria-label={t("profile.form.authType")}
            />
          </div>
          {draft.authType === "password" && (
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
                  onDraftChange({ ...draft, passwordRef: event.target.value })
                }
              />
            </div>
          )}
          {draft.authType === "privateKey" && (
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
      const proxyMode = draft.proxyMode ?? "direct";
      const connectionMode =
        sshRoutingMode === "jump" || (draft.jumpProfileIds?.length ?? 0)
          ? "jump"
          : proxyMode;
      const proxyConfig = draft.proxyConfig ?? {
        protocol: "http" as const,
        host: "",
        port: 8080,
        username: null,
        passwordRef: null,
        useProxyDns: true,
      };
      const jumpCandidates = profiles.filter(
        (profile) => profile.id !== draft.id,
      );
      const selectedJumpIds = draft.jumpProfileIds ?? [];
      const unselectedJumpCandidates = jumpCandidates.filter(
        (profile) => !selectedJumpIds.includes(profile.id),
      );
      return (
        <div className="host-editor" data-page="profile-ssh-advanced">
          <section className="profile-settings-section" data-ui="ssh-routing">
            <div className="profile-settings-section-body host-editor">
              <div className="form-row">
                <label className="form-label" htmlFor={proxyModeSelectId}>
                  {t("profile.ssh.routing.mode")}
                </label>
                <Select
                  id={proxyModeSelectId}
                  value={connectionMode}
                  options={[
                    {
                      value: "direct",
                      label: t("profile.ssh.routing.mode.direct"),
                    },
                    {
                      value: "system",
                      label: t("profile.ssh.routing.mode.system"),
                    },
                    {
                      value: "manual",
                      label: t("profile.ssh.routing.mode.manual"),
                    },
                    {
                      value: "jump",
                      label: t("profile.ssh.routing.mode.jump"),
                    },
                  ]}
                  onChange={(next) => {
                    const nextMode = next as SshRoutingMode;
                    setSshRoutingMode(nextMode);
                    if (next === "jump") {
                      onDraftChange({
                        ...draft,
                        proxyMode: "direct",
                        jumpProfileIds: draft.jumpProfileIds ?? null,
                      });
                      return;
                    }
                    onDraftChange({
                      ...draft,
                      proxyMode: next as HostProfile["proxyMode"],
                      jumpProfileIds: null,
                      proxyConfig:
                        next === "manual"
                          ? (draft.proxyConfig ?? {
                              protocol: "http",
                              host: "",
                              port: 8080,
                              username: null,
                              passwordRef: null,
                              useProxyDns: true,
                            })
                          : draft.proxyConfig,
                    });
                  }}
                  aria-label={t("profile.ssh.routing.mode")}
                />
              </div>
              {connectionMode === "system" ? (
                <div className="profile-form-hint">
                  {t("profile.ssh.proxy.systemHint")}
                </div>
              ) : null}
              {connectionMode === "manual" ? (
                <>
                  <div className="form-row split">
                    <div className="form-inline-field">
                      <label
                        className="form-label"
                        htmlFor={proxyProtocolSelectId}
                      >
                        {t("profile.ssh.proxy.protocol")}
                      </label>
                      <Select
                        id={proxyProtocolSelectId}
                        value={proxyConfig.protocol}
                        options={[
                          { value: "http", label: "HTTP" },
                          { value: "socks5", label: "SOCKS5" },
                        ]}
                        onChange={(next) =>
                          updateProxyConfig({
                            protocol: next as NonNullable<
                              HostProfile["proxyConfig"]
                            >["protocol"],
                          })
                        }
                        aria-label={t("profile.ssh.proxy.protocol")}
                      />
                    </div>
                    <div className="form-inline-field">
                      <label className="form-label" htmlFor={proxyPortInputId}>
                        {t("profile.ssh.proxy.port")}
                      </label>
                      <input
                        id={proxyPortInputId}
                        type="number"
                        value={proxyConfig.port}
                        min={1}
                        max={65535}
                        onChange={(event) =>
                          updateProxyConfig({
                            port: Number(event.target.value),
                          })
                        }
                        data-ui="ssh-proxy-port"
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <label className="form-label" htmlFor={proxyHostInputId}>
                      {t("profile.ssh.proxy.host")}
                    </label>
                    <input
                      id={proxyHostInputId}
                      value={proxyConfig.host}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) =>
                        updateProxyConfig({ host: event.target.value })
                      }
                      data-ui="ssh-proxy-host"
                    />
                  </div>
                  <div className="form-row split">
                    <div className="form-inline-field">
                      <label
                        className="form-label"
                        htmlFor={proxyUsernameInputId}
                      >
                        {t("profile.ssh.proxy.username")}
                      </label>
                      <input
                        id={proxyUsernameInputId}
                        value={proxyConfig.username ?? ""}
                        autoComplete="off"
                        onChange={(event) =>
                          updateProxyConfig({
                            username: event.target.value || null,
                          })
                        }
                        data-ui="ssh-proxy-username"
                      />
                    </div>
                    <div className="form-inline-field">
                      <label
                        className="form-label"
                        htmlFor={proxyPasswordInputId}
                      >
                        {t("profile.ssh.proxy.password")}
                      </label>
                      <input
                        id={proxyPasswordInputId}
                        type="password"
                        value={proxyConfig.passwordRef ?? ""}
                        autoComplete="off"
                        onChange={(event) =>
                          updateProxyConfig({
                            passwordRef: event.target.value || null,
                          })
                        }
                        data-ui="ssh-proxy-password"
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <label className="form-label" htmlFor={proxyDnsInputId}>
                      {t("profile.ssh.proxy.dns")}
                    </label>
                    <label className="profile-checkbox-line">
                      <input
                        id={proxyDnsInputId}
                        type="checkbox"
                        checked={proxyConfig.useProxyDns ?? true}
                        onChange={(event) =>
                          updateProxyConfig({
                            useProxyDns: event.target.checked,
                          })
                        }
                        data-ui="ssh-proxy-dns"
                      />
                      <span>{t("profile.ssh.proxy.dnsEnabled")}</span>
                    </label>
                  </div>
                </>
              ) : null}
              {connectionMode === "jump" ? (
                <div className="profile-jump-list" data-ui="ssh-jump-chain">
                  {selectedJumpIds.map((profileId, index) => {
                    const options = jumpCandidates
                      .filter(
                        (profile) =>
                          profile.id === profileId ||
                          !selectedJumpIds.includes(profile.id),
                      )
                      .map((profile) => ({
                        value: profile.id,
                        label: formatJumpProfileLabel(profile),
                      }));
                    return (
                      <div
                        className="profile-jump-row"
                        key={`${profileId}:${index}`}
                      >
                        <label
                          className="form-label"
                          htmlFor={`${formId}-jump-${index}`}
                        >
                          {t("profile.ssh.jump.node", {
                            index: String(index + 1),
                          })}
                        </label>
                        <Select
                          id={`${formId}-jump-${index}`}
                          value={profileId}
                          options={options}
                          onChange={(value) => setJumpProfileAt(index, value)}
                          aria-label={t("profile.ssh.jump.node", {
                            index: String(index + 1),
                          })}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeJumpProfile(index)}
                        >
                          {t("profile.ssh.jump.remove")}
                        </Button>
                      </div>
                    );
                  })}
                  {jumpCandidates.length ? (
                    <div className="profile-jump-row">
                      <label className="form-label" htmlFor={jumpAddSelectId}>
                        {t("profile.ssh.jump.add")}
                      </label>
                      <Select
                        id={jumpAddSelectId}
                        value={null}
                        options={unselectedJumpCandidates.map((profile) => ({
                          value: profile.id,
                          label: formatJumpProfileLabel(profile),
                        }))}
                        disabled={!unselectedJumpCandidates.length}
                        onChange={addJumpProfile}
                        placeholder={t("profile.ssh.jump.selectPlaceholder")}
                        aria-label={t("profile.ssh.jump.add")}
                      />
                    </div>
                  ) : (
                    <div className="profile-form-hint">
                      {t("profile.ssh.jump.empty")}
                    </div>
                  )}
                  {jumpCandidates.length && !selectedJumpIds.length ? (
                    <div className="profile-form-hint">
                      {t("profile.ssh.jump.selectHint")}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          {(draft.proxyCommand || draft.proxyJump) && (
            <section
              className="profile-settings-section"
              data-ui="ssh-imported"
            >
              <div className="profile-settings-section-header">
                <div>
                  <h4>{t("profile.ssh.imported.title")}</h4>
                  <p>{t("profile.ssh.imported.hint")}</p>
                </div>
              </div>
              {draft.proxyJump ? (
                <div className="profile-form-hint">
                  ProxyJump: {draft.proxyJump}
                </div>
              ) : null}
              {draft.proxyCommand ? (
                <div className="profile-form-hint">
                  ProxyCommand: {draft.proxyCommand}
                </div>
              ) : null}
            </section>
          )}
        </div>
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
