/**
 * SFTP 命令模块。
 * 职责：封装本地文件与远端 SFTP 的 tauri 命令调用。
 */
import { invokeTauriCommand } from "@/shared/tauri/commands";
import type { SftpEntry, SftpProgress } from "@/types";

/** 读取本地目录。 */
export function localList(path: string) {
  return invokeTauriCommand<SftpEntry[]>("local_list", { path });
}

/** 读取本地 home。 */
export function localHome() {
  return invokeTauriCommand<string>("local_home");
}

/** 读取远端目录。 */
export function sftpList(sessionId: string, path: string) {
  return invokeTauriCommand<SftpEntry[]>("sftp_list", { sessionId, path });
}

/** 读取远端 home。 */
export function sftpHome(sessionId: string) {
  return invokeTauriCommand<string>("sftp_home", { sessionId });
}

/** 解析远端路径到真实路径。 */
export function sftpResolvePath(sessionId: string, path: string) {
  return invokeTauriCommand<string>("sftp_resolve_path", { sessionId, path });
}

/** 上传文件。 */
export function sftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
) {
  return invokeTauriCommand<SftpProgress>("sftp_upload", {
    sessionId,
    localPath,
    remotePath,
  });
}

/** 上传一组文件或目录。 */
export function sftpUploadPaths(
  sessionId: string,
  localPaths: string[],
  remoteDir: string,
) {
  return invokeTauriCommand<SftpProgress>("sftp_upload_paths", {
    sessionId,
    localPaths,
    remoteDir,
  });
}

/** 下载文件。 */
export function sftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
) {
  return invokeTauriCommand<SftpProgress>("sftp_download", {
    sessionId,
    remotePath,
    localPath,
  });
}

/** 下载目录。 */
export function sftpDownloadDir(
  sessionId: string,
  remotePath: string,
  localDir: string,
) {
  return invokeTauriCommand<SftpProgress>("sftp_download_dir", {
    sessionId,
    remotePath,
    localDir,
  });
}

/** 取消传输。 */
export function sftpCancelTransfer(sessionId: string, transferId: string) {
  return invokeTauriCommand("sftp_cancel_transfer", { sessionId, transferId });
}

/** 新建目录。 */
export function sftpMkdir(sessionId: string, path: string) {
  return invokeTauriCommand("sftp_mkdir", { sessionId, path });
}

/** 重命名。 */
export function sftpRename(sessionId: string, from: string, to: string) {
  return invokeTauriCommand("sftp_rename", { sessionId, from, to });
}

/** 删除条目。 */
export function sftpRemove(sessionId: string, path: string) {
  return invokeTauriCommand("sftp_remove", { sessionId, path });
}
