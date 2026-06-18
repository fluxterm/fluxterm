/**
 * 会话工作区 reducer。
 * 这里维护“单根 pane 树”这一份工作区真相：
 * - leaf 节点承载区域内会话列表
 * - split 节点承载分割方向和比例
 * - activePaneId 负责把全局活动会话锚定到具体区域
 */
import type {
  SessionGroup,
  SessionGroupId,
  SessionPaneId,
  SessionPaneNode,
  SessionWorkspaceState,
} from "@/types";
import { DEFAULT_SESSION_GROUP_ID } from "@/constants/sessionGroups";

const sessionGroupPalette = [
  "#38bdf8",
  "#22c55e",
  "#f59e0b",
  "#a78bfa",
  "#f472b6",
  "#2dd4bf",
  "#fb7185",
  "#84cc16",
];

type SplitAxis = "horizontal" | "vertical";

export type SessionWorkspaceAction =
  | {
      type: "attach-session";
      sessionId: string;
      paneId?: SessionPaneId;
      activate?: boolean;
      createdAt?: number;
    }
  | {
      type: "activate-session";
      sessionId: string;
    }
  | {
      type: "focus-pane";
      paneId: SessionPaneId;
    }
  | {
      type: "split-pane";
      paneId: SessionPaneId;
      nextPaneId: SessionPaneId;
      nextSessionId: string;
      axis: SplitAxis;
    }
  | {
      type: "replace-session";
      oldSessionId: string;
      nextSessionId: string;
    }
  | {
      type: "detach-session";
      sessionId: string;
    }
  | {
      type: "reorder-pane-sessions";
      paneId: SessionPaneId;
      sourceSessionId: string;
      targetSessionId: string;
    }
  | {
      type: "resize-split";
      paneId: SessionPaneId;
      ratio: number;
    }
  | {
      type: "create-session-group";
      groupId: SessionGroupId;
      name: string;
      sessionId: string;
    }
  | {
      type: "move-session-to-group";
      sessionId: string;
      groupId: SessionGroupId;
    };

export function createEmptyWorkspaceState(): SessionWorkspaceState {
  return {
    root: null,
    activePaneId: null,
    groups: [createDefaultSessionGroup()],
  };
}

/** 单根工作区的最小可用形态：一个 pane 承载一个活动会话。 */
export function createSinglePaneRoot(
  sessionId: string,
  paneId: SessionPaneId,
): SessionPaneNode {
  return {
    kind: "leaf",
    paneId,
    sessionIds: [sessionId],
    activeSessionId: sessionId,
  };
}

export function collectWorkspaceSessionIds(state: SessionWorkspaceState) {
  return state.root ? collectNodeSessionIds(state.root) : [];
}

export function getActiveSessionIdFromWorkspace(
  state: SessionWorkspaceState,
): string | null {
  if (!state.root || !state.activePaneId) return null;
  const leaf = findLeafByPaneId(state.root, state.activePaneId);
  return (
    leaf?.activeSessionId ??
    leaf?.sessionIds[leaf.sessionIds.length - 1] ??
    null
  );
}

export function containsSessionId(
  node: SessionPaneNode,
  sessionId: string,
): boolean {
  if (node.kind === "leaf") return node.sessionIds.includes(sessionId);
  return (
    containsSessionId(node.first, sessionId) ||
    containsSessionId(node.second, sessionId)
  );
}

export function containsPaneId(
  node: SessionPaneNode,
  paneId: SessionPaneId,
): boolean {
  if (node.kind === "leaf") return node.paneId === paneId;
  return (
    containsPaneId(node.first, paneId) || containsPaneId(node.second, paneId)
  );
}

export function findLeafByPaneId(
  node: SessionPaneNode,
  paneId: SessionPaneId,
): Extract<SessionPaneNode, { kind: "leaf" }> | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return (
    findLeafByPaneId(node.first, paneId) ??
    findLeafByPaneId(node.second, paneId)
  );
}

export function findLeafBySessionId(
  node: SessionPaneNode,
  sessionId: string,
): Extract<SessionPaneNode, { kind: "leaf" }> | null {
  if (node.kind === "leaf")
    return node.sessionIds.includes(sessionId) ? node : null;
  return (
    findLeafBySessionId(node.first, sessionId) ??
    findLeafBySessionId(node.second, sessionId)
  );
}

export function collectLeafPanes(
  node: SessionPaneNode,
): Array<Extract<SessionPaneNode, { kind: "leaf" }>> {
  if (node.kind === "leaf") return [node];
  return [...collectLeafPanes(node.first), ...collectLeafPanes(node.second)];
}

