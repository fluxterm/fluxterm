/**
 * SFTP 控制器 Hook。
 * 职责：对外暴露分组后的 SFTP 状态与操作接口。
 */
import useSftpStateCore from "@/hooks/useSftpStateCore";

/**
 * SFTP 控制器入口。
 * 目前先兼容复用原 useSftpState，后续再拆分 command/viewState 模块。
 */
export default function useSftpController(
  props: Parameters<typeof useSftpStateCore>[0],
) {
  const raw = useSftpStateCore(props);

  return {
    sftpState: {
      currentPath: raw.currentPath,
      entries: raw.entries,
      runningTransfers: raw.runningTransfers,
      availabilityBySession: raw.availabilityBySession,
    },
    sftpActions: {
      refreshList: raw.refreshList,
      openRemoteDir: raw.openRemoteDir,
      uploadFile: raw.uploadFile,
      uploadDroppedPaths: raw.uploadDroppedPaths,
      downloadFile: raw.downloadFile,
      cancelTransfer: raw.cancelTransfer,
      createFolder: raw.createFolder,
      rename: raw.rename,
      remove: raw.remove,
    },
  };
}
