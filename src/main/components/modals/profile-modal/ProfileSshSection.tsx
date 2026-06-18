/** SSH Profile 高级连接配置分区，负责代理、跳板链和 OpenSSH 导入字段展示。 */
import type { Dispatch, SetStateAction } from "react";
import type { Translate } from "@/i18n";
import type { HostProfile } from "@/types";
import Button from "@/components/ui/button";
import Select from "@/components/ui/select";
import type { SshRoutingMode } from "@/main/components/modals/profile-modal/ProfileSshSection.utils";

type ProfileSshSectionProps = {
  formId: string;
  draft: HostProfile;
  profiles: HostProfile[];
  sshRoutingMode: SshRoutingMode;
  setSshRoutingMode: Dispatch<SetStateAction<SshRoutingMode>>;
  onDraftChange: (draft: HostProfile) => void;
  t: Translate;
};

function formatJumpProfileLabel(profile: HostProfile) {
  const name = profile.name || profile.host;
  const group = profile.tags?.[0]?.trim();
  return group ? `${name} (${group})` : name;
}

export default function ProfileSshSection({
  formId,
  draft,
  profiles,
  sshRoutingMode,
  setSshRoutingMode,
  onDraftChange,
  t,
}: ProfileSshSectionProps) {
  const proxyModeSelectId = `${formId}-proxy-mode`;
  const proxyProtocolSelectId = `${formId}-proxy-protocol`;
  const proxyHostInputId = `${formId}-proxy-host`;
  const proxyPortInputId = `${formId}-proxy-port`;
  const proxyUsernameInputId = `${formId}-proxy-username`;
  const proxyPasswordInputId = `${formId}-proxy-password`;
  const proxyDnsInputId = `${formId}-proxy-dns`;
  const jumpAddSelectId = `${formId}-jump-add`;

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
  const jumpCandidates = profiles.filter((profile) => profile.id !== draft.id);
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
                  <label className="form-label" htmlFor={proxyProtocolSelectId}>
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
                  <label className="form-label" htmlFor={proxyUsernameInputId}>
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
                  <label className="form-label" htmlFor={proxyPasswordInputId}>
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
        <section className="profile-settings-section" data-ui="ssh-imported">
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
