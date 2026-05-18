/**
 * 终端控制器 Hook。
 * 职责：对外暴露分组后的终端查询与操作接口。
 */
import useTerminalRuntimeCore from "@/hooks/useTerminalRuntimeCore";

/**
 * 终端控制器入口。
 * 目前先兼容复用原 useTerminalRuntime，后续逐步拆分 xterm/gutter/search 子模块。
 */
export default function useTerminalController(
  props: Parameters<typeof useTerminalRuntimeCore>[0],
) {
  const raw = useTerminalRuntimeCore(props);

  return {
    terminalQuery: {
      isTerminalReady: raw.isTerminalReady,
      getTerminalSize: raw.getTerminalSize,
      getActiveTerminalStats: raw.getActiveTerminalStats,
      getTerminalTitle: raw.getTerminalTitle,
      getSessionBufferText: raw.getSessionBufferText,
      getActiveSearchStats: raw.getActiveSearchStats,
      getActiveLinkMenu: raw.getActiveLinkMenu,
      getActiveCommandCapture: raw.getActiveCommandCapture,
      getActiveAutocomplete: raw.getActiveAutocomplete,
      getActiveAutocompleteAnchor: raw.getActiveAutocompleteAnchor,
      hasFocusedLine: raw.hasFocusedLine,
      hasActiveSelection: raw.hasActiveSelection,
      getActiveSelectionText: raw.getActiveSelectionText,
    },
    terminalActions: {
      registerTerminalContainer: raw.registerTerminalContainer,
      focusActiveTerminal: raw.focusActiveTerminal,
      focusTerminalLineAtPoint: raw.focusTerminalLineAtPoint,
      copyActiveFocusedLine: raw.copyActiveFocusedLine,
      copyActiveSelection: raw.copyActiveSelection,
      openActiveLink: raw.openActiveLink,
      copyActiveLink: raw.copyActiveLink,
      closeActiveLinkMenu: raw.closeActiveLinkMenu,
      pasteToActiveTerminal: raw.pasteToActiveTerminal,
      clearActiveTerminal: raw.clearActiveTerminal,
      clearActiveSearchDecorations: raw.clearActiveSearchDecorations,
      searchActiveTerminalNext: raw.searchActiveTerminalNext,
      searchActiveTerminalPrev: raw.searchActiveTerminalPrev,
      applyActiveAutocompleteSuggestion: raw.applyActiveAutocompleteSuggestion,
      closeActiveAutocomplete: raw.closeActiveAutocomplete,
    },
  };
}
