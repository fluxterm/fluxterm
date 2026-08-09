/**
 * 通用右键菜单。
 * 当前布局会始终预留左侧图标列，因此业务侧新增菜单项时应优先提供 icon，
 * 避免菜单整组都为空图标时出现左侧留白过重、视觉失衡的问题。
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./ContextMenu.css";

export type ContextMenuItem = {
  id?: string;
  label: string;
  disabled?: boolean;
  /** 尽量为菜单项提供图标，保持预留图标列的视觉平衡。 */
  icon?: ReactNode | null;
  danger?: boolean;
  onClick: () => void;
};

type ContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

const VIEWPORT_GAP = 8;

/** 通用右键菜单组件。 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    queueMicrotask(() => {
      setPosition({ x, y });
    });
  }, [x, y]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(
      VIEWPORT_GAP,
      window.innerWidth - rect.width - VIEWPORT_GAP,
    );
    const maxTop = Math.max(
      VIEWPORT_GAP,
      window.innerHeight - rect.height - VIEWPORT_GAP,
    );

    const nextX = Math.min(Math.max(x, VIEWPORT_GAP), maxLeft);
    const nextY = Math.min(Math.max(y, VIEWPORT_GAP), maxTop);

    if (nextX === position.x && nextY === position.y) return;
    setPosition({ x: nextX, y: nextY });
  }, [x, y, items, position.x, position.y]);

  return (
    <div className="context-menu-overlay" onMouseDown={onClose}>
      <div
        ref={menuRef}
        className="context-menu"
        style={{ top: position.y, left: position.x }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.id ?? item.label}
            data-ui={item.id}
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            onClick={item.onClick}
          >
            <span className="context-menu-icon" aria-hidden="true">
              {item.icon ?? null}
            </span>
            <span className="context-menu-label">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
