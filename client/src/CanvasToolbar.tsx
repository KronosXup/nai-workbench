import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight, ClipboardCopy, Coins, Download, Ellipsis, Expand, Grid2X2Plus, Grid3X3,
  ImagePlus, Images, Layers, Pencil, Pin, ScanFace, Scaling, SlidersHorizontal, Sparkles, Sprout, WandSparkles,
} from "lucide-react";
import CanvasDisplaySettings from "./CanvasDisplaySettings";
import type { CanvasTransparencyBackground } from "./CanvasDisplaySettings";
export type { CanvasTransparencyBackground } from "./CanvasDisplaySettings";
import "./canvasToolbar.css";

export type CanvasToolbarActionId =
  | "enhance" | "variations" | "upscale" | "edit" | "pixel" | "img2img" | "vibe"
  | "reference" | "reuse" | "inpaint" | "director" | "save" | "enlarge";

export type CanvasToolbarAction = {
  onClick: () => void;
  disabled?: boolean;
  hidden?: boolean;
  price?: { value: number; unit: string };
};
export type CanvasToolbarProps = {
  actions: Record<CanvasToolbarActionId, CanvasToolbarAction>;
  info?: { width: number; height: number; seed?: number };
  hasImage?: boolean;
  enhancing?: boolean;
  onUseSeed?: () => void;
  onCopyImage?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  allowUpscale: boolean;
  onAllowUpscaleChange: (value: boolean) => void;
  transparencyBackground: CanvasTransparencyBackground;
  onTransparencyBackgroundChange: (value: CanvasTransparencyBackground) => void;
  showTransparencyControls: boolean;
};

const controls = {
  enhance: { label: "增强图像（Enhance）", Icon: Sparkles },
  variations: { label: "生成 3 张变体", Icon: Grid2X2Plus },
  upscale: { label: "放大 2 倍", Icon: Scaling },
  edit: { label: "画布编辑", Icon: Pencil },
  pixel: { label: "本地像素整理", Icon: Grid3X3 },
  inpaint: { label: "重绘", Icon: WandSparkles },
  img2img: { label: "用作图生图", Icon: ImagePlus },
  vibe: { label: "用作 Vibe", Icon: Layers },
  reference: { label: "用作精准参考", Icon: ScanFace },
  director: { label: "发送到图像工具", Icon: ArrowRight },
  reuse: { label: "回填参数", Icon: SlidersHorizontal },
  enlarge: { label: "查看图片与提示词", Icon: Expand },
  save: { label: "下载选中图", Icon: Download },
};
const primaryActions: CanvasToolbarActionId[] = ["enhance", "variations", "upscale", "img2img", "edit", "inpaint", "director"];
const extraActions: CanvasToolbarActionId[] = ["pixel", "vibe", "reference", "reuse", "enlarge"];
const overflowOrder: CanvasToolbarActionId[] = ["director", "inpaint", "img2img", "edit", "upscale", "variations", "enhance"];
const leadingActions: CanvasToolbarActionId[] = ["enhance", "variations", "upscale"];
type MenuKind = "overflow" | "extra";

