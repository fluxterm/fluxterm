import { invokeTauriCommand } from "@/shared/tauri/commands";
import type { CredentialKind, CredentialSummary } from "@/types";

export type CredentialSaveInput = {
  id?: string;
  kind: CredentialKind;
  name: string;
  username: string;
  password?: string;
};

export type CredentialCopyValue = {
  username: string;
  password: string;
};

/** 按协议读取凭据摘要。 */
export function listCredentials(kind: CredentialKind) {
  return invokeTauriCommand<CredentialSummary[]>("credential_list", { kind });
}

/** 创建或更新凭据。 */
export function saveCredential(input: CredentialSaveInput) {
  return invokeTauriCommand<CredentialSummary>("credential_save", { input });
}

/** 显式解析凭据，用于复制到会话。 */
export function resolveCredentialForCopy(
  credentialId: string,
  expectedKind: CredentialKind,
) {
  return invokeTauriCommand<CredentialCopyValue>(
    "credential_resolve_for_copy",
    {
      credentialId,
      expectedKind,
    },
  );
}

/** 删除凭据，并可显式解除现有引用。 */
export function deleteCredential(
  credentialId: string,
  detachReferences: boolean,
) {
  return invokeTauriCommand<boolean>("credential_delete", {
    input: { credentialId, detachReferences },
  });
}
