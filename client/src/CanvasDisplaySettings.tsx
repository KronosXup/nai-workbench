import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { MoveDiagonal2, Settings } from "lucide-react";

export type CanvasTransparencyBackground =
  | "checker" | "light-checker" | "dark-checker" | "none"
  | "black" | "white" | "gray" | "red" | "green" | "blue";

type Props = {
  allowUpscale: boolean;
  onAllowUpscaleChange: (value: boolean) => void;
  transparencyBackground: CanvasTransparencyBackground;
  onTransparencyBackgroundChange: (value: CanvasTransparencyBackground) => void;
  showTransparencyControls: boolean;
};

const backgrounds: { value: CanvasTransparencyBackground; label: string }[] = [
  { value: "checker", label: "棋盘格" },
  { value: "light-checker", label: "浅色棋盘格" },
  { value: "dark-checker", label: "深色棋盘格" },
  { value: "none", label: "不显示背景" },
  { value: "black", label: "黑色" },
  { value: "white", label: "白色" },
  { value: "gray", label: "灰色" },
  { value: "red", label: "红色" },
  { value: "green", label: "绿色" },
  { value: "blue", label: "蓝色" },
];

export default function CanvasDisplaySettings({ allowUpscale, onAllowUpscaleChange,
  transparencyBackground, onTransparencyBackgroundChange, showTransparencyControls }: Props) {
  const menuId = `canvas-display-${useId()}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  const close = () => { setOpen(false); setPaletteOpen(false); };
  useEffect(() => {
    if (!showTransparencyControls) setPaletteOpen(false);
  }, [showTransparencyControls]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current;
      const panel = menu.current;
      if (!button || !panel) return;
      const rect = button.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const width = Math.min(paletteOpen && showTransparencyControls ? 180 : 48, viewportWidth - 16);
      const height = Math.min(panel.scrollHeight + panel.offsetHeight - panel.clientHeight, viewportHeight - 16);
      const above = rect.top - viewportTop - 14;
      const below = viewportTop + viewportHeight - rect.bottom - 14;
      const top = above >= height || above >= below ? rect.top - height - 6 : rect.bottom + 6;
      setPosition({
        left: Math.max(viewportLeft + 8, Math.min(rect.left + (rect.width - width) / 2, viewportLeft + viewportWidth - width - 8)),
        top: Math.max(viewportTop + 8, Math.min(top, viewportTop + viewportHeight - height - 8)),
        width, maxHeight: Math.max(0, Math.min(height, Math.max(above, below))),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, paletteOpen, showTransparencyControls]);

  useEffect(() => {
    if (!open) return;
    const panel = menu.current;
    const button = trigger.current;
    panel?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel?.contains(event.target) && !button?.contains(event.target)) close();
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (!panel?.contains(document.activeElement)) return;
      const all = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"));
      const current = all.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Tab") {
        if ((event.shiftKey && current === 0) || (!event.shiftKey && current === all.length - 1)) {
          button?.focus();
          close();
        }
        return;
      }
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const grid = palette.current;
      if (grid?.contains(document.activeElement)) {
        const choices = Array.from(grid.querySelectorAll<HTMLButtonElement>("button"));
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === "ArrowUp" ? -4 : event.key === "ArrowDown" ? 4 : event.key === "ArrowLeft" ? -1 : 1;
        const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : Math.max(0, Math.min(choices.length - 1, index + delta));
        choices[next]?.focus();
        return;
      }
      const next = event.key === "Home" ? 0 : event.key === "End" ? all.length - 1
        : (current + (event.key === "ArrowUp" || event.key === "ArrowLeft" ? all.length - 1 : 1)) % all.length;
      all[next]?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keydown);
      if (document.activeElement === document.body || panel?.contains(document.activeElement)) button?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (paletteOpen) palette.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }, [paletteOpen]);

  return <>
    <button ref={trigger} type="button" className="nai-canvas-control nai-canvas-display-trigger"
      aria-label="画布显示设置" title="画布显示设置" aria-haspopup="dialog" aria-expanded={open} aria-controls={menuId}
      onClick={() => open ? close() : setOpen(true)}
      onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <Settings size={16} strokeWidth={1.7} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={menuId} role="dialog" aria-label="画布显示设置"
      className="nai-canvas-display-popover theme-official" style={position}>
      <div className="nai-canvas-display-toggles">
        <button type="button" aria-label="自动放大小图" title="自动放大小图" aria-pressed={allowUpscale}
          onClick={() => onAllowUpscaleChange(!allowUpscale)}><MoveDiagonal2 size={16} strokeWidth={1.7} aria-hidden="true" /></button>
        {showTransparencyControls && <button type="button" aria-label="透明背景" title="透明背景"
          aria-expanded={paletteOpen} aria-controls={`${menuId}-backgrounds`} onClick={() => setPaletteOpen(value => !value)}>
          <span className="nai-canvas-background-icon" aria-hidden="true" />
        </button>}
      </div>
      {showTransparencyControls && paletteOpen && <div ref={palette} id={`${menuId}-backgrounds`}
        className="nai-canvas-background-grid" role="group" aria-label="透明背景颜色">
        {backgrounds.map(({ value, label }) => <button key={value} type="button" aria-label={label} title={label}
          data-background={value} aria-pressed={transparencyBackground === value}
          onClick={() => onTransparencyBackgroundChange(value)} />)}
      </div>}
    </div>, document.body)}
  </>;
}
