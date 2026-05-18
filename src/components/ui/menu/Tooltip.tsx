import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

/** Tooltip 弹出的方向预设。 */
type TooltipPlacement = "top" | "bottom" | "left" | "right";

type TooltipProps = {
  /** 提示内容文本。 */
  content: ReactNode;
  /** 触发 Tooltip 的子元素。 */
  children: ReactNode;
  /** 弹出方向，默认为 "top"。 */
  placement?: TooltipPlacement;
  /** 气泡与目标元素之间的间距（像素），默认为 8。 */
  offset?: number;
  /** 悬停延迟，默认 240ms。 */
  delayMs?: number;
  /** 是否禁用 Tooltip。 */
  disabled?: boolean;
  /** 追加到气泡上的样式类。 */
  bubbleClassName?: string;
};

const TOOLTIP_VIEWPORT_GAP = 12;

type TooltipPosition = {
  left: number;
  top: number;
  placement: TooltipPlacement;
};

/**
 * 全局 Tooltip 悬浮提示组件。
 * 职责：展示简短的辅助信息。
 * 交互：通过 createPortal 将气泡挂载到 body 下，确保气泡在复杂的层级（如 Overflow: hidden 容器）中仍能完整显示。
 */
export default function Tooltip({
  content,
  children,
  placement = "top",
  offset = 8,
  delayMs = 240,
  disabled = false,
  bubbleClassName,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({
    left: 0,
    top: 0,
    placement,
  });
  const targetRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const tooltipId = useId();
  const hasContent = useMemo(() => {
    if (typeof content === "string") {
      return content.trim().length > 0;
    }
    return Boolean(content);
  }, [content]);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const resolvePlacement = useCallback(
    (rect: DOMRect, bubbleRect: DOMRect, preferred: TooltipPlacement) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const fitsTop =
        rect.top >= bubbleRect.height + offset + TOOLTIP_VIEWPORT_GAP;
      const fitsBottom =
        viewportHeight - rect.bottom >=
        bubbleRect.height + offset + TOOLTIP_VIEWPORT_GAP;
      const fitsLeft =
        rect.left >= bubbleRect.width + offset + TOOLTIP_VIEWPORT_GAP;
      const fitsRight =
        viewportWidth - rect.right >=
        bubbleRect.width + offset + TOOLTIP_VIEWPORT_GAP;

      if (preferred === "top" && fitsTop) return "top";
      if (preferred === "bottom" && fitsBottom) return "bottom";
      if (preferred === "left" && fitsLeft) return "left";
      if (preferred === "right" && fitsRight) return "right";
      if (fitsTop) return "top";
      if (fitsBottom) return "bottom";
      if (fitsRight) return "right";
      if (fitsLeft) return "left";
      return preferred;
    },
    [offset],
  );

  const updatePosition = useCallback(() => {
    const target = targetRef.current;
    const bubble = bubbleRef.current;
    if (!target || !bubble) return;
    const rect = target.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const nextPlacement = resolvePlacement(rect, bubbleRect, placement);
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left = centerX;
    let top = rect.top - offset;

    switch (nextPlacement) {
      case "bottom":
        top = rect.bottom + offset;
        break;
      case "left":
        left = rect.left - offset;
        top = centerY;
        break;
      case "right":
        left = rect.right + offset;
        top = centerY;
        break;
      default:
        break;
    }

    const halfWidth = bubbleRect.width / 2;
    if (nextPlacement === "top" || nextPlacement === "bottom") {
      left = Math.min(
        Math.max(left, TOOLTIP_VIEWPORT_GAP + halfWidth),
        viewportWidth - TOOLTIP_VIEWPORT_GAP - halfWidth,
      );
    } else if (nextPlacement === "left") {
      left = Math.max(left, TOOLTIP_VIEWPORT_GAP + bubbleRect.width);
      top = Math.min(
        Math.max(top, TOOLTIP_VIEWPORT_GAP + bubbleRect.height / 2),
        viewportHeight - TOOLTIP_VIEWPORT_GAP - bubbleRect.height / 2,
      );
    } else {
      left = Math.min(
        left,
        viewportWidth - TOOLTIP_VIEWPORT_GAP - bubbleRect.width,
      );
      top = Math.min(
        Math.max(top, TOOLTIP_VIEWPORT_GAP + bubbleRect.height / 2),
        viewportHeight - TOOLTIP_VIEWPORT_GAP - bubbleRect.height / 2,
      );
    }

    setPosition({ left, top, placement: nextPlacement });
  }, [offset, placement, resolvePlacement]);

  function handleShow() {
    if (disabled || !hasContent) return;
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      setOpen(true);
      openTimerRef.current = null;
    }, delayMs);
  }

  function handleHide() {
    clearOpenTimer();
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handleViewportChange = () => updatePosition();
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
    };
  }, [clearOpenTimer]);

  return (
    <>
      <div
        className="tooltip-target"
        ref={targetRef}
        onMouseEnter={handleShow}
        onMouseLeave={handleHide}
        onFocus={handleShow}
        onBlur={handleHide}
        aria-describedby={open ? tooltipId : undefined}
      >
        {children}
      </div>
      {open &&
        createPortal(
          <div className="tooltip-layer">
            <div
              ref={bubbleRef}
              className={`tooltip-bubble ${bubbleClassName ?? ""}`.trim()}
              data-placement={position.placement}
              style={{ left: position.left, top: position.top }}
              role="tooltip"
              id={tooltipId}
            >
              {content}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
