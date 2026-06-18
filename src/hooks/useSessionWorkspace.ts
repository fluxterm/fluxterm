/**
 * 会话工作区 Hook。
 * 对 reducer 提供稳定的命令式封装，供会话状态层调用。
 * 这里不管理连接生命周期，只负责 pane/session 在工作区内的编排关系。
 */
import { useMemo, useReducer } from "react";
import type { SessionPaneId } from "@/types";
import {
  collectLeafPanes,
  collectWorkspaceSessionIds,
  createEmptyWorkspaceState,
  getSessionGroupIdFromWorkspace,
  getActiveSessionIdFromWorkspace,
  sessionWorkspaceReducer,
} from "@/features/session/core/workspaceReducer";

type SplitAxis = "horizontal" | "vertical";

function createWorkspaceId(prefix: "pane") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/**
 * 会话工作区 Hook。
 * 当前只维护一棵根 pane 树，所有“新建会话 / 拆分 / 关闭区域内会话”都围绕这棵树变换。
 */
export default function useSessionWorkspace() {
  const [workspace, dispatch] = useReducer(
    sessionWorkspaceReducer,
    undefined,
    createEmptyWorkspaceState,
  );

  const activeSessionId = useMemo(
    () => getActiveSessionIdFromWorkspace(workspace),
    [workspace],
  );

  return useMemo(
    () => ({
      workspace,
      activeSessionId,
      getActivePaneId: () => workspace.activePaneId,
      getAllSessionIds: () => collectWorkspaceSessionIds(workspace),
      getSessionGroupId: (sessionId: string) =>
        getSessionGroupIdFromWorkspace(workspace, sessionId),
      attachSession: (
        sessionId: string,
        activate = true,
        target?: { paneId?: SessionPaneId },
      ) => {
        // 首个会话必须生成新的根 pane；之后的新会话优先附着到当前活动 pane。
        dispatch({
          type: "attach-session",
          sessionId,
          activate,
          paneId: workspace.root ? target?.paneId : createWorkspaceId("pane"),
        });
      },
      activateSession: (sessionId: string) => {
        dispatch({ type: "activate-session", sessionId });
      },
      focusPane: (paneId: SessionPaneId) => {
        dispatch({ type: "focus-pane", paneId });
      },
      splitPane: (
        paneId: SessionPaneId,
        nextSessionId: string,
        axis: SplitAxis,
      ) => {
        dispatch({
          type: "split-pane",
          paneId,
          nextSessionId,
          nextPaneId: createWorkspaceId("pane"),
          axis,
        });
      },
      replaceSession: (oldSessionId: string, nextSessionId: string) => {
        dispatch({ type: "replace-session", oldSessionId, nextSessionId });
      },
      detachSession: (sessionId: string) => {
        dispatch({ type: "detach-session", sessionId });
      },
      reorderPaneSessions: (
        paneId: SessionPaneId,
        sourceSessionId: string,
        targetSessionId: string,
      ) => {
        dispatch({
          type: "reorder-pane-sessions",
          paneId,
          sourceSessionId,
          targetSessionId,
        });
      },
      resizeSplit: (paneId: SessionPaneId, ratio: number) => {
        dispatch({ type: "resize-split", paneId, ratio });
      },
      createSessionGroup: (name: string, sessionId: string) => {
        const groupId = createWorkspaceId("pane").replace(/^pane-/, "group-");
        dispatch({
          type: "create-session-group",
          groupId,
          name,
          sessionId,
        });
        return groupId;
      },
      moveSessionToGroup: (sessionId: string, groupId: string) => {
        dispatch({ type: "move-session-to-group", sessionId, groupId });
      },
      getLeafPanes: () =>
        workspace.root ? collectLeafPanes(workspace.root) : [],
    }),
    [activeSessionId, workspace],
  );
}
