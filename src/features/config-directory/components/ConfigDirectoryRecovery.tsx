/** 配置目录失效时的启动恢复界面。 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import Button from "@/components/ui/button";
import {
  resetConfigDirectory,
  selectConfigDirectoryParent,
  type ConfigDirectoryStatus,
} from "@/features/config-directory/core/commands";
import {
  getTranslationMessage,
  type Locale,
  type TranslationKey,
} from "@/i18n";
import { extractErrorMessage } from "@/shared/errors/appError";
import "@/App.css";
import "./ConfigDirectoryRecovery.css";

type ConfigDirectoryRecoveryProps = {
  status: ConfigDirectoryStatus;
};

/** 按“应用语言 → 系统语言 → 英文”解析恢复页语言。 */
function resolveRecoveryLocale(savedLocale: Locale | null): Locale {
  if (savedLocale === "zh-CN" || savedLocale === "en-US") {
    return savedLocale;
  }
  const systemLocales =
    navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  for (const systemLocale of systemLocales) {
    const normalizedLocale = systemLocale.toLowerCase();
    if (normalizedLocale.startsWith("zh")) return "zh-CN";
    if (normalizedLocale.startsWith("en")) return "en-US";
  }
  return "en-US";
}

/** 阻止配置写入并引导用户修复启动目录。 */
export default function ConfigDirectoryRecovery({
  status,
}: ConfigDirectoryRecoveryProps) {
  const locale = resolveRecoveryLocale(status.locale);
  const t = (key: TranslationKey) => getTranslationMessage(locale, key);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const current = getCurrentWindow();
    void current
      .show()
      .then(() => current.setFocus().catch(() => {}))
      .catch(() => {});
  }, []);

  async function chooseDirectory() {
    setActionError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) return;
      setBusy(true);
      await selectConfigDirectoryParent(selected);
      await relaunch();
    } catch (error) {
      setActionError(extractErrorMessage(error));
      setBusy(false);
    }
  }

  async function restoreDefault() {
    setActionError(null);
    setBusy(true);
    try {
      await resetConfigDirectory();
      await relaunch();
    } catch (error) {
      setActionError(extractErrorMessage(error));
      setBusy(false);
    }
  }

  return (
    <main className="config-recovery" data-page="config-directory-recovery">
      <header className="config-recovery-titlebar" data-tauri-drag-region>
        <span data-tauri-drag-region>FluxTerm</span>
        <button
          type="button"
          className="config-recovery-close"
          aria-label={t("config.recovery.close")}
          onClick={() => void getCurrentWindow().close()}
        >
          ×
        </button>
      </header>
      <section
        className="config-recovery-card"
        data-ui="config-directory-recovery-card"
        aria-busy={busy}
      >
        <div className="config-recovery-heading">
          <div className="config-recovery-mark" aria-hidden="true">
            !
          </div>
          <h1 ref={titleRef} tabIndex={-1}>
            {t("config.recovery.title")}
          </h1>
        </div>
        <dl className="config-recovery-details">
          <div>
            <dt>{t("config.recovery.path")}</dt>
            <dd>{status.activeDir || "—"}</dd>
          </div>
          <div>
            <dt>{t("config.recovery.reason")}</dt>
            <dd>{status.error || t("config.recovery.unknownError")}</dd>
          </div>
        </dl>
        {status.envOverride ? (
          <p className="config-recovery-env" role="status">
            {t("config.recovery.environmentLocked")}
          </p>
        ) : null}
        {actionError ? (
          <p className="config-recovery-error" role="alert">
            {actionError}
          </p>
        ) : null}
        <div className="config-recovery-actions">
          <Button
            disabled={busy || status.envOverride}
            onClick={() => void chooseDirectory()}
          >
            {t("config.recovery.chooseParent")}
          </Button>
          <Button
            variant="ghost"
            disabled={busy || status.envOverride}
            onClick={() => void restoreDefault()}
          >
            {t("config.recovery.restoreDefault")}
          </Button>
        </div>
      </section>
    </main>
  );
}
