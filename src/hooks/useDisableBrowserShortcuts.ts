import { useEffect } from "react";

/**
 * 浏览器快捷键禁用 Hook。
 * 职责：拦截并禁用浏览器常用的原生快捷键（如 F5 刷新、F12 开发者工具、Ctrl+W 关闭窗口等），
 * 确保应用作为桌面终端的交互完整性，防止用户误触导致会话中断或本地页面刷新。
 *
 * 与终端容器的分工：
 * 1. 本 Hook 负责窗口级/浏览器级默认行为屏蔽，但仅在焦点不在终端输入容器时生效。
 * 2. 一旦焦点进入 xterm 宿主，应放行所有按键。
 * 3. 终端组件层会接管这些按键，通过 preventDefault() 阻止本地浏览器行为，并将其透传给远端。
 * 4. 确保如 Ctrl+R、Ctrl+W、F5 等强力组合键在远程系统中能正常工作，而不触发本地刷新。
 */
type Options = {
  enabled?: boolean;
};

/**
 * 判断事件链路或当前活动元素是否位于终端宿主内。
 * 同时检查 composedPath 和 activeElement，减少 focus target 波动导致的误判。
 */
function isInputFocused(event: KeyboardEvent) {
  const selector = ".terminal-container, .terminal-xterm-host, .xterm";
  const path = event.composedPath();

  if (
    path.some(
      (item) => item instanceof HTMLElement && Boolean(item.closest(selector)),
    )
  ) {
    return true;
  }

  const target = event.target;
  if (target instanceof HTMLElement && target.closest(selector)) {
    return true;
  }

  const activeElement = document.activeElement;
  return Boolean(
    activeElement instanceof HTMLElement && activeElement.closest(selector),
  );
}

const isBlockedShortcut = (event: KeyboardEvent) => {
  const key = event.key.toLowerCase();
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const inputFocused = isInputFocused(event);

  // 终端聚焦时由组件层统一处理快捷键路由，这里不再重复抢键。
  if (inputFocused) {
    return false;
  }

  if (key === "f3" || key === "f7" || key === "f1") return true;

  if (key === "f5") return true;

  if (key === "f12") return true;

  if (ctrlOrMeta) {
    if (
      key === "r" ||
      key === "f" ||
      key === "u" ||
      key === "l" ||
      key === "g" ||
      key === "w" ||
      key === "n" ||
      key === "t" ||
      key === "p" ||
      key === "s" ||
      key === "o" ||
      key === "0" ||
      key === "=" ||
      key === "+" ||
      key === "-" ||
      key === "tab" ||
      key === "pageup" ||
      key === "pagedown"
    ) {
      return true;
    }
    if (event.shiftKey && ["r", "i", "j", "c", "k"].includes(key)) return true;
    if (event.shiftKey && key === "delete") return true;
  }

  if (event.altKey && (key === "arrowleft" || key === "arrowright")) {
    return true;
  }

  return false;
};

export const useDisableBrowserShortcuts = ({
  enabled = true,
}: Options = {}) => {
  useEffect(() => {
    if (!enabled) return;

    /**
     * 拦截键盘按下事件。
     * 注意：终端聚焦时应尽量直接透传，避免与 terminalHostShortcuts 重复抢键。
     */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isBlockedShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [enabled]);
};
