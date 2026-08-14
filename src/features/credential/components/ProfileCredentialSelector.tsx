import { useId, useState } from "react";
import Button from "@/components/ui/button";
import Modal from "@/components/ui/modal/Modal";
import Select from "@/components/ui/select";
import type { Translate } from "@/i18n";
import {
  resolveCredentialForCopy,
  type CredentialSaveInput,
} from "@/features/credential/core/commands";
import { extractErrorMessage } from "@/shared/errors/appError";
import type {
  CredentialKind,
  CredentialReuseMode,
  CredentialSummary,
} from "@/types";

type ProfileCredentialSelectorProps = {
  kind: CredentialKind;
  credentialId?: string | null;
  credentials: CredentialSummary[];
  defaultReuseMode: CredentialReuseMode;
  showFields?: boolean;
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  onChange: (value: {
    credentialId: string | null;
    username: string;
    passwordRef: string | null;
  }) => void;
  onCredentialSave?: (input: CredentialSaveInput) => Promise<CredentialSummary>;
  t: Translate;
};

/** Profile 表单中的分类型凭据选择器。 */
export default function ProfileCredentialSelector({
  kind,
  credentialId,
  credentials,
  defaultReuseMode,
  showFields = true,
  createOpen = false,
  onCreateOpenChange,
  onChange,
  onCredentialSave,
  t,
}: ProfileCredentialSelectorProps) {
  const formId = useId();
  const [reuseMode, setReuseMode] = useState<CredentialReuseMode>(
    credentialId ? "reference" : defaultReuseMode,
  );
  const [selectedCredentialId, setSelectedCredentialId] = useState(
    credentialId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const effectiveReuseMode = credentialId ? "reference" : reuseMode;
  const effectiveSelectedCredentialId = credentialId ?? selectedCredentialId;

  async function applyCredential(id: string, mode = effectiveReuseMode) {
    setError("");
    setSelectedCredentialId(id);
    if (!id) {
      onChange({ credentialId: null, username: "", passwordRef: null });
      return;
    }
    if (mode === "reference") {
      onChange({ credentialId: id, username: "", passwordRef: null });
      return;
    }
    setBusy(true);
    try {
      const value = await resolveCredentialForCopy(id, kind);
      onChange({
        credentialId: null,
        username: value.username,
        passwordRef: value.password,
      });
    } catch (copyError) {
      setError(extractErrorMessage(copyError));
    } finally {
      setBusy(false);
    }
  }

  async function changeReuseMode(mode: CredentialReuseMode) {
    setReuseMode(mode);
    if (effectiveSelectedCredentialId) {
      await applyCredential(effectiveSelectedCredentialId, mode);
    }
  }

  async function createCredential() {
    if (!onCredentialSave) return;
    setBusy(true);
    setError("");
    try {
      const saved = await onCredentialSave({
        kind,
        name,
        username,
        password,
      });
      setName("");
      setUsername("");
      setPassword("");
      await applyCredential(saved.id);
      onCreateOpenChange?.(false);
    } catch (saveError) {
      setError(extractErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {showFields ? (
        <div
          className="profile-credential-selector"
          data-ui={`${kind}-credential-selector`}
        >
          <div className="form-row">
            <label className="form-label">
              {t("credentials.profileSource")}
            </label>
            <Select
              value={effectiveSelectedCredentialId}
              options={[
                { value: "", label: t("credentials.select") },
                ...credentials.map((credential) => ({
                  value: credential.id,
                  label: credential.name,
                })),
              ]}
              disabled={busy}
              onChange={(value) => void applyCredential(value)}
              aria-label={t("credentials.profileSource")}
            />
          </div>
          <div className="form-row">
            <label className="form-label">{t("credentials.reuseMode")}</label>
            <Select
              value={effectiveReuseMode}
              options={[
                { value: "reference", label: t("credentials.mode.reference") },
                { value: "copy", label: t("credentials.mode.copy") },
              ]}
              disabled={busy}
              onChange={(value) =>
                void changeReuseMode(value as CredentialReuseMode)
              }
              aria-label={t("credentials.reuseMode")}
            />
          </div>
          {error ? (
            <div className="profile-inline-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}

      <Modal
        open={createOpen}
        title={t("credentials.add")}
        closeLabel={t("actions.close")}
        onClose={() => onCreateOpenChange?.(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => onCreateOpenChange?.(false)}>
              {t("actions.cancel")}
            </Button>
            <Button
              disabled={
                busy ||
                !onCredentialSave ||
                !name.trim() ||
                !username.trim() ||
                !password
              }
              onClick={() => void createCredential()}
            >
              {t("actions.save")}
            </Button>
          </>
        }
      >
        <div className="host-editor">
          <div className="form-row">
            <label className="form-label" htmlFor={`${formId}-credential-name`}>
              {t("credentials.name")}
            </label>
            <input
              id={`${formId}-credential-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor={`${formId}-credential-user`}>
              {t("profile.form.username")}
            </label>
            <input
              id={`${formId}-credential-user`}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="form-row">
            <label
              className="form-label"
              htmlFor={`${formId}-credential-password`}
            >
              {t("profile.form.password")}
            </label>
            <input
              id={`${formId}-credential-password`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
      </Modal>
    </>
  );
}
