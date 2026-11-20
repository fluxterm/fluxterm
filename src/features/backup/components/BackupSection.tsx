/** 本地备份、折叠 WebDAV 配置与本地配置导入。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import Button from "@/components/ui/button";
import { useNotices } from "@/hooks/useNotices";
import type { Translate } from "@/i18n";
import { AppError, translateAppError } from "@/shared/errors/appError";
import {
  canReuseWebdavPassword,
  getWebdavAddressIssue,
} from "@/features/backup/core/webdavSettings";
import {
  cancelBackup,
  clearBackupSettings,
  exportLocalBackup,
  getBackupSettings,
  inspectBackup,
  saveBackupSettings,
  stageRestore,
  testWebdav,
  uploadWebdavBackup,
  type BackupSettings,
  type Inspection,
  type WebdavInput,
} from "@/features/backup/core/commands";
import "./BackupSection.css";

type Operation =
  | "local"
  | "upload"
  | "inspect"
  | "test"
  | "settings"
  | "restore";

/** 使用设备本地时间显示紧凑的备份时间与版本。 */
function formatBackupSummary(createdAt: string, version: string): string {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${clock} v${version}`;
}

/** 操作反馈统一使用全局横幅，不在模态框中插入临时状态提示。 */
export default function BackupSection({ t }: { t: Translate }) {
  const { openDialog, pushToast } = useNotices();
  /** 备份操作结果统一自动消失，不要求用户逐条关闭。 */
  const reportError = useCallback(
    (reason: unknown) => {
      pushToast({ level: "error", message: translateAppError(reason, t) });
    },
    [pushToast, t],
  );
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [webdavExpanded, setWebdavExpanded] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const activeTask = useRef<string | null>(null);
  const cancelled = useRef(false);
  const busy = operation !== null;
  const blocked = !settings || settings.pendingRestore;
  const reusablePassword = canReuseWebdavPassword(settings, url, username);

  useEffect(() => {
    let disposed = false;
    void getBackupSettings()
      .then((value) => {
        if (disposed) return;
        setSettings(value);
        setUrl(value.url);
        setUsername(value.username);
      })
      .catch((reason: unknown) => {
        if (!disposed) reportError(reason);
      });
    return () => {
      disposed = true;
    };
  }, [reportError]);

  /** 一个交互任务对应一个后端标识，结果只通过横幅反馈。 */
  async function run(kind: Operation, action: (id: string) => Promise<void>) {
    if (activeTask.current) return;
    const id = crypto.randomUUID();
    activeTask.current = id;
    cancelled.current = false;
    setOperation(kind);
    try {
      await action(id);
    } catch (reason) {
      reportError(reason);
    } finally {
      activeTask.current = null;
      setOperation(null);
    }
  }

  /** 长任务使用原操作按钮取消，不额外插入会闪烁的提示条。 */
  function cancel() {
    cancelled.current = true;
    if (activeTask.current)
      void cancelBackup(activeTask.current).catch((reason: unknown) => {
        reportError(reason);
      });
  }

  /** 校验完整地址，并仅在账号与地址未变更时复用保存密码。 */
  function connection(): WebdavInput {
    const issue = getWebdavAddressIssue(url);
    if (issue)
      throw new AppError({
        code:
          issue === "required"
            ? "backup_webdav_url_required"
            : "backup_webdav_url_invalid",
        message:
          issue === "required"
            ? "The WebDAV server URL is required"
            : "Invalid WebDAV server URL",
        messageKey:
          issue === "required"
            ? "backup.error.webdavUrlRequired"
            : "backup.error.webdavUrlInvalid",
      });
    const reuse = !password && reusablePassword;
    return {
      url: url.trim(),
      username,
      password: password || undefined,
      useSavedPassword: reuse,
    };
  }

  /** 显式保存默认包含密码；空输入保留未变更服务的已有密码。 */
  async function saveSettings() {
    const value = await saveBackupSettings({
      url: url.trim(),
      username,
      password: password || undefined,
      forgetPassword: !reusablePassword,
    });
    setSettings(value);
    setUrl(value.url);
    setPassword("");
    pushToast({ level: "success", message: t("backup.settingsSaved") });
  }

  /** 清空配置及输入框，不保留隐藏的认证信息。 */
  async function clearSettings() {
    const value = await clearBackupSettings();
    setSettings(value);
    setUrl("");
    setUsername("");
    setPassword("");
    pushToast({ level: "success", message: t("backup.settingsCleared") });
  }

  /** 确认覆盖后暂存并重启；失败保留可重试的重启入口。 */
  function confirmRestore() {
    if (!inspection) return;
    const selected = inspection;
    openDialog({
      title: t("backup.import"),
      message: t("backup.restoreConfirm"),
      confirmLabel: t("backup.restoreRestart"),
      cancelLabel: t("actions.cancel"),
      onConfirm: () => {
        void run("restore", async (id) => {
          await stageRestore(id, selected.token);
          setSettings((current) =>
            current ? { ...current, pendingRestore: true } : current,
          );
          setInspection(null);
          pushToast({ level: "success", message: t("backup.pending") });
          await relaunch();
        });
      },
    });
  }

  return (
    <div
      className="config-modal-widget config-modal-widget-scrollable backup-section"
      data-page="backup"
      data-ui="backup-settings"
    >
      <h3>{t("config.section.backup")}</h3>
      {settings?.pendingRestore && (
        <Button
          data-ui="backup-restart"
          disabled={busy}
          onClick={() =>
            void run("restore", async () => {
              await relaunch();
            })
          }
        >
          {t("backup.restart")}
        </Button>
      )}
      <section
        className="config-toggle-card backup-card"
        data-slot="local-backup"
      >
        <h4>{t("backup.local")}</h4>
        <Button
          data-ui="backup-export-local"
          disabled={blocked || busy}
          onClick={() => {
            void run("local", async (id) => {
              const path = await save({
                defaultPath: `fluxterm-backup-${new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "")}.zip`,
                filters: [{ name: "ZIP", extensions: ["zip"] }],
              });
              if (!path || cancelled.current) return;
              await exportLocalBackup(id, path);
              pushToast({
                level: "success",
                message: t("backup.localSuccess"),
              });
            });
          }}
        >
          {t("backup.export")}
        </Button>
      </section>
      <section
        className="config-toggle-card backup-card"
        data-slot="webdav-backup"
      >
        <h4>{t("backup.webdav")}</h4>
        <div className="backup-webdav-toolbar">
          <Button
            variant="ghost"
            className="backup-config-toggle"
            data-ui="backup-toggle-webdav-config"
            aria-expanded={webdavExpanded}
            onClick={() => setWebdavExpanded((expanded) => !expanded)}
          >
            {t("backup.webdavConfig")}
          </Button>
          <Button
            data-ui="backup-upload-webdav"
            disabled={
              blocked || !url.trim() || (busy && operation !== "upload")
            }
            onClick={() => {
              if (operation === "upload") {
                cancel();
                return;
              }
              void run("upload", async (id) => {
                await uploadWebdavBackup(id, connection());
                pushToast({
                  level: "success",
                  message: t("backup.uploadSuccess"),
                });
              });
            }}
          >
            {operation === "upload" ? t("backup.cancel") : t("backup.upload")}
          </Button>
        </div>
        {webdavExpanded && (
          <div className="backup-webdav-config" data-slot="webdav-config">
            <fieldset disabled={busy || blocked}>
              <label>
                {t("backup.url")}
                <input
                  data-ui="backup-webdav-url"
                  type="url"
                  placeholder="http(s)://example.com/dav/"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <label>
                {t("backup.username")}
                <input
                  data-ui="backup-webdav-username"
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
              <label>
                {t("backup.password")}
                <input
                  data-ui="backup-webdav-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    reusablePassword ? t("backup.passwordSaved") : ""
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </fieldset>
            <div className="backup-actions">
              <Button
                data-ui="backup-save-settings"
                disabled={busy || blocked || !url.trim()}
                onClick={() => void run("settings", saveSettings)}
              >
                {t("backup.saveSettings")}
              </Button>
              <Button
                data-ui="backup-clear-settings"
                disabled={busy || blocked}
                variant="ghost"
                onClick={() => void run("settings", clearSettings)}
              >
                {t("backup.clearSettings")}
              </Button>
              <Button
                data-ui="backup-test-webdav"
                disabled={blocked || (busy && operation !== "test")}
                onClick={() => {
                  if (operation === "test") {
                    cancel();
                    return;
                  }
                  void run("test", async (id) => {
                    await testWebdav(id, connection());
                    pushToast({
                      level: "success",
                      message: t("backup.testSuccess"),
                    });
                  });
                }}
              >
                {operation === "test" ? t("backup.cancel") : t("backup.test")}
              </Button>
            </div>
          </div>
        )}
      </section>
      <section
        className="config-toggle-card backup-card"
        data-slot="import-backup"
      >
        <h4>{t("backup.import")}</h4>
        <Button
          data-ui="backup-select-archive"
          disabled={blocked || busy}
          onClick={() => {
            void run("inspect", async (id) => {
              const path = await open({
                multiple: false,
                directory: false,
                filters: [{ name: "ZIP", extensions: ["zip"] }],
              });
              if (!path || Array.isArray(path) || cancelled.current) return;
              setInspection(null);
              setInspection(await inspectBackup(id, path));
              pushToast({ level: "success", message: t("backup.checked") });
            });
          }}
        >
          {t("backup.select")}
        </Button>
        {inspection && (
          <div data-slot="backup-preview">
            <p className="backup-summary" data-slot="backup-summary">
              {formatBackupSummary(
                inspection.manifest.createdAt,
                inspection.manifest.appVersion,
              )}
            </p>
            <Button
              variant="danger"
              disabled={busy || blocked}
              data-ui="backup-confirm-restore"
              onClick={confirmRestore}
            >
              {t("backup.restoreRestart")}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