/** 获取指定会话所在分组。 */
export function getSessionGroupIdFromWorkspace(
  state: SessionWorkspaceState,
  sessionId: string,
) {
  return (
    state.groups.find((group) => group.sessionIds.includes(sessionId))?.id ??
    DEFAULT_SESSION_GROUP_ID
  );
}

export function sessionWorkspaceReducer(
  state: SessionWorkspaceState,
  action: SessionWorkspaceAction,
): SessionWorkspaceState {
  switch (action.type) {
    case "attach-session": {
      // 当前产品语义只有一棵根工作区树。
      // 首次附着创建根 pane；之后的新会话则附着到目标 pane 或当前活动 pane。
      if (!state.root) {
        if (!action.paneId) return state;
        return {
          root: createSinglePaneRoot(action.sessionId, action.paneId),
          activePaneId: action.paneId,
          groups: appendSessionToDefaultGroup(state.groups, action.sessionId),
        };
      }
      const targetPaneId = action.paneId ?? state.activePaneId;
      if (!targetPaneId) return state;
      return {
        root: appendSessionToPane(state.root, targetPaneId, action.sessionId),
        activePaneId: targetPaneId,
        groups: appendSessionToDefaultGroup(state.groups, action.sessionId),
      };
    }
    case "activate-session": {
      if (!state.root) return state;
      const leaf = findLeafBySessionId(state.root, action.sessionId);
      if (!leaf) return state;
      return {
        root: setPaneActiveSession(state.root, leaf.paneId, action.sessionId),
        activePaneId: leaf.paneId,
        groups: state.groups,
      };
    }
    case "focus-pane": {
      if (!state.root || !containsPaneId(state.root, action.paneId))
        return state;
      const leaf = findLeafByPaneId(state.root, action.paneId);
      const nextActiveSessionId =
        leaf?.activeSessionId ??
        leaf?.sessionIds[leaf.sessionIds.length - 1] ??
        null;
      return {
        root: nextActiveSessionId
          ? setPaneActiveSession(state.root, action.paneId, nextActiveSessionId)
          : state.root,
        activePaneId: action.paneId,
        groups: state.groups,
      };
    }
    case "split-pane": {
      if (!state.root) return state;
      return {
        root: replacePaneWithSplit(state.root, {
          paneId: action.paneId,
          nextPaneId: action.nextPaneId,
          nextSessionId: action.nextSessionId,
          axis: action.axis,
        }),
        activePaneId: action.nextPaneId,
        groups: appendSessionToDefaultGroup(state.groups, action.nextSessionId),
      };
    }
    case "replace-session": {
      if (!state.root) return state;
      return {
        ...state,
        root: replaceSessionId(
          state.root,
          action.oldSessionId,
          action.nextSessionId,
        ),
        groups: replaceSessionIdInGroups(
          state.groups,
          action.oldSessionId,
          action.nextSessionId,
        ),
      };
    }
    case "detach-session": {
      if (!state.root) return state;
      const nextRoot = removeSessionFromNode(state.root, action.sessionId);
      const nextGroups = removeSessionFromGroups(
        state.groups,
        action.sessionId,
      );
      if (!nextRoot)
        return { ...createEmptyWorkspaceState(), groups: nextGroups };
      // pane 可能因最后一个会话被关闭而被折叠，这里需要重新选出仍然存在的活动 pane。
      const activeLeaf =
        (state.activePaneId
          ? findLeafByPaneId(nextRoot, state.activePaneId)
          : null) ?? collectLeafPanes(nextRoot)[0];
      return {
        root: nextRoot,
        activePaneId: activeLeaf?.paneId ?? null,
        groups: nextGroups,
      };
    }
    case "reorder-pane-sessions": {
      if (!state.root) return state;
      return {
        ...state,
        root: reorderPaneSessions(state.root, action),
      };
    }
    case "resize-split": {
      if (!state.root) return state;
      return {
        ...state,
        root: updateSplitRatio(state.root, action.paneId, action.ratio),
      };
    }
    case "create-session-group": {
      const trimmed = action.name.trim();
      if (
        !trimmed ||
        !containsSessionIdInGroups(state.groups, action.sessionId)
      ) {
        return state;
      }
      if (
        state.groups.some(
          (group) =>
            group.name.trim().toLocaleLowerCase() ===
            trimmed.toLocaleLowerCase(),
        )
      ) {
        return state;
      }
      return {
        ...state,
        groups: cleanupSessionGroups([
          ...removeSessionFromAllGroups(state.groups, action.sessionId),
          {
            id: action.groupId,
            name: trimmed,
            sessionIds: [action.sessionId],
            color: resolveSessionGroupColor(action.groupId),
          },
        ]),
      };
    }
    case "move-session-to-group": {
      if (!containsSessionIdInGroups(state.groups, action.sessionId)) {
        return state;
      }
      if (!state.groups.some((group) => group.id === action.groupId)) {
        return state;
      }
      return {
        ...state,
        groups: moveSessionToGroup(
          state.groups,
          action.sessionId,
          action.groupId,
        ),
      };
    }
    default:
      return state;
  }
}

