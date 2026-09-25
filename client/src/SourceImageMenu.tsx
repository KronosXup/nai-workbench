import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type Props = {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
};

export default function SourceImageMenu({ id, anchor, onClose, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const trigger = anchor.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const width = Math.min(224, viewportWidth - 16);
    const below = Math.max(0, viewportHeight - rect.bottom - 13);
    const above = Math.max(0, rect.top - 13);
    const wantedHeight = Math.min(menu.scrollHeight, 300);
    const openAbove = below < wantedHeight && above > below;
    const maxHeight = Math.min(300, openAbove ? above : below);
    setPosition({
      width,
      left: Math.max(8, Math.min(rect.right - width, viewportWidth - width - 8)),
      top: openAbove ? rect.top - 5 - Math.min(wantedHeight, maxHeight) : rect.bottom + 5,
      maxHeight,
    });

    const outsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) onClose();
    };
    const outsideFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) onClose();
    };
    // A portal avoids clipping by the sidebar. Scrolling that sidebar dismisses
    // the menu, so it cannot remain detached from an offscreen source card.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      if (menu.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      onClose();
    };
    const onResize = () => {
      if (menu.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      onClose();
    };
    document.addEventListener("pointerdown", outsidePointer, true);
    document.addEventListener("focusin", outsideFocus);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("focusin", outsideFocus);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    // Focus after the measured position has made the portal visible.
    if (position.visibility !== "hidden") menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [position]);

  return createPortal(
    <div ref={menuRef} id={id} className="nai-source-menu" role="menu" aria-label="源图更多操作" style={position}
      onKeyDown={event => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          event.stopPropagation();
          anchor.current?.focus({ preventScroll: true });
          onClose();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
          (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {children}
    </div>, document.body,
  );
}
