/**
 * 终端 pane 树渲染层。
 * 职责：
 * 1. 递归渲染 split/leaf 结构。
 * 2. 为每个区域输出工作区栏和会话容器。
 * 3. 处理区域内会话拖拽排序与 split resize 交互。
 */
import { useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import type { MouseEvent } from "react";
import { FiBell, FiX } from "react-icons/fi";
import type { DisconnectReason, SessionPaneNode } from "@/types";

type TerminalPaneTreeProps = {
  root: SessionPaneNode;
  activePaneId: string | null;
  getTerminalContainerRef: (
    sessionId: string,
  ) => (element: HTMLDivElement | null) => void;
  isTerminalReady: (sessionId: string) => boolean;
  getSessionLabel: (sessionId: string) => string;
  getSessionState: (sessionId: string) => string;
  getSessionReason: (sessionId: string) => DisconnectReason | null;
  bellPendingBySession: Record<string, boolean>;
  getSessionBanner: (sessionId: string) => string | null;
  onFocusPane: (paneId: string) => void;
  onSwitchSession: (sessionId: string) => void;
  onReorderPaneSessions: (
    paneId: string,
    sourceSessionId: string,
    targetSessionId: string,
  ) => void;
  onOpenSessionMenu: (payload: {
    x: number;
    y: number;
    paneId: string;
    sessionId: string;
  }) => void;
  onClosePaneSession: (paneId: string, sessionId: string) => void;
  onResizePaneSplit: (paneId: string, ratio: number) => void;
  onPaneMouseDown: (
    sessionId: string,
    event: MouseEvent<HTMLDivElement>,
  ) => void;
  onPaneContextMenu: (
    sessionId: string,
    event: MouseEvent<HTMLDivElement>,
  ) => void;
  autocomplete: {
    sessionId: string;
    items: Array<{ command: string; useCount: number }>;
    selectedIndex: number;
  } | null;
  autocompleteAnchor: {
    offset: number;
    maxHeight: number;
    placement: "top" | "bottom";
    left: number;
  } | null;
  onApplyAutocompleteSuggestion: (command?: string) => void;
};

/** 会话 pane 树。 */
export default function TerminalPaneTree(props: TerminalPaneTreeProps) {
  const hasSplitPanes = props.root.kind === "split";
  return (
    <div className="terminal-pane-tree">
      <div className="terminal-split terminal-split-single">
        <div className="terminal-split-slot">
          <PaneNodeView
            {...props}
            node={props.root}
            hasSplitPanes={hasSplitPanes}
          />
        </div>
      </div>
    </div>
  );
}

type PaneNodeViewProps = Omit<TerminalPaneTreeProps, "root"> & {
  node: SessionPaneNode;
  hasSplitPanes: boolean;
};

function PaneNodeView({
  node,
  activePaneId,
  getTerminalContainerRef,
  isTerminalReady,
  getSessionLabel,
  getSessionState,
  getSessionReason,
  bellPendingBySession,
  getSessionBanner,
  onFocusPane,
  onSwitchSession,
  onReorderPaneSessions,
  onOpenSessionMenu,
  onClosePaneSession,
  onResizePaneSplit,
  onPaneMouseDown,
  onPaneContextMenu,
  autocomplete,
  autocompleteAnchor,
  onApplyAutocompleteSuggestion,
  hasSplitPanes,
}: PaneNodeViewProps) {
  if (node.kind === "split") {
    const firstBasis = `${node.ratio * 100}%`;
    const secondBasis = `${(1 - node.ratio) * 100}%`;
    return (
      <div className={`terminal-split terminal-split-${node.axis}`}>
        <div className="terminal-split-slot" style={{ flexBasis: firstBasis }}>
          <PaneNodeView
            node={node.first}
            activePaneId={activePaneId}
            getTerminalContainerRef={getTerminalContainerRef}
            isTerminalReady={isTerminalReady}
            getSessionLabel={getSessionLabel}
            getSessionState={getSessionState}
            getSessionReason={getSessionReason}
            bellPendingBySession={bellPendingBySession}
            getSessionBanner={getSessionBanner}
            onFocusPane={onFocusPane}
            onSwitchSession={onSwitchSession}
            onReorderPaneSessions={onReorderPaneSessions}
            onOpenSessionMenu={onOpenSessionMenu}
            onClosePaneSession={onClosePaneSession}
            onResizePaneSplit={onResizePaneSplit}
            onPaneMouseDown={onPaneMouseDown}
            onPaneContextMenu={onPaneContextMenu}
            autocomplete={autocomplete}
            autocompleteAnchor={autocompleteAnchor}
            onApplyAutocompleteSuggestion={onApplyAutocompleteSuggestion}
            hasSplitPanes={hasSplitPanes}
          />
        </div>
        <PaneResizeHandle
          axis={node.axis}
          onResize={(ratio) => {
            const targetPaneId = resolveSplitResizeTargetPaneId(node);
            if (!targetPaneId) return;
            onResizePaneSplit(targetPaneId, ratio);
          }}
        />
        <div className="terminal-split-slot" style={{ flexBasis: secondBasis }}>
          <PaneNodeView
            node={node.second}
            activePaneId={activePaneId}
            getTerminalContainerRef={getTerminalContainerRef}
            isTerminalReady={isTerminalReady}
            getSessionLabel={getSessionLabel}
            getSessionState={getSessionState}
            getSessionReason={getSessionReason}
            bellPendingBySession={bellPendingBySession}
            getSessionBanner={getSessionBanner}
            onFocusPane={onFocusPane}
            onSwitchSession={onSwitchSession}
            onReorderPaneSessions={onReorderPaneSessions}
            onOpenSessionMenu={onOpenSessionMenu}
            onClosePaneSession={onClosePaneSession}
            onResizePaneSplit={onResizePaneSplit}
            onPaneMouseDown={onPaneMouseDown}
            onPaneContextMenu={onPaneContextMenu}
            autocomplete={autocomplete}
            autocompleteAnchor={autocompleteAnchor}
            onApplyAutocompleteSuggestion={onApplyAutocompleteSuggestion}
            hasSplitPanes={hasSplitPanes}
          />
        </div>
      </div>
    );
  }

  return (
    <LeafPaneView
      node={node}
      activePaneId={activePaneId}
      getTerminalContainerRef={getTerminalContainerRef}
      isTerminalReady={isTerminalReady}
      getSessionLabel={getSessionLabel}
      getSessionState={getSessionState}
      bellPendingBySession={bellPendingBySession}
      getSessionBanner={getSessionBanner}
      onFocusPane={onFocusPane}
      onSwitchSession={onSwitchSession}
      onReorderPaneSessions={onReorderPaneSessions}
      onOpenSessionMenu={onOpenSessionMenu}
      onClosePaneSession={onClosePaneSession}
      onPaneMouseDown={onPaneMouseDown}
      onPaneContextMenu={onPaneContextMenu}
      autocomplete={autocomplete}
      autocompleteAnchor={autocompleteAnchor}
      onApplyAutocompleteSuggestion={onApplyAutocompleteSuggestion}
      hasSplitPanes={hasSplitPanes}
    />
  );
}

type LeafPaneViewProps = Omit<
  PaneNodeViewProps,
  "node" | "getSessionReason" | "onResizePaneSplit"
> & {
  node: Extract<SessionPaneNode, { kind: "leaf" }>;
};

type TabDragPreview = {
  sourceSessionId: string;
  targetSessionId: string | null;
  sessionIds: string[];
};

function LeafPaneView({
  node,
  activePaneId,
  getTerminalContainerRef,
  isTerminalReady,
  getSessionLabel,
  getSessionState,
  bellPendingBySession,
  getSessionBanner,
  onFocusPane,
  onSwitchSession,
  onReorderPaneSessions,
  onOpenSessionMenu,
  onClosePaneSession,
  onPaneMouseDown,
  onPaneContextMenu,
  autocomplete,
  autocompleteAnchor,
  onApplyAutocompleteSuggestion,
  hasSplitPanes,
}: LeafPaneViewProps) {
  const [dragPreview, setDragPreview] = useState<TabDragPreview | null>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const previousTabRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const orderedSessionIds = dragPreview?.sessionIds ?? node.sessionIds;

  useLayoutEffect(() => {
    const previousRects = previousTabRectsRef.current;
    if (!previousRects.size) return;
    previousTabRectsRef.current = new Map();
    orderedSessionIds.forEach((sessionId) => {
      const element = tabRefs.current[sessionId];
      const previousRect = previousRects.get(sessionId);
      if (!element || !previousRect || element.classList.contains("dragging")) {
        return;
      }
      const nextRect = element.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
      element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: 160,
          easing: "ease",
        },
      );
    });
  }, [orderedSessionIds]);

  function captureTabRects() {
    const rects = new Map<string, DOMRect>();
    Object.entries(tabRefs.current).forEach(([sessionId, element]) => {
      if (element) {
        rects.set(sessionId, element.getBoundingClientRect());
      }
    });
    previousTabRectsRef.current = rects;
  }

  function updateDragPreview(
    sourceSessionId: string,
    targetSessionId: string | null,
  ) {
    setDragPreview({
      sourceSessionId,
      targetSessionId,
      sessionIds: targetSessionId
        ? reorderSessionIds(node.sessionIds, sourceSessionId, targetSessionId)
        : node.sessionIds,
    });
  }

  function clearDragPreview() {
    setDragPreview(null);
    previousTabRectsRef.current = new Map();
  }

  // 单工作区时外层 terminal-widget 已有边框，pane 内层不再重复显示激活边框；
  // 只有拆分出多个工作区后，才用 pane 激活边框表达当前聚焦区域。
  const activePane = hasSplitPanes && node.paneId === activePaneId;
  const paneActiveSessionId =
    node.activeSessionId ?? node.sessionIds[node.sessionIds.length - 1] ?? null;
  const bannerText = paneActiveSessionId
    ? getSessionBanner(paneActiveSessionId)
    : null;
  const paneAutocomplete =
    paneActiveSessionId && autocomplete?.sessionId === paneActiveSessionId
      ? autocomplete
      : null;
  const paneAutocompleteAnchor = paneAutocomplete ? autocompleteAnchor : null;

  return (
    <div
      className={`terminal-pane ${activePane ? "active" : ""}`}
      onMouseDown={() => onFocusPane(node.paneId)}
    >
      <div className="terminal-header">
        <div className="session-tabs">
          {orderedSessionIds.map((sessionId, index) => {
            const sessionActive = sessionId === paneActiveSessionId;
            const disconnected = getSessionState(sessionId) === "disconnected";
            const showBell =
              !sessionActive && !!bellPendingBySession[sessionId];
            const showCloseButton = sessionActive;
            const dragging = dragPreview?.sourceSessionId === sessionId;
            const dropTarget = dragPreview?.targetSessionId === sessionId;
            // 标签序号按当前 pane 内顺序独立计算，分屏后各区域都从 1 开始。
            const sessionLabel = `${index + 1}. ${getSessionLabel(sessionId)}`;
            return (
              <div
                key={sessionId}
                ref={(element) => {
                  tabRefs.current[sessionId] = element;
                  if (!element) {
                    delete tabRefs.current[sessionId];
                  }
                }}
                data-pane-session-id={sessionId}
                className={`session-tab session-tab-trigger-inline ${
                  sessionActive ? "active" : ""
                } ${disconnected ? "disconnected" : ""} ${
                  showCloseButton ? "show-close" : ""
                } ${dragging ? "dragging" : ""} ${
                  dropTarget ? "drop-target" : ""
                }`}
                onPointerDown={(event) =>
                  handleSessionPointerDown(
                    event,
                    node.paneId,
                    sessionId,
                    node.sessionIds,
                    onReorderPaneSessions,
                    {
                      onCaptureLayout: captureTabRects,
                      onPreviewChange: updateDragPreview,
                      onPreviewClear: clearDragPreview,
                    },
                  )
                }
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onFocusPane(node.paneId);
                  onSwitchSession(sessionId);
                  onOpenSessionMenu({
                    x: event.clientX,
                    y: event.clientY,
                    paneId: node.paneId,
                    sessionId,
                  });
                }}
              >
                <button
                  type="button"
                  className="session-tab-trigger"
                  onClick={(event) => {
                    event.stopPropagation();
                    onFocusPane(node.paneId);
                    onSwitchSession(sessionId);
                  }}
                >
                  {sessionLabel}
                </button>
                {showBell ? (
                  <span className="session-tab-bell" aria-hidden="true">
                    <FiBell />
                  </span>
                ) : null}
                {showCloseButton && (
                  <button
                    type="button"
                    className="close"
                    aria-label="close-pane-session"
                    onClick={(event) => {
                      event.stopPropagation();
                      onClosePaneSession(node.paneId, sessionId);
                    }}
                  >
                    <FiX />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="terminal-pane-content">
        {node.sessionIds.map((sessionId) => {
          const activeSession = sessionId === paneActiveSessionId;
          const showAutocomplete =
            activeSession &&
            paneAutocomplete &&
            paneAutocompleteAnchor &&
            paneAutocomplete.items.length > 0;
          return (
            <div
              key={sessionId}
              className={`terminal-container-shell ${activeSession ? "active" : ""}`}
            >
              <div
                className={`terminal-container ${activeSession ? "active" : ""} ${
                  isTerminalReady(sessionId) ? "ready" : ""
                }`}
                ref={getTerminalContainerRef(sessionId)}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  onPaneMouseDown(sessionId, event);
                }}
                onContextMenu={(event) => onPaneContextMenu(sessionId, event)}
              />
              {showAutocomplete && (
                <div
                  className={`terminal-autocomplete terminal-autocomplete-${paneAutocompleteAnchor.placement}`}
                  style={{
                    left: `${paneAutocompleteAnchor.left}px`,
                    [paneAutocompleteAnchor.placement === "top"
                      ? "bottom"
                      : "top"]: `${paneAutocompleteAnchor.offset}px`,
                    maxHeight: `${paneAutocompleteAnchor.maxHeight}px`,
                  }}
                >
                  {paneAutocomplete.items.map((item, index) => (
                    <button
                      key={item.command}
                      type="button"
                      className={`terminal-autocomplete-item ${
                        index === paneAutocomplete.selectedIndex ? "active" : ""
                      }`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onApplyAutocompleteSuggestion(item.command);
                      }}
                    >
                      <span className="terminal-autocomplete-command">
                        {item.command}
                      </span>
                      <span className="terminal-autocomplete-meta">
                        {item.useCount}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {bannerText && <div className="terminal-banner">{bannerText}</div>}
      </div>
    </div>
  );
}

type PaneResizeHandleProps = {
  axis: "horizontal" | "vertical";
  onResize: (ratio: number) => void;
};

function PaneResizeHandle({ axis, onResize }: PaneResizeHandleProps) {
  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const handle = event.currentTarget;
    const container = handle.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onPointerMove = (moveEvent: PointerEvent) => {
      const ratio =
        axis === "horizontal"
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height;
      onResize(ratio);
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  return (
    <div
      className={`terminal-split-handle terminal-split-handle-${axis}`}
      onPointerDown={handlePointerDown}
    />
  );
}

function handleSessionPointerDown(
  event: React.PointerEvent<HTMLElement>,
  paneId: string,
  sessionId: string,
  sessionIds: string[],
  onReorderPaneSessions: (
    paneId: string,
    sourceSessionId: string,
    targetSessionId: string,
  ) => void,
  previewHandlers: {
    onCaptureLayout: () => void;
    onPreviewChange: (
      sourceSessionId: string,
      targetSessionId: string | null,
    ) => void;
    onPreviewClear: () => void;
  },
) {
  if (event.button !== 0) return;
  const sourceElement = event.currentTarget;
  const tabList = sourceElement.closest(".session-tabs");
  if (!tabList) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;
  let lastTargetSessionId: string | null = null;
  previewHandlers.onPreviewChange(sessionId, null);

  function resolveTargetSessionId(clientX: number, clientY: number) {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-pane-session-id]");
    if (!target || target === sourceElement) return null;
    if (target.closest(".session-tabs") !== tabList) return null;
    const targetSessionId = target.dataset.paneSessionId ?? null;
    if (!targetSessionId || !sessionIds.includes(targetSessionId)) return null;
    return targetSessionId;
  }

  function cleanup() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("blur", onPointerCancel);
    previewHandlers.onPreviewClear();
  }

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (
      Math.abs(moveEvent.clientX - startX) > 4 ||
      Math.abs(moveEvent.clientY - startY) > 4
    ) {
      moved = true;
    }
    if (!moved) return;
    const nextTargetSessionId = resolveTargetSessionId(
      moveEvent.clientX,
      moveEvent.clientY,
    );
    if (!nextTargetSessionId) return;
    if (nextTargetSessionId === lastTargetSessionId) return;
    previewHandlers.onCaptureLayout();
    lastTargetSessionId = nextTargetSessionId;
    previewHandlers.onPreviewChange(sessionId, nextTargetSessionId);
  };
  const onPointerUp = (upEvent: PointerEvent) => {
    const targetSessionId =
      resolveTargetSessionId(upEvent.clientX, upEvent.clientY) ??
      lastTargetSessionId;
    cleanup();
    if (!moved || !targetSessionId || targetSessionId === sessionId) return;
    const reordered = reorderSessionIds(sessionIds, sessionId, targetSessionId);
    if (arraysEqual(reordered, sessionIds)) return;
    onReorderPaneSessions(paneId, sessionId, targetSessionId);
  };
  const onPointerCancel = () => cleanup();
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
  window.addEventListener("pointercancel", onPointerCancel, { once: true });
  window.addEventListener("blur", onPointerCancel, { once: true });
}

function reorderSessionIds(
  sessionIds: string[],
  sourceSessionId: string,
  targetSessionId: string,
) {
  const sourceIndex = sessionIds.indexOf(sourceSessionId);
  const targetIndex = sessionIds.indexOf(targetSessionId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return sessionIds;
  }
  const next = sessionIds.slice();
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

function arraysEqual(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function findFirstLeafPaneId(node: SessionPaneNode): string | null {
  if (node.kind === "leaf") return node.paneId;
  return findFirstLeafPaneId(node.first) ?? findFirstLeafPaneId(node.second);
}

/** split 比例挂在父节点上，因此拖拽句柄只需定位该 split 下任意一个叶子 pane 即可。 */
function resolveSplitResizeTargetPaneId(
  node: Extract<SessionPaneNode, { kind: "split" }>,
) {
  return findFirstLeafPaneId(node.first) ?? findFirstLeafPaneId(node.second);
}