function createDefaultSessionGroup(): SessionGroup {
  return {
    id: DEFAULT_SESSION_GROUP_ID,
    name: "Default",
    sessionIds: [],
    builtIn: true,
  };
}

function resolveSessionGroupColor(groupId: string) {
  let hash = 0;
  for (let index = 0; index < groupId.length; index += 1) {
    hash = (hash * 31 + groupId.charCodeAt(index)) >>> 0;
  }
  return sessionGroupPalette[hash % sessionGroupPalette.length];
}

function collectNodeSessionIds(node: SessionPaneNode): string[] {
  if (node.kind === "leaf") return node.sessionIds.slice();
  return [
    ...collectNodeSessionIds(node.first),
    ...collectNodeSessionIds(node.second),
  ];
}

function ensureDefaultSessionGroup(groups: SessionGroup[]) {
  if (groups.some((group) => group.id === DEFAULT_SESSION_GROUP_ID)) {
    return groups;
  }
  return [createDefaultSessionGroup(), ...groups];
}

function cleanupSessionGroups(groups: SessionGroup[]) {
  return ensureDefaultSessionGroup(groups).filter(
    (group) => group.id === DEFAULT_SESSION_GROUP_ID || group.sessionIds.length,
  );
}

function removeSessionFromAllGroups(groups: SessionGroup[], sessionId: string) {
  return ensureDefaultSessionGroup(groups).map((group) => ({
    ...group,
    sessionIds: group.sessionIds.filter((item) => item !== sessionId),
  }));
}

function appendSessionToDefaultGroup(
  groups: SessionGroup[],
  sessionId: string,
) {
  const cleaned = removeSessionFromAllGroups(groups, sessionId);
  return cleanupSessionGroups(
    cleaned.map((group) =>
      group.id === DEFAULT_SESSION_GROUP_ID
        ? { ...group, sessionIds: group.sessionIds.concat(sessionId) }
        : group,
    ),
  );
}

function removeSessionFromGroups(groups: SessionGroup[], sessionId: string) {
  return cleanupSessionGroups(removeSessionFromAllGroups(groups, sessionId));
}

function replaceSessionIdInGroups(
  groups: SessionGroup[],
  oldSessionId: string,
  nextSessionId: string,
) {
  return cleanupSessionGroups(
    ensureDefaultSessionGroup(groups).map((group) => ({
      ...group,
      sessionIds: group.sessionIds.map((item) =>
        item === oldSessionId ? nextSessionId : item,
      ),
    })),
  );
}

function containsSessionIdInGroups(groups: SessionGroup[], sessionId: string) {
  return groups.some((group) => group.sessionIds.includes(sessionId));
}

function moveSessionToGroup(
  groups: SessionGroup[],
  sessionId: string,
  groupId: SessionGroupId,
) {
  const removed = removeSessionFromAllGroups(groups, sessionId);
  return cleanupSessionGroups(
    removed.map((group) =>
      group.id === groupId
        ? { ...group, sessionIds: group.sessionIds.concat(sessionId) }
        : group,
    ),
  );
}

function appendSessionToPane(
  node: SessionPaneNode,
  paneId: SessionPaneId,
  sessionId: string,
): SessionPaneNode {
  if (node.kind === "leaf") {
    if (node.paneId !== paneId) return node;
    return {
      ...node,
      sessionIds: node.sessionIds.concat(sessionId),
      activeSessionId: sessionId,
    };
  }
  const nextFirst = appendSessionToPane(node.first, paneId, sessionId);
  const nextSecond = appendSessionToPane(node.second, paneId, sessionId);
  if (nextFirst === node.first && nextSecond === node.second) return node;
  return { ...node, first: nextFirst, second: nextSecond };
}

function setPaneActiveSession(
  node: SessionPaneNode,
  paneId: SessionPaneId,
  sessionId: string,
): SessionPaneNode {
  if (node.kind === "leaf") {
    if (node.paneId !== paneId || !node.sessionIds.includes(sessionId))
      return node;
    return { ...node, activeSessionId: sessionId };
  }
  const nextFirst = setPaneActiveSession(node.first, paneId, sessionId);
  const nextSecond = setPaneActiveSession(node.second, paneId, sessionId);
  if (nextFirst === node.first && nextSecond === node.second) return node;
  return { ...node, first: nextFirst, second: nextSecond };
}

