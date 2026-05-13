/**
 * 会话控制器 Hook。
 * 职责：对外暴露分组后的会话状态、引用与操作接口。
 */
import useSessionStateCore from "@/hooks/useSessionStateCore";

/**
 * 会话控制器入口。
 * 目前先兼容复用原 useSessionState，后续可继续下沉内部模块。
 */
export default function useSessionController(
  props: Parameters<typeof useSessionStateCore>[0],
) {
  const raw = useSessionStateCore(props);

  return {
    sessionState: {
      sessions: raw.sessions,
      workspace: raw.workspace,
      activeSessionId: raw.activeSessionId,
      sessionStates: raw.sessionStates,
      sessionReasons: raw.sessionReasons,
      localSessionMeta: raw.localSessionMeta,
      reconnectInfoBySession: raw.reconnectInfoBySession,
      activeSession: raw.activeSession,
      activeSessionState: raw.activeSessionState,
      activeSessionReason: raw.activeSessionReason,
      activeReconnectInfo: raw.activeReconnectInfo,
      activeSessionProfile: raw.activeSessionProfile,
      isRemoteSession: raw.isRemoteSession,
      isRemoteConnected: raw.isRemoteConnected,
      canReconnect: raw.canReconnect,
      appEvents: raw.appEvents,
      busyMessage: raw.busyMessage,
    },
    sessionRefs: {
      sessionRef: raw.sessionRef,
      sessionsRef: raw.sessionsRef,
      sessionStatesRef: raw.sessionStatesRef,
      sessionReasonsRef: raw.sessionReasonsRef,
      sessionBuffersRef: raw.sessionBuffersRef,
      localSessionMetaRef: raw.localSessionMetaRef,
      localSessionIdsRef: raw.localSessionIdsRef,
      activeSessionIdRef: raw.activeSessionIdRef,
    },
    sessionActions: {
      appendAppEvent: raw.appendAppEvent,
      setBusyMessage: raw.setBusyMessage,
      isLocalSession: raw.isLocalSession,
      setLastCommand: raw.setLastCommand,
      sendSessionInput: raw.sendSessionInput,
      writeToSession: raw.writeToSession,
      resizeSession: raw.resizeSession,
      connectProfile: raw.connectProfile,
      connectLocalShell: raw.connectLocalShell,
      disconnectSession: raw.disconnectSession,
      reconnectSession: raw.reconnectSession,
      reconnectLocalShell: raw.reconnectLocalShell,
      triggerScheduledReconnectNow: raw.triggerScheduledReconnectNow,
      switchSession: raw.switchSession,
      focusPane: raw.focusPane,
      reorderPaneSessions: raw.reorderPaneSessions,
      splitActivePane: raw.splitActivePane,
      closePaneSession: raw.closePaneSession,
      resizePaneSplit: raw.resizePaneSplit,
      closeOtherSessionsInPane: raw.closeOtherSessionsInPane,
      closeSessionsToRightInPane: raw.closeSessionsToRightInPane,
      closeAllSessionsInPane: raw.closeAllSessionsInPane,
    },
  };
}
