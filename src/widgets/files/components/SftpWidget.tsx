/**
 * SFTP 文件组件。
 * 负责目录浏览、文件操作和文件组件上下文菜单。
 */
import { useEffect, useRef, useState } from "react";
import { error as logError, warn as logWarn } from "@/shared/logging/telemetry";
import { openPath } from "@tauri-apps/plugin-opener";
import type { IconType } from "react-icons";
import type { Locale, Translate } from "@/i18n";
import type { SftpAvailability, SftpEntry } from "@/types";
import { scheduleDeferredTask } from "@/hooks/useDeferredEffect";
import useSftpDropUpload from "@/hooks/useSftpDropUpload";
import { formatBytes, formatTime } from "@/utils/format";
import { isRootPath, parentPath } from "@/utils/path";
import { useNotices } from "@/hooks/useNotices";
import { extractErrorMessage } from "@/shared/errors/appError";
import InputDialog from "@/components/ui/InputDialog";
import ContextMenu from "@/components/ui/menu/ContextMenu";
import Tooltip from "@/components/ui/menu/Tooltip";
import {
  FiCode,
  FiRefreshCw,
  FiClock,
  FiCornerLeftUp,
  FiDownload,
  FiDatabase,
  FiEdit2,
  FiEye,
  FiFile,
  FiFileText,
  FiFolder,
  FiFolderPlus,
  FiInfo,
  FiImage,
  FiLink2,
  FiLock,
  FiLink,
  FiSlash,
  FiMoreVertical,
  FiPackage,
  FiSettings,
  FiTerminal,
  FiTrash2,
  FiUpload,
  FiVideo,
} from "react-icons/fi";
import Button from "@/components/ui/button";
import "./Sftpwidget.css";

/** 将 WSL UNC 路径格式化为更符合 Linux 心智的展示形式。 */
function formatDisplayPath(path: string) {
  const wslMatch = path.match(/^\\\\wsl\.localhost\\[^\\]+(?<tail>\\.*)?$/i);
  if (!wslMatch) return path;
  const tail = wslMatch.groups?.tail ?? "";
  return tail ? tail.replace(/\\/g, "/") : "/";
}

type SftpWidgetProps = {
  isRemote: boolean;
  isRemoteSession: boolean;
  currentPath: string;
  sftpAvailability?: SftpAvailability;
  terminalPathSyncStatus?:
    | "active"
    | "paused"
    | "checking"
    | "unsupported"
    | "disabled";
  entries: SftpEntry[];
  onRefresh: (path?: string) => void;
  onOpen: (path: string) => void;
  onOpenFile: (entry: SftpEntry) => Promise<void>;
  onUpload: () => void;
  onDropUpload: (paths: string[]) => Promise<void>;
  onDownload: (entry: SftpEntry) => void;
  onMkdir: (name: string) => void;
  onRename: (entry: SftpEntry, name: string) => void;
  onRemove: (entry: SftpEntry) => Promise<void>;
  locale: Locale;
  t: Translate;
};

type FileIconMeta = {
  Icon: IconType;
  tone: string;
};

const CODE_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "lua",
  "md",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);
const VIDEO_EXTENSIONS = new Set([
  "avi",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "webm",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "7z",
  "bz2",
  "gz",
  "rar",
  "tar",
  "tgz",
  "xz",
  "zip",
]);
const CONFIG_EXTENSIONS = new Set([
  "conf",
  "cfg",
  "config",
  "env",
  "ini",
  "properties",
]);