function replacePaneWithSplit(
  node: SessionPaneNode,
  payload: {
    paneId: SessionPaneId;
    nextPaneId: SessionPaneId;
    nextSessionId: string;
    axis: SplitAxis;
  },
): SessionPaneNode {
  if (node.kind === "leaf") {
    if (node.paneId !== payload.paneId) return node;
    return {
      kind: "split",
      axis: payload.axis,
      ratio: 0.5,
      first: node,
      second: createSinglePaneRoot(payload.nextSessionId, payload.nextPaneId),
    };
  }
  const nextFirst = replacePaneWithSplit(node.first, payload);
  const nextSecond = replacePaneWithSplit(node.second, payload);
  if (nextFirst === node.first && nextSecond === node.second) return node;
  return { ...node, first: nextFirst, second: nextSecond };
}

function replaceSessionId(
  node: SessionPaneNode,
  oldSessionId: string,
  nextSessionId: string,
): SessionPaneNode {
  if (node.kind === "leaf") {
    if (!node.sessionIds.includes(oldSessionId)) return node;
    return {
      ...node,
      sessionIds: node.sessionIds.map((item) =>
        item === oldSessionId ? nextSessionId : item,
      ),
      activeSessionId:
        node.activeSessionId === oldSessionId
          ? nextSessionId
          : node.activeSessionId,
    };
  }
  const nextFirst = replaceSessionId(node.first, oldSessionId, nextSessionId);
  const nextSecond = replaceSessionId(node.second, oldSessionId, nextSessionId);
  if (nextFirst === node.first && nextSecond === node.second) return node;
  return { ...node, first: nextFirst, second: nextSecond };
}

function removeSessionFromNode(
  node: SessionPaneNode,
  sessionId: string,
): SessionPaneNode | null {
  if (node.kind === "leaf") {
    if (!node.sessionIds.includes(sessionId)) return node;
    const sessionIds = node.sessionIds.filter((item) => item !== sessionId);
    if (!sessionIds.length) return null;
    const activeSessionId = sessionIds.includes(node.activeSessionId ?? "")
      ? node.activeSessionId
      : sessionIds[sessionIds.length - 1];
    return { ...node, sessionIds, activeSessionId };
  }
  const nextFirst = removeSessionFromNode(node.first, sessionId);
  const nextSecond = removeSessionFromNode(node.second, sessionId);
  // split 只要有一侧被删空，就把剩余子树提升上来，避免保留空区域节点。
  if (!nextFirst && !nextSecond) return null;
  if (!nextFirst) return nextSecond;
  if (!nextSecond) return nextFirst;
  if (nextFirst === node.first && nextSecond === node.second) return node;
  return { ...node, first: nextFirst, second: nextSecond };
}

function reorderPaneSessions(
  node: SessionPaneNode,
  payload: Extract<SessionWorkspaceAction, { type: "reorder-pane-sessions" }>,
): SessionPaneNode {
  if (node.kind === "leaf") {
    if (node.paneId !== payload.paneId) return node;
    const sourceIndex = node.sessionIds.indexOf(payload.sourceSessionId);
    const targetIndex = node.sessionIds.indexOf(payload.targetSessionId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      return node;
    }
    const sessionIds = node.sessionIds.slice();
    const [moved] = sessionIds.splice(sourceIndex, 1);
    sessionIds.splice(targetIndex, 0, moved);
    return { ...node, sessionIds };
  }
  const nextFirst = reorderPaneSessions(node.first, payload);
  const nextSecond = reorderPaneSessions(node.second, payload);
  if (nextFirst === node.first && nextSecond === node.second) return node;
  return { ...node, first: nextFirst, second: nextSecond };
}

function updateSplitRatio(
  node: SessionPaneNode,
  paneId: SessionPaneId,
  ratio: number,
): SessionPaneNode {
  return updateSplitRatioInternal(node, paneId, ratio).node;
}

function updateSplitRatioInternal(
  node: SessionPaneNode,
  paneId: SessionPaneId,
  ratio: number,
): { node: SessionPaneNode; matched: boolean } {
  if (node.kind === "leaf") return { node, matched: node.paneId === paneId };
  const nextFirst = updateSplitRatioInternal(node.first, paneId, ratio);
  if (nextFirst.matched) {
    const nextNode = containsPaneId(node.first, paneId)
      ? { ...node, ratio: clampRatio(ratio), first: nextFirst.node }
      : { ...node, first: nextFirst.node };
    return { node: nextNode, matched: true };
  }
  const nextSecond = updateSplitRatioInternal(node.second, paneId, ratio);
  if (nextSecond.matched) {
    const nextNode = containsPaneId(node.second, paneId)
      ? { ...node, ratio: clampRatio(ratio), second: nextSecond.node }
      : { ...node, second: nextSecond.node };
    return { node: nextNode, matched: true };
  }
  return { node, matched: false };
}

function clampRatio(value: number) {
  return Math.min(0.8, Math.max(0.2, value));
}