export default function CanvasToolbar({ actions, info, hasImage = true, enhancing = false, onUseSeed, onCopyImage, onPin, pinned = false,
  allowUpscale, onAllowUpscaleChange, transparencyBackground, onTransparencyBackgroundChange, showTransparencyControls }: CanvasToolbarProps) {
  const menuId = `canvas-toolbar-menu-${useId()}`;
  const anchor = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const overflowTrigger = useRef<HTMLButtonElement>(null);
  const extraTrigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const [open, setOpen] = useState<MenuKind | null>(null);
  const [overflow, setOverflow] = useState<CanvasToolbarActionId[]>([]);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const visiblePrimary = primaryActions.filter(id => !actions[id].hidden);
  const visibleExtra = extraActions.filter(id => !actions[id].hidden);
  const menuActions = open === "overflow" ? overflow : visibleExtra;
  const menuKey = menuActions.join(",");
  const menuEnabled = menuActions.some(id => !actions[id].disabled);
  const measurementKey = visiblePrimary.map(id => `${id}:${actions[id].price?.value ?? ""}:${actions[id].price?.unit ?? ""}`).join("|");
  const seedKnown = typeof info?.seed === "number" && Number.isFinite(info.seed) && info.seed >= 0;
  const canCopy = typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined";

  useLayoutEffect(() => {
    if (!hasImage || !anchor.current || !measure.current) return;
    const placeActions = () => {
      const container = anchor.current!, row = measure.current!;
      const anchorStyle = getComputedStyle(container), rowStyle = getComputedStyle(row);
      const available = container.clientWidth - parseFloat(anchorStyle.paddingLeft) - parseFloat(anchorStyle.paddingRight);
      const frame = parseFloat(rowStyle.paddingLeft) + parseFloat(rowStyle.paddingRight)
        + parseFloat(rowStyle.borderLeftWidth) + parseFloat(rowStyle.borderRightWidth);
      const gap = parseFloat(rowStyle.columnGap) || 0;
      const widths = new Map(Array.from(row.querySelectorAll<HTMLElement>("[data-measure-action]")).map(element =>
        [element.dataset.measureAction, element.getBoundingClientRect().width]));
      const divider = row.querySelector<HTMLElement>(".nai-canvas-toolbar-divider")!;
      const dividerStyle = getComputedStyle(divider);
      const dividerWidth = divider.getBoundingClientRect().width + parseFloat(dividerStyle.marginLeft) + parseFloat(dividerStyle.marginRight);
      const hidden: CanvasToolbarActionId[] = [];
      const fits = () => {
        const shown = visiblePrimary.filter(id => !hidden.includes(id));
        const divided = shown.some(id => leadingActions.includes(id)) && shown.some(id => !leadingActions.includes(id));
        const count = shown.length + Number(divided) + Number(hidden.length > 0);
        return frame + shown.reduce((sum, id) => sum + (widths.get(id) ?? 0), 0)
          + (divided ? dividerWidth : 0) + (hidden.length ? widths.get("overflow") ?? 0 : 0)
          + Math.max(0, count - 1) * gap <= available;
      };
      for (const id of overflowOrder) {
        if (fits()) break;
        if (visiblePrimary.includes(id)) hidden.push(id);
      }
      const next = visiblePrimary.filter(id => hidden.includes(id));
      setOverflow(previous => previous.join(",") === next.join(",") ? previous : next);
    };
    placeActions();
    const observer = new ResizeObserver(placeActions);
    observer.observe(anchor.current);
    observer.observe(measure.current);
    return () => observer.disconnect();
  }, [hasImage, measurementKey]);

  useEffect(() => {
    if (!hasImage || !menuEnabled) setOpen(null);
  }, [hasImage, menuEnabled, menuKey]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = (open === "overflow" ? overflowTrigger : extraTrigger).current;
      const panel = menu.current;
      if (!button || !panel) return;
      const rect = button.getBoundingClientRect();
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const width = Math.min(224, window.innerWidth - 16);
      const height = Math.min(panel.scrollHeight, viewportHeight - 16);
      const below = viewportHeight - rect.bottom - 13;
      const above = rect.top - 13;
      const down = open === "overflow" ? below >= height || below >= above : above < height && below > above;
      const top = down ? rect.bottom + 5 : rect.top - height - 5;
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(top, viewportHeight - height - 8)),
        width, maxHeight: Math.max(0, Math.min(height, Math.max(below, above))),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open, menuKey]);

  useEffect(() => {
    if (!open) return;
    const panel = menu.current;
    const button = (open === "overflow" ? overflowTrigger : extraTrigger).current;
    const enabled = panel?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    enabled?.[focusLast.current ? enabled.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel?.contains(event.target) && !button?.contains(event.target)) setOpen(null);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(null);
        return;
      }
      if (!panel?.contains(document.activeElement)) return;
      if (event.key === "Tab") {
        button?.focus();
        setOpen(null);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keydown);
      if (document.activeElement === document.body || panel?.contains(document.activeElement)) button?.focus();
    };
  }, [open]);

  function triggerKeyDown(event: KeyboardEvent<HTMLButtonElement>, kind: MenuKind) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    focusLast.current = event.key === "ArrowUp";
    setOpen(kind);
  }

  function priceBadge(id: CanvasToolbarActionId) {
    const price = actions[id].price;
    if (!price || (id !== "variations" && id !== "upscale")) return null;
    const UnitIcon = price.unit.includes("V5") ? Images : Coins;
    return <span className="nai-canvas-action-price" title={`${price.value} ${price.unit}`} aria-label={`预计 ${price.value} ${price.unit}`}>
      <span>{price.value}</span><UnitIcon size={12} strokeWidth={1.7} aria-hidden="true" />
    </span>;
  }

  function actionButton(id: CanvasToolbarActionId, measured = false) {
    if (actions[id].hidden) return null;
    const { label, Icon } = controls[id];
    const price = priceBadge(id);
    const contents = <><Icon size={16} strokeWidth={1.7} aria-hidden="true" />{price}</>;
    const className = `nai-canvas-control${price ? " has-price" : ""}`;
    if (measured) return <span key={id} className={className} data-measure-action={id}>{contents}</span>;
    const cost = price ? `，预计 ${actions[id].price!.value} ${actions[id].price!.unit}` : "";
    return <button key={id} type="button" className={className} aria-label={label} title={`${label}${cost}`}
      aria-pressed={id === "enhance" ? enhancing : undefined}
      disabled={actions[id].disabled} onClick={actions[id].onClick}>{contents}</button>;
  }

  function menuTrigger(kind: MenuKind) {
    const ids = kind === "overflow" ? overflow : visibleExtra;
    const label = kind === "overflow" ? "更多画布操作" : "更多图片操作";
    return <button ref={kind === "overflow" ? overflowTrigger : extraTrigger} type="button" className="nai-canvas-control"
      aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open === kind} aria-controls={menuId}
      disabled={!ids.some(id => !actions[id].disabled)} onKeyDown={event => triggerKeyDown(event, kind)}
      onClick={() => { focusLast.current = false; setOpen(value => value === kind ? null : kind); }}>
      <Ellipsis size={16} strokeWidth={1.7} aria-hidden="true" />
    </button>;
  }

  if (!hasImage) return null;
  const shown = visiblePrimary.filter(id => !overflow.includes(id));
  const leading = shown.filter(id => leadingActions.includes(id));
  const trailing = shown.filter(id => !leadingActions.includes(id));

  return <>
    <div ref={anchor} className="nai-canvas-toolbar-anchor">
      <div className="nai-canvas-toolbar" role="group" aria-label="图片操作">
        {leading.map(id => actionButton(id))}
        {leading.length > 0 && trailing.length > 0 && <span className="nai-canvas-toolbar-divider" aria-hidden="true" />}
        {trailing.map(id => actionButton(id))}
        {overflow.length > 0 && menuTrigger("overflow")}
      </div>
      <div ref={measure} className="nai-canvas-toolbar nai-canvas-toolbar-measure" aria-hidden="true">
        {visiblePrimary.map(id => actionButton(id, true))}
        <span className="nai-canvas-toolbar-divider" />
        <span className="nai-canvas-control" data-measure-action="overflow"><Ellipsis size={16} /></span>
      </div>
    </div>
    <div className="nai-canvas-corners">
      <div className="nai-canvas-metadata" role="group" aria-label="图片参数">
        {info && <>
          <span className="nai-canvas-dimensions" aria-label={`图片尺寸 ${info.width} × ${info.height}`}>
            <span>{info.width}</span><span className="nai-canvas-dimension-cross" aria-hidden="true">×</span><span>{info.height}</span>
          </span>
          <span className="nai-canvas-toolbar-divider nai-canvas-dimensions-divider" aria-hidden="true" />
        </>}
        <CanvasDisplaySettings allowUpscale={allowUpscale} onAllowUpscaleChange={onAllowUpscaleChange}
          transparencyBackground={transparencyBackground} onTransparencyBackgroundChange={onTransparencyBackgroundChange}
          showTransparencyControls={showTransparencyControls} />
        {seedKnown && <button type="button" className="nai-canvas-control nai-canvas-seed" aria-label="使用图片种子" title="使用图片种子"
          disabled={actions.reuse.disabled || !onUseSeed} onClick={onUseSeed}>
          <Sprout size={16} strokeWidth={1.7} aria-hidden="true" /><span>{info!.seed}</span>
        </button>}
      </div>
      <div className="nai-canvas-output-actions" role="group" aria-label="图片查看与保存">
        <div className="nai-canvas-save-group">
          <button type="button" className="nai-canvas-control" aria-label={pinned ? "取消固定图片" : "固定图片"}
            title={pinned ? "取消固定图片" : "固定图片"} aria-pressed={pinned}
            disabled={actions.save.disabled || !onPin} onClick={onPin}>
            <Pin size={16} strokeWidth={1.7} aria-hidden="true" />
          </button>
          {canCopy && <button type="button" className="nai-canvas-control" aria-label="复制图片" title="复制图片"
            disabled={actions.save.disabled || !onCopyImage} onClick={onCopyImage}>
            <ClipboardCopy size={16} strokeWidth={1.7} aria-hidden="true" />
          </button>}
          {actionButton("save")}
        </div>
        {visibleExtra.length > 0 && <div className="nai-canvas-extra-group">{menuTrigger("extra")}</div>}
      </div>
    </div>
    {open && createPortal(<div ref={menu} id={menuId} className="theme-official nai-canvas-toolbar-menu"
      role="menu" aria-label={open === "overflow" ? "更多画布操作" : "更多图片操作"} style={position}>
      {menuActions.map(id => {
        const { label, Icon } = controls[id];
        return <button key={id} type="button" role="menuitem" tabIndex={-1}
          aria-label={label} title={label} disabled={actions[id].disabled}
          onClick={() => { setOpen(null); actions[id].onClick(); }}>
          <Icon size={16} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span>{priceBadge(id)}
        </button>;
      })}
    </div>, document.body)}
  </>;
}
