import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import "./naiSelect.css";

export type NaiSelectOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
  displayLabel?: string;
};

export type NaiSelectProps = {
  value: string;
  options: NaiSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  menuWidth?: number;
  triggerPrefix?: string;
};

type OptionEntry = { option: NaiSelectOption; index: number };
type OptionSection = { group?: string; entries: OptionEntry[] };
type MenuPosition = { left: number; top: number; width: number; maxHeight: number };

const MENU_GUTTER = 8;
const MENU_GAP = 5;
const MENU_MAX_HEIGHT = 300;

function groupOptions(options: NaiSelectOption[]): OptionSection[] {
  const sections: OptionSection[] = [];
  options.forEach((option, index) => {
    let section = sections.at(-1);
    if (!section || section.group !== option.group) {
      section = { group: option.group, entries: [] };
      sections.push(section);
    }
    section.entries.push({ option, index });
  });
  return sections;
}

export default function NaiSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  menuWidth,
  triggerPrefix,
}: NaiSelectProps) {
  const reactId = useId();
  const listboxId = `nai-select-${reactId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const sections = useMemo(() => groupOptions(options), [options]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const firstEnabledIndex = () => options.findIndex((option) => !option.disabled);
  const lastEnabledIndex = () => {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index].disabled) return index;
    }
    return -1;
  };
  const initialActiveIndex = () => {
    if (selectedIndex >= 0 && !options[selectedIndex].disabled) return selectedIndex;
    const first = firstEnabledIndex();
    return first >= 0 ? first : null;
  };

  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const openMenu = () => {
    if (disabled) return;
    setPosition(null);
    setActiveIndex(initialActiveIndex());
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const chooseOption = (option: NaiSelectOption) => {
    if (option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeMenu();
  };

  const moveActive = (direction: 1 | -1) => {
    const count = options.length;
    if (count === 0) return;
    let candidate = activeIndex ?? (direction > 0 ? -1 : 0);
    for (let step = 0; step < count; step += 1) {
      candidate = (candidate + direction + count) % count;
      if (!options[candidate].disabled) {
        setActiveIndex(candidate);
        return;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Keep Tab's normal focus movement; merely highlighting an option must not select it.
    if (event.key === "Tab") {
      if (open) closeMenu();
      return;
    }
    if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openMenu();
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) setOpen(true);
      const target = event.key === "Home" ? firstEnabledIndex() : lastEnabledIndex();
      setActiveIndex(target >= 0 ? target : null);
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      if (!open) openMenu();
      else if (activeIndex !== null && options[activeIndex]) chooseOption(options[activeIndex]);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;

    // The menu lives outside the scrolling sidebar so the footer and panel overflow
    // cannot clip it. Re-anchor it when its trigger scrolls or the viewport changes.
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const rect = trigger.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const availableWidth = Math.max(1, viewportWidth - MENU_GUTTER * 2);
      const width = Math.min(menuWidth ?? rect.width, availableWidth);
      const left = Math.max(MENU_GUTTER, Math.min(rect.left, viewportWidth - width - MENU_GUTTER));
      const belowSpace = Math.max(0, viewportHeight - rect.bottom - MENU_GAP - MENU_GUTTER);
      const aboveSpace = Math.max(0, rect.top - MENU_GAP - MENU_GUTTER);
      const desiredHeight = Math.min(menu.scrollHeight || MENU_MAX_HEIGHT, MENU_MAX_HEIGHT);
      const openAbove = belowSpace < desiredHeight && aboveSpace > belowSpace;
      const availableHeight = openAbove ? aboveSpace : belowSpace;
      const maxHeight = Math.min(MENU_MAX_HEIGHT, availableHeight);
      const placedHeight = Math.min(desiredHeight, maxHeight);
      const rawTop = openAbove ? rect.top - MENU_GAP - placedHeight : rect.bottom + MENU_GAP;
      const top = Math.max(MENU_GUTTER, Math.min(rawTop, viewportHeight - placedHeight - MENU_GUTTER));
      const next = { left, top, width, maxHeight };

      setPosition((current) => {
        if (
          current &&
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width &&
          current.maxHeight === next.maxHeight
        ) return current;
        return next;
      });
    };

    updatePosition();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (menuRef.current) observer?.observe(menuRef.current);
    const visualViewport = window.visualViewport;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    visualViewport?.addEventListener("resize", updatePosition);
    visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      visualViewport?.removeEventListener("resize", updatePosition);
      visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open, menuWidth, options]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex === null) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const menuStyle: CSSProperties = position
    ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }
    : { visibility: "hidden" };

  return (
    <div className={`nai-select${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="nai-select__trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex !== null ? optionId(activeIndex) : undefined}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span className="nai-select__trigger-value">
          {triggerPrefix && <span className="nai-select__prefix">{triggerPrefix}</span>}
          <span className="nai-select__current-value">
            {selectedOption?.displayLabel ?? selectedOption?.label ?? value}
          </span>
        </span>
        <ChevronDown className={`nai-select__chevron${open ? " is-open" : ""}`} aria-hidden="true" size={15} />
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="nai-select__menu"
          role="listbox"
          aria-label={ariaLabel}
          style={menuStyle}
        >
          {sections.map((section, sectionIndex) => {
            const content = section.entries.map(({ option, index }) => {
              const selected = option.value === value;
              const active = index === activeIndex;
              return (
                <div
                  key={`${index}:${option.value}`}
                  id={optionId(index)}
                  className="nai-select__option"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled || undefined}
                  data-active={active || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
                  onClick={() => chooseOption(option)}
                >
                  <span className="nai-select__option-copy">
                    <span className="nai-select__option-title">{option.label}</span>
                    {option.description && <span className="nai-select__description">{option.description}</span>}
                  </span>
                  {selected && <Check className="nai-select__check" aria-hidden="true" size={15} />}
                </div>
              );
            });

            if (section.group) {
              return (
                <div className="nai-select__group" role="group" aria-label={section.group} key={`${section.group}:${sectionIndex}`}>
                  <div className="nai-select__group-title" role="presentation">{section.group}</div>
                  {content}
                </div>
              );
            }
            return <div className="nai-select__ungrouped" key={`ungrouped:${sectionIndex}`}>{content}</div>;
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