/** 图标判定优先走文件实体 kind，其次才按扩展名粗分普通文件类型。 */
function getEntryIconMeta(entry: SftpEntry): FileIconMeta {
  if (entry.kind === "dir") {
    return { Icon: FiFolder, tone: "folder" };
  }
  if (entry.kind === "link") {
    return { Icon: FiLink2, tone: "link" };
  }

  const parts = entry.name.split(".");
  const extension =
    parts.length > 1 ? (parts[parts.length - 1]?.toLowerCase() ?? "") : "";

  if (CODE_EXTENSIONS.has(extension)) {
    if (extension === "sh" || extension === "bash" || extension === "zsh") {
      return { Icon: FiTerminal, tone: "script" };
    }
    if (extension === "sql") {
      return { Icon: FiDatabase, tone: "database" };
    }
    return { Icon: FiCode, tone: "code" };
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return { Icon: FiImage, tone: "image" };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { Icon: FiVideo, tone: "media" };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return { Icon: FiPackage, tone: "archive" };
  }
  if (CONFIG_EXTENSIONS.has(extension)) {
    return { Icon: FiSettings, tone: "config" };
  }
  if (
    extension === "log" ||
    extension === "txt" ||
    extension === "csv" ||
    extension === "pdf"
  ) {
    return { Icon: FiFileText, tone: "text" };
  }
  if (extension === "key" || extension === "pem" || extension === "crt") {
    return { Icon: FiLock, tone: "secure" };
  }
  return { Icon: FiFile, tone: "file" };
}

