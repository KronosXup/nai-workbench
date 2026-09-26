import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Clapperboard, Clock, Coins, FolderOpen, Grid2X2, Images, Layers, Menu, Paintbrush, Palette, Settings2, Sparkles } from "lucide-react";
import type { User } from "./types";
import "./workspace-header.css";

type Page = "draw" | "director" | "batch" | "gallery" | "settings";
type Props = {
  page: Page;
  onPage: (page: Page) => void;
  user: User;
  userRefreshIssue: boolean;
  isMock: boolean;
  pending: number;
  onQueue: () => void;
  onLibrary: () => void;
  onBlankCanvas: () => void;
  onNewCanvas: () => void;
};

export default function WorkspaceHeader(p: Props) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8, width: 280, maxHeight: 400 });
  const header = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const trigger = menuButton.current?.getBoundingClientRect();
      const bar = header.current?.getBoundingClientRect();
      if (!trigger || !bar) return;
      const gap = 8;
      const width = Math.min(280, window.innerWidth - gap * 2);
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      // The drawing header shares the input column's right edge. Only use the
      // button's lower edge when that adjacent space cannot fit the menu.
      const edge = p.page === "draw" && window.innerWidth > 700 ? bar.right : trigger.right;
      const beside = edge + gap + width <= window.innerWidth - gap;
      const left = beside ? edge + gap : Math.max(gap, Math.min(trigger.right - width, window.innerWidth - gap - width));
      const top = Math.max(gap, Math.min(beside ? trigger.top : trigger.bottom + gap, viewportHeight - gap * 2));
      const maxHeight = Math.max(gap, viewportHeight - top - gap);
      setMenuPosition(previous => previous.left === left && previous.top === top && previous.width === width && previous.maxHeight === maxHeight
        ? previous : { left, top, width, maxHeight });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
    };
  }, [open, p.page]);

  useEffect(() => {
    if (!open) return;
    const panel = menu.current;
    const trigger = menuButton.current;
    panel?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel?.contains(event.target) && !trigger?.contains(event.target)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (!panel?.contains(document.activeElement)) return;
      // This is a non-modal menu: Tab returns to the normal page sequence.
      if (event.key === "Tab") {
        trigger?.focus();
        setOpen(false);
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
      if (document.activeElement === document.body || panel?.contains(document.activeElement)) trigger?.focus();
    };
  }, [open]);
  const run = (action: () => void) => { setOpen(false); action(); };
  const pages = [
    { id: "draw" as const, label: "绘图", Icon: Paintbrush },
    { id: "director" as const, label: "导演工具", Icon: Clapperboard },
    { id: "batch" as const, label: "批量", Icon: Layers },
    { id: "gallery" as const, label: "图库", Icon: Grid2X2 },
    { id: "settings" as const, label: "设置", Icon: Settings2 },
  ];
  const quota = p.user.gate_quota;
  const points = quota?.anlasLeft ?? p.user.quota.remaining;
  const pointsLabel = quota?.anlasEnabled === false ? "不可使用"
    : quota?.isAdmin || (quota?.anlasEnabled === true && quota.anlasMonthlyLimit === 0) ? "未设月限额"
    : `${points.toLocaleString("zh-CN")} 点`;
  const v5Label = quota?.v5Unlimited ? "不限" : `${quota?.v5LeftToday.toLocaleString("zh-CN")} 次`;
  const queueCount = p.pending > 99 ? "99+" : p.pending;

  return <>
    <header ref={header} className="workspace-header">
      {p.page === "director" ? <div className="workspace-director-home">
        <button type="button" onClick={() => p.onPage("draw")} aria-label="返回绘图" title="返回绘图"><ArrowLeft size={21}/><Palette size={25}/></button>
        <h1 className="workspace-page-title">导演工具</h1>
      </div> : <h1 className="workspace-page-title">{pages.find(({ id }) => id === p.page)?.label}</h1>}
      <div className="workspace-resources" aria-label="可用资源">
        <span className="workspace-resource" title={`当前可用积分：${pointsLabel}`}>
          <Coins size={15}/>
          <span className="workspace-resource-copy"><small>积分</small><b>{pointsLabel}</b>{p.isMock && <small className="workspace-mock">模拟</small>}{p.userRefreshIssue && <small className="workspace-resource-stale" title="账户数据暂时无法刷新，当前显示上次读取的余额">待更新</small>}</span>
        </span>
        {quota && <span className="workspace-resource" title={`Gate 分配给此 Key 的今日 V5 次数：${quota.v5Unlimited ? "不限" : `${quota.v5LeftToday.toLocaleString("zh-CN")} 次`}`}>
          <Images size={15}/>
          <span className="workspace-resource-copy"><small>V5 今日</small><b>{v5Label}</b></span>
        </span>}
      </div>
      <button className="workspace-queue" onClick={p.onQueue} aria-label={`任务队列，${p.pending} 项待完成`} title="任务队列"><Clock size={17}/><b aria-hidden="true">{queueCount}</b></button>
      <button ref={menuButton} className="workspace-menu-button" aria-label={open ? "关闭菜单" : "打开菜单"} aria-haspopup="menu" aria-expanded={open} aria-controls="workspace-navigation" onClick={() => setOpen(!open)}><Menu size={21}/></button>
    </header>
    {open && createPortal(<nav ref={menu} id="workspace-navigation" className="workspace-menu-popover" role="menu" aria-label="工作台菜单" style={menuPosition}>
      {pages.map(({ id, label, Icon }) => <button key={id} role="menuitem" tabIndex={-1} aria-current={p.page === id ? "page" : undefined} onClick={() => run(() => p.onPage(id))}><Icon size={18}/>{label}</button>)}
      <hr role="separator"/>
      <button role="menuitem" tabIndex={-1} onClick={() => run(p.onLibrary)}><FolderOpen size={18}/>提示词预设</button>
      <button role="menuitem" tabIndex={-1} onClick={() => run(p.onNewCanvas)}><Paintbrush size={18}/>新建绘图画布</button>
      <button role="menuitem" tabIndex={-1} onClick={() => run(p.onBlankCanvas)}><Sparkles size={18}/>清空结果视图</button>
    </nav>, document.body)}
  </>;
}
