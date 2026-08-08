import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/button";
import type { Translate } from "@/i18n";
import { extractErrorMessage } from "@/shared/errors/appError";
import "./LockScreen.css";

type LockScreenProps = {
  pending?: boolean;
  mainWindow: boolean;
  onUnlock?: (password: string) => Promise<void>;
  t: Translate;
};

/** 标题栏以下的应用锁屏层。 */
export default function LockScreen({
  pending = false,
  mainWindow,
  onUnlock,
  t,
}: LockScreenProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.body.dataset.lockScreen = "true";
    inputRef.current?.focus();
    const blockOutside = (event: Event) => {
      const target = event.target;
      if (rootRef.current?.contains(target as Node)) return;
      if (target instanceof Element && target.closest(".titlebar")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("keydown", blockOutside, true);
    document.addEventListener("pointerdown", blockOutside, true);
    document.addEventListener("click", blockOutside, true);
    return () => {
      delete document.body.dataset.lockScreen;
      document.removeEventListener("keydown", blockOutside, true);
      document.removeEventListener("pointerdown", blockOutside, true);
      document.removeEventListener("click", blockOutside, true);
    };
  }, []);

  async function submitUnlock() {
    if (!onUnlock || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(password);
      setPassword("");
    } catch (unlockError) {
      setError(extractErrorMessage(unlockError));
      inputRef.current?.focus();
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className="lock-screen"
      data-page="lock-screen"
      data-ui={pending ? "lock-screen-pending" : "lock-screen"}
      role="dialog"
      aria-modal="true"
      aria-busy={pending || busy}
    >
      {!pending ? (
        <section className="lock-screen-card">
          <img className="lock-screen-logo" src="/icon.ico" alt="" />
          <h1>{t("lockScreen.title")}</h1>
          {mainWindow ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitUnlock();
              }}
            >
              <input
                ref={inputRef}
                type="password"
                autoComplete="off"
                value={password}
                aria-label={t("lockScreen.password")}
                placeholder={t("lockScreen.password")}
                onChange={(event) => setPassword(event.target.value)}
              />
              {error ? (
                <p role="alert">{t("lockScreen.invalidPassword")}</p>
              ) : null}
              <Button type="submit" disabled={busy}>
                {t("lockScreen.unlock")}
              </Button>
            </form>
          ) : (
            <p className="lock-screen-secondary-message">
              {t("lockScreen.unlockInMain")}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
