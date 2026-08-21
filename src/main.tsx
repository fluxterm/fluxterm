import React from "react";
import ReactDOM from "react-dom/client";
import { attachConsole } from "@tauri-apps/plugin-log";
import App from "@/App";
import { NoticesProvider } from "@/components/providers/NoticesProvider";

if (import.meta.env.DEV) {
  void attachConsole();
}

/**
 * 子应用与悬浮窗口需要在 React 挂载前就打上 pending 标记，
 * 避免启动时先提交主窗口默认底色导致闪屏。
 * 这里放在运行时入口而不是 index.html，
 * 以便根据当前窗口的运行时标识决定是否应用该状态。
 */
const detachedWindowHash = window.location.hash || "";
if (/(?:widget|subapp)=/i.test(detachedWindowHash)) {
  document.documentElement.dataset.windowSurface = "detached";
  document.documentElement.dataset.windowAppearance = "pending";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NoticesProvider>
      <App />
    </NoticesProvider>
  </React.StrictMode>,
);
