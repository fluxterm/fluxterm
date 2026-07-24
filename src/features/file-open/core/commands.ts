/**
 * 文件打开与远端编辑命令。
 * 职责：封装本地文件打开与远端编辑实例的 tauri 命令调用。
 */
import { callTauri } from "@/shared/tauri/commands";
import { createOperationId } from "@/shared/logging";
import type { RemoteEditSnapshot, SftpEntry } from "@/types";

type RemoteEditOpenTarget = {
  host: string;
  username: string;
  port: number;
};

/** 使用默认编辑器或系统默认程序打开本地文件。 */
export async function openLocalFile(
  filePath: string,
  defaultEditorPath: string,
) {
  return callTauri("file_open", {
    filePath,
    defaultEditorPath: defaultEditorPath.trim() || null,
  });
}

/** 打开远端文件，并在后端登记远端编辑实例。 */
export async function openRemoteFileForEditing(
  sessionId: string,
  target: RemoteEditOpenTarget,
  entry: SftpEntry,
  defaultEditorPath: string,
) {
  return callTauri<RemoteEditSnapshot>("remote_edit_open", {
    request: {
      sessionId,
      target: {
        sessionHost: target.host,
        sessionUsername: target.username,
        sessionPort: target.port,
      },
      entry,
      defaultEditorPath: defaultEditorPath.trim() || null,
      operationId: createOperationId(),
    },
  });
}

/** 获取当前活动的远端编辑实例。 */
export async function listRemoteEditSessions() {
  return callTauri<RemoteEditSnapshot[]>("remote_edit_list");
}

/** 确认上传当前远端编辑实例的本地修改。 */
export async function confirmRemoteEditUpload(instanceId: string) {
  return callTauri<RemoteEditSnapshot>("remote_edit_confirm_upload", {
    instanceId,
    operationId: createOperationId(),
  });
}

/** 忽略当前远端编辑实例待确认的本地修改。 */
export async function dismissRemoteEditPending(instanceId: string) {
  return callTauri<RemoteEditSnapshot>("remote_edit_dismiss_pending", {
    instanceId,
    operationId: createOperationId(),
  });
}
