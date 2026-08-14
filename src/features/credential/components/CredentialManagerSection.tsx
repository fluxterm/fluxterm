import { useId, useMemo, useState } from "react";
import { FiEdit2, FiKey, FiPlus, FiSearch, FiTrash2 } from "react-icons/fi";
import Button from "@/components/ui/button";
import Modal from "@/components/ui/modal/Modal";
import Select from "@/components/ui/select";
import type { Translate } from "@/i18n";
import type { CredentialSaveInput } from "@/features/credential/core/commands";
import { extractErrorMessage } from "@/shared/errors/appError";
import type {
  CredentialKind,
  CredentialReuseMode,
  CredentialSummary,
} from "@/types";

type CredentialManagerSectionProps = {
  sshCredentials: CredentialSummary[];
  rdpCredentials: CredentialSummary[];
  busy: boolean;
  locked: boolean;
  defaultReuseMode: CredentialReuseMode;
  onDefaultReuseModeChange: (value: CredentialReuseMode) => void;
  onSave?: (input: CredentialSaveInput) => Promise<CredentialSummary>;
  onDelete?: (credentialId: string, kind: CredentialKind) => Promise<void>;
  t: Translate;
};

type CredentialDraft = {
  id: string;
  kind: CredentialKind;
  name: string;
  username: string;
  password: string;
};

/** 密码管理器配置分区，负责分类型凭据的检索与维护。 */
export default function CredentialManagerSection({
  sshCredentials,
  rdpCredentials,
  busy,
  locked,
  defaultReuseMode,
  onDefaultReuseModeChange,
  onSave,
  onDelete,
  t,
}: CredentialManagerSectionProps) {
  const formId = useId();
  const [kind, setKind] = useState<CredentialKind>("ssh");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<CredentialDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CredentialSummary | null>(
    null,
  );
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const source = kind === "ssh" ? sshCredentials : rdpCredentials;
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return source;
    return source.filter(
      (credential) =>
        credential.name.toLocaleLowerCase().includes(keyword) ||
        credential.username.toLocaleLowerCase().includes(keyword),
    );
  }, [query, source]);

  function openCreate() {
    setActionError("");
    setDraft({ id: "", kind, name: "", username: "", password: "" });
  }

  function openEdit(credential: CredentialSummary) {
    setActionError("");
    setDraft({
      id: credential.id,
      kind: credential.kind,
      name: credential.name,
      username: credential.username,
      password: "",
    });
  }

  async function submitDraft() {
    if (!draft || !onSave) return;
    setActionBusy(true);
    setActionError("");
    try {
      await onSave({
        id: draft.id || undefined,
        kind: draft.kind,
        name: draft.name,
        username: draft.username,
        password: draft.password || undefined,
      });
      setDraft(null);
    } catch (error) {
      setActionError(extractErrorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }

  function requestDelete(credential: CredentialSummary) {
    setActionError("");
    setDeleteTarget(credential);
  }

  async function confirmDelete() {
    if (!deleteTarget || !onDelete) return;
    setActionBusy(true);
    setActionError("");
    try {
      await onDelete(deleteTarget.id, deleteTarget.kind);
      setDeleteTarget(null);
    } catch (error) {
      setActionError(extractErrorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div
      className="config-modal-widget credential-manager"
      data-page="credential-manager"
    >
      <div className="credential-manager-heading">
        <div>
          <h3>{t("config.section.credentials")}</h3>
        </div>
        <Button
          size="sm"
          disabled={busy || actionBusy || locked}
          onClick={openCreate}
          data-ui="credential-create"
        >
          <FiPlus aria-hidden="true" />
          {t("credentials.add")}
        </Button>
      </div>

      <label className="config-toggle-card">
        <div className="config-toggle-copy">
          <span className="config-toggle-title">
            {t("credentials.defaultMode")}
          </span>
        </div>
        <div className="config-select-control">
          <Select
            value={defaultReuseMode}
            options={[
              { value: "reference", label: t("credentials.mode.reference") },
              { value: "copy", label: t("credentials.mode.copy") },
            ]}
            onChange={(value) =>
              onDefaultReuseModeChange(value as CredentialReuseMode)
            }
            aria-label={t("credentials.defaultMode")}
          />
        </div>
      </label>

      {locked ? (
        <div className="credential-manager-notice" role="status">
          {t("credentials.lockedHint")}
        </div>
      ) : null}
      {actionError ? (
        <div className="credential-manager-error" role="alert">
          {actionError}
        </div>
      ) : null}

      <div className="credential-manager-toolbar">
        <div className="credential-kind-tabs" role="tablist">
          {(["ssh", "rdp"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={kind === item}
              className={kind === item ? "active" : ""}
              onClick={() => setKind(item)}
              data-ui={`credential-kind-${item}`}
            >
              {item.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="credential-search">
          <FiSearch aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("credentials.searchPlaceholder")}
            aria-label={t("terminal.menu.search")}
            data-ui="credential-search"
          />
        </label>
      </div>

      <div className="credential-list" data-slot="credential-list">
        {!filtered.length ? (
          <div className="config-empty-state">{t("credentials.empty")}</div>
        ) : (
          filtered.map((credential) => (
            <article className="credential-card" key={credential.id}>
              <span className="credential-card-icon" aria-hidden="true">
                <FiKey />
              </span>
              <div className="credential-card-copy">
                <strong>{credential.name}</strong>
              </div>
              <div className="credential-card-actions">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("credentials.edit")}
                  disabled={locked || busy || actionBusy}
                  onClick={() => openEdit(credential)}
                >
                  <FiEdit2 />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("actions.remove")}
                  disabled={locked || busy || actionBusy}
                  onClick={() => requestDelete(credential)}
                >
                  <FiTrash2 />
                </Button>
              </div>
            </article>
          ))
        )}
      </div>

      <Modal
        open={draft !== null}
        title={draft?.id ? t("credentials.edit") : t("credentials.add")}
        closeLabel={t("actions.close")}
        onClose={() => setDraft(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t("actions.cancel")}
            </Button>
            <Button
              disabled={
                actionBusy ||
                !draft?.name.trim() ||
                !draft?.username.trim() ||
                (!draft?.id && !draft?.password)
              }
              onClick={() => void submitDraft()}
            >
              {t("actions.save")}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="host-editor" data-ui="credential-editor">
            <div className="form-row">
              <label className="form-label" htmlFor={`${formId}-name`}>
                {t("credentials.name")}
              </label>
              <input
                id={`${formId}-name`}
                value={draft.name}
                autoComplete="off"
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor={`${formId}-username`}>
                {t("profile.form.username")}
              </label>
              <input
                id={`${formId}-username`}
                value={draft.username}
                autoComplete="off"
                onChange={(event) =>
                  setDraft({ ...draft, username: event.target.value })
                }
              />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor={`${formId}-password`}>
                {t("profile.form.password")}
              </label>
              <input
                id={`${formId}-password`}
                type="password"
                value={draft.password}
                autoComplete="new-password"
                placeholder={
                  draft.id ? t("credentials.passwordKeepHint") : undefined
                }
                onChange={(event) =>
                  setDraft({ ...draft, password: event.target.value })
                }
              />
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title={t("credentials.deleteTitle")}
        closeLabel={t("actions.close")}
        onClose={() => setDeleteTarget(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={actionBusy}
              onClick={() => void confirmDelete()}
            >
              {t("actions.remove")}
            </Button>
          </>
        }
      >
        <p>{t("credentials.deleteHint")}</p>
      </Modal>
    </div>
  );
}
