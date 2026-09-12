import { useCallback, useEffect, useState } from "react";
import {
  deleteCredential,
  listCredentials,
  saveCredential,
  type CredentialSaveInput,
} from "@/features/credential/core/commands";
import { extractErrorMessage } from "@/shared/errors/appError";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import type { CredentialSummary } from "@/types";

/** SSH 凭据状态与持久化操作。 */
export default function useCredentials() {
  const [sshCredentials, setSshCredentials] = useState<CredentialSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const ssh = await listCredentials("ssh");
      setSshCredentials(ssh);
      setError(null);
    } catch (loadError) {
      setError(extractErrorMessage(loadError));
      throw loadError;
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    return scheduleDeferredTask(() => {
      void reload().catch(() => {});
    });
  }, [reload]);

  async function save(input: CredentialSaveInput) {
    setBusy(true);
    try {
      const saved = await saveCredential(input);
      setSshCredentials((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [...current, saved];
      });
      setError(null);
      return saved;
    } catch (saveError) {
      setError(extractErrorMessage(saveError));
      throw saveError;
    } finally {
      setBusy(false);
    }
  }

  async function remove(credentialId: string) {
    setBusy(true);
    try {
      await deleteCredential(credentialId, true);
      setSshCredentials((current) =>
        current.filter((item) => item.id !== credentialId),
      );
      setError(null);
    } catch (deleteError) {
      setError(extractErrorMessage(deleteError));
      throw deleteError;
    } finally {
      setBusy(false);
    }
  }

  return {
    sshCredentials,
    loaded,
    busy,
    error,
    reload,
    save,
    remove,
  };
}