/** SFTP 文件管理面板。 */
export default function SftpWidget({
  isRemote,
  isRemoteSession,
  currentPath,
  sftpAvailability = "ready",
  terminalPathSyncStatus = "checking",
  entries,
  onRefresh,
  onOpen,
  onOpenFile,
  onUpload,
  onDropUpload,
  onDownload,
  onMkdir,
  onRename,
  onRemove,
  locale,
  t,
}: SftpWidgetProps) {
  const { openDialog, pushToast } = useNotices();
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const headerScrollRef = useRef<HTMLDivElement | null>(null);
  const listBodyRef = useRef<HTMLDivElement | null>(null);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(
    null,
  );
  const [showHiddenEntries, setShowHiddenEntries] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: SftpEntry;
  } | null>(null);
  const [actionsMenu, setActionsMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [entryDialog, setEntryDialog] = useState<{
    mode: "mkdir" | "rename";
    title: string;
    label: string;
    initialValue: string;
    sourceEntry: SftpEntry | null;
  } | null>(null);
  const [entryDialogError, setEntryDialogError] = useState<string | null>(null);
  const showUnavailable = isRemoteSession && !isRemote;
  const showSftpDisabled = isRemoteSession && sftpAvailability === "disabled";
  const showSftpUnsupported =
    isRemoteSession && sftpAvailability === "unsupported";
  const interactionsDisabled =
    showUnavailable || showSftpDisabled || showSftpUnsupported;
  const dropEnabled = !interactionsDisabled && isRemote && !!currentPath;
  const dropState = useSftpDropUpload({
    enabled: dropEnabled,
    widgetRef,
    onDropPaths: onDropUpload,
  });
  // 隐藏文件显示控制只作用于列表层，不改变后端目录读取结果。
  const visibleEntries = showHiddenEntries
    ? entries
    : entries.filter((entry) => entry.hidden !== true);

  useEffect(() => {
    const listBody = listBodyRef.current;
    const header = headerScrollRef.current;
    if (!listBody || !header) return;

    // 文件列表的横向滚动发生在 body 容器中，表头是独立层；
    // 因此需要把 body 的 scrollLeft 同步给表头，避免列标题与内容错位。
    const syncHeaderScroll = () => {
      header.scrollLeft = listBody.scrollLeft;
    };

    syncHeaderScroll();
    listBody.addEventListener("scroll", syncHeaderScroll, { passive: true });
    return () => {
      listBody.removeEventListener("scroll", syncHeaderScroll);
    };
  }, [entries, interactionsDisabled]);

  useEffect(() => {
    if (!selectedEntryPath) return;
    if (visibleEntries.some((entry) => entry.path === selectedEntryPath))
      return;
    const cancel = scheduleDeferredTask(() => {
      setSelectedEntryPath(null);
    });
    return cancel;
  }, [selectedEntryPath, visibleEntries]);

  const pathSyncMeta =
    terminalPathSyncStatus === "active"
      ? {
          Icon: FiLink,
          tone: "active",
          label: t("sftp.pathSync.active"),
        }
      : terminalPathSyncStatus === "checking"
        ? {
            Icon: FiRefreshCw,
            tone: "checking",
            label: t("sftp.pathSync.checking"),
          }
        : terminalPathSyncStatus === "paused"
          ? {
              Icon: FiClock,
              tone: "paused",
              label: t("sftp.pathSync.paused"),
            }
          : terminalPathSyncStatus === "unsupported"
            ? {
                Icon: FiInfo,
                tone: "unsupported",
                label: t("sftp.pathSync.unsupported"),
              }
            : {
                Icon: FiSlash,
                tone: "disabled",
                label: t("sftp.pathSync.disabled"),
              };
  const displayPath = interactionsDisabled
    ? "-"
    : formatDisplayPath(currentPath);
  // 操作菜单按运行态收口可见项：
  // 本地 shell 不显示“新建 / 上传”，SSH 会话不显示“文件管理器”。
  const actionMenuItems = [
    {
      label: showHiddenEntries ? t("sftp.hideHidden") : t("sftp.showHidden"),
      icon: <FiEye />,
      disabled: false,
      onClick: () => {
        setShowHiddenEntries((prev) => !prev);
        closeActionsMenu();
      },
    },
    ...(!isRemoteSession
      ? [
          {
            label: t("sftp.openInFileManager"),
            icon: <FiFolder />,
            disabled: !currentPath,
            onClick: () => {
              void (async () => {
                if (!currentPath) return;
                try {
                  await openPath(currentPath);
                } catch (error) {
                  const errorMessage = extractErrorMessage(error);
                  const message = errorMessage.includes(
                    "Not allowed to open path",
                  )
                    ? t("sftp.openInFileManagerDenied")
                    : t("sftp.openInFileManagerFailed");
                  const logOpenFailure = errorMessage.includes(
                    "Not allowed to open path",
                  )
                    ? logWarn
                    : logError;
                  pushToast({
                    level: "error",
                    message,
                  });
                  void logOpenFailure(
                    JSON.stringify({
                      event: "sftp.open.in.file.manager.failed",
                      path: currentPath,
                      message: errorMessage,
                    }),
                  );
                } finally {
                  closeActionsMenu();
                }
              })();
            },
          },
        ]
      : []),
    ...(isRemote
      ? [
          {
            label: t("actions.new"),
            icon: <FiFolderPlus />,
            disabled: false,
            onClick: () => {
              setEntryDialog({
                mode: "mkdir",
                title: t("actions.new"),
                label: t("prompts.newFolder"),
                initialValue: "",
                sourceEntry: null,
              });
              setEntryDialogError(null);
              closeActionsMenu();
            },
          },
          {
            label: t("actions.upload"),
            icon: <FiUpload />,
            disabled: false,
            onClick: () => {
              onUpload();
              closeActionsMenu();
            },
          },
        ]
      : []),
  ];

  function openMenu(event: React.MouseEvent, entry: SftpEntry) {
    event.preventDefault();
    setSelectedEntryPath(entry.path);
    setMenu({ x: event.clientX, y: event.clientY, entry });
  }

  function closeMenu() {
    setMenu(null);
  }

  function openActionsMenu(event: React.MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setActionsMenu({ x: rect.left, y: rect.bottom + 6 });
  }

  function closeActionsMenu() {
    setActionsMenu(null);
  }

  function closeEntryDialog() {
    setEntryDialog(null);
    setEntryDialogError(null);
  }

  function submitEntryDialog(value: string) {
    if (!entryDialog) return;
    const name = value.trim();
    if (!name) {
      setEntryDialogError(t("sftp.nameRequired"));
      return;
    }
    if (entryDialog.mode === "mkdir") {
      onMkdir(name);
      closeEntryDialog();
      return;
    }
    if (!entryDialog.sourceEntry || name === entryDialog.sourceEntry.name) {
      closeEntryDialog();
      return;
    }
    onRename(entryDialog.sourceEntry, name);
    closeEntryDialog();
  }

  function handleSelectEntry(entry: SftpEntry) {
    setSelectedEntryPath(entry.path);
  }

  async function handleOpenEntry(entry: SftpEntry) {
    if (entry.kind === "dir" || entry.kind === "link") {
      onOpen(entry.path);
      return;
    }
    try {
      await onOpenFile(entry);
    } catch (error) {
      const message = extractErrorMessage(error);
      pushToast({
        level: "error",
        message: isRemote
          ? t("sftp.downloadForOpenFailed")
          : t("sftp.openFileFailed"),
      });
      void logError(
        JSON.stringify({
          event: isRemote
            ? "sftp:open-remote-file-failed"
            : "local:file-open-failed",
          path: entry.path,
          message,
        }),
      );
    }
  }

  return (
    <div
      ref={widgetRef}
      className={`sftp-widget ${dropState !== "idle" ? `drop-${dropState}` : ""}`.trim()}
    >
      <div className="sftp-toolbar">
        <div className="path-with-sync">
          <Tooltip content={pathSyncMeta.label}>
            <span
              className={`path-sync-indicator ${pathSyncMeta.tone}`}
              aria-label={pathSyncMeta.label}
            >
              <pathSyncMeta.Icon />
            </span>
          </Tooltip>
          <Tooltip content={displayPath} disabled={interactionsDisabled}>
            <div className="path">{displayPath}</div>
          </Tooltip>
        </div>
        {!interactionsDisabled && (
          <div className="sftp-actions">
            <Tooltip content={t("actions.refresh")}>
              <Button
                className="icon-button"
                variant="ghost"
                size="icon"
                onClick={() => onRefresh()}
                aria-label={t("actions.refresh")}
              >
                <FiRefreshCw />
              </Button>
            </Tooltip>
            <Tooltip content={t("sftp.back")}>
              <Button
                className="icon-button"
                variant="ghost"
                size="icon"
                onClick={() => onOpen(parentPath(currentPath))}
                aria-label={t("sftp.back")}
                disabled={isRootPath(currentPath)}
              >
                <FiCornerLeftUp />
              </Button>
            </Tooltip>
            <Tooltip content={t("actions.more")}>
              <Button
                className="icon-button"
                variant="ghost"
                size="icon"
                onClick={openActionsMenu}
                aria-label={t("actions.more")}
              >
                <FiMoreVertical />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
      <div className="sftp-list">
        {!interactionsDisabled && (
          <div className="sftp-table-header-shell">
            <div className="sftp-table-header-scroll" ref={headerScrollRef}>
              <div className="sftp-table-row sftp-table-header">
                <span className="sftp-cell sftp-cell-name">
                  {t("sftp.columns.name")}
                </span>
                <span className="sftp-cell">{t("sftp.columns.mtime")}</span>
                <span className="sftp-cell">{t("sftp.columns.type")}</span>
                <span className="sftp-cell">{t("sftp.columns.size")}</span>
                <span className="sftp-cell">{t("sftp.columns.perm")}</span>
                <span className="sftp-cell sftp-cell-owner">
                  {t("sftp.columns.owner")}
                </span>
                <span className="sftp-cell sftp-cell-group">
                  {t("sftp.columns.group")}
                </span>
              </div>
            </div>
          </div>
        )}
        <div className="sftp-list-body" ref={listBodyRef}>
          {!interactionsDisabled &&
            visibleEntries.map((entry) => {
              const iconMeta = getEntryIconMeta(entry);
              const selected = selectedEntryPath === entry.path;
              return (
                <button
                  key={entry.path}
                  type="button"
                  className={`sftp-table-row sftp-table-item ${entry.kind} ${selected ? "selected" : ""}`.trim()}
                  // 文件列表采用桌面文件管理器语义：单击只选中，双击目录才打开。
                  onClick={() => handleSelectEntry(entry)}
                  onDoubleClick={() => {
                    void handleOpenEntry(entry);
                  }}
                  onContextMenu={(event) => openMenu(event, entry)}
                >
                  <span className="sftp-cell sftp-cell-name">
                    <span
                      className={`sftp-entry-icon ${iconMeta.tone}`}
                      aria-hidden="true"
                    >
                      <iconMeta.Icon />
                    </span>
                    <span className="sftp-entry-name-text">{entry.name}</span>
                  </span>
                  <span className="sftp-cell">
                    {entry.mtime ? formatTime(entry.mtime, locale) : "-"}
                  </span>
                  <span className={`sftp-cell sftp-kind ${entry.kind}`}>
                    {entry.kind === "dir"
                      ? t("sftp.kind.dir")
                      : entry.kind === "link"
                        ? t("sftp.kind.link")
                        : t("sftp.kind.file")}
                  </span>
                  <span className="sftp-cell">
                    {entry.kind === "dir" ? "-" : formatBytes(entry.size ?? 0)}
                  </span>
                  <span className="sftp-cell">{entry.permissions ?? "-"}</span>
                  <span className="sftp-cell sftp-cell-owner">
                    {entry.owner ?? "-"}
                  </span>
                  <span className="sftp-cell sftp-cell-group">
                    {entry.group ?? "-"}
                  </span>
                </button>
              );
            })}
          {showUnavailable && (
            <div className="empty-hint">{t("sftp.emptyUnavailable")}</div>
          )}
          {showSftpDisabled && (
            <div className="empty-hint">{t("sftp.disabled")}</div>
          )}
          {isRemoteSession && sftpAvailability === "checking" && (
            <div className="empty-hint">{t("sftp.checking")}</div>
          )}
          {showSftpUnsupported && (
            <div className="empty-hint">{t("sftp.unsupported")}</div>
          )}
          {!interactionsDisabled && !visibleEntries.length && (
            <div className="empty-hint">{t("sftp.empty")}</div>
          )}
        </div>
      </div>
      {dropState !== "idle" && (
        <div className={`sftp-drop-overlay ${dropState}`}>
          <strong>{t("sftp.drop.title")}</strong>
          <span>
            {dropState === "accept"
              ? t("sftp.drop.accept")
              : t("sftp.drop.reject")}
          </span>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: t("sftp.openWithSystemEditor"),
              icon: <FiEdit2 />,
              disabled: menu.entry.kind !== "file",
              onClick: () => {
                if (menu.entry.kind !== "file") return;
                closeMenu();
                void handleOpenEntry(menu.entry);
              },
            },
            {
              label: t("actions.download"),
              icon: <FiDownload />,
              disabled: !isRemote,
              onClick: () => {
                if (!isRemote) return;
                onDownload(menu.entry);
                closeMenu();
              },
            },
            {
              label: t("actions.rename"),
              icon: <FiEdit2 />,
              disabled: !isRemote,
              onClick: () => {
                if (!isRemote) return;
                setEntryDialog({
                  mode: "rename",
                  title: t("actions.rename"),
                  label: t("prompts.rename"),
                  initialValue: menu.entry.name,
                  sourceEntry: menu.entry,
                });
                setEntryDialogError(null);
                closeMenu();
              },
            },
            {
              label: t("actions.remove"),
              icon: <FiTrash2 />,
              disabled: !isRemote,
              onClick: () => {
                if (!isRemote) return;
                closeMenu();
                openDialog({
                  title: t("actions.remove"),
                  message: t("prompts.confirmDelete", {
                    name: menu.entry.name,
                  }),
                  confirmLabel: t("actions.remove"),
                  cancelLabel: t("actions.cancel"),
                  onConfirm: () => {
                    void onRemove(menu.entry).catch(() => {});
                  },
                });
              },
            },
          ]}
          onClose={closeMenu}
        />
      )}
      {actionsMenu && (
        <ContextMenu
          x={actionsMenu.x}
          y={actionsMenu.y}
          items={actionMenuItems}
          onClose={closeActionsMenu}
        />
      )}
      {entryDialog ? (
        <InputDialog
          open
          title={entryDialog.title}
          label={entryDialog.label}
          initialValue={entryDialog.initialValue}
          confirmText={
            entryDialog.mode === "mkdir" ? t("actions.new") : t("actions.save")
          }
          cancelText={t("actions.cancel")}
          closeText={t("actions.close")}
          errorText={entryDialogError}
          onClose={closeEntryDialog}
          onValueChange={() => setEntryDialogError(null)}
          onConfirm={submitEntryDialog}
        />
      ) : null}
    </div>
  );
}
