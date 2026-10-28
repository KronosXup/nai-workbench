import { useEffect, useMemo, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Grid2X2,
  Plus,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import TagInput, { type TagSuggestion } from "./TagInput";
import TokenMeter from "./TokenMeter";
import { isMediumModel } from './modelSettings';
import {
  createCharacterPrompt,
  enabledCharacterCount,
  moveCharacter,
  withUniqueCharacterIds,
} from "./characterPromptsState";
import type { CharacterGender, CharacterPromptEntry } from "./characterPromptsState";
import "./characterPrompts.css";

type Props = {
  characters: CharacterPromptEntry[];
  useCoords: boolean;
  maxCharacters: number;
  model: string;
  basePrompt: string;
  baseNegative: string;
  onChange: (characters: CharacterPromptEntry[]) => void;
  onUseCoordsChange: (useCoords: boolean) => void;
  onEditPositions: () => void;
  onSuggestTags?: (model: string, fragment: string) => Promise<TagSuggestion[]>;
};

const genderChoices: { value: CharacterGender; label: string }[] = [
  { value: "female", label: "女" },
  { value: "male", label: "男" },
  { value: "other", label: "其他" },
];
let activeGenderPicker: HTMLDetailsElement | null = null;
let fallbackIdCounter = 0;

function newUiId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    globalThis.crypto.getRandomValues(values);
    return `character-${Array.from(values, value => value.toString(16)).join("")}`;
  }
  fallbackIdCounter += 1;
  return `character-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

function GenderGlyph({ gender }: { gender?: CharacterGender }) {
  if (gender === "female") return <svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="7" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M7 10v6m-3-3h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
  if (gender === "male") return <svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="7" cy="11" r="4" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="m10 8 5-5m-4 0h4v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  if (gender === "other") return <CircleHelp aria-hidden="true" />;
  return <UserRound aria-hidden="true" />;
}

function inferredGender(character: CharacterPromptEntry): CharacterGender | undefined {
  if (character.gender) return character.gender;
  const firstTag = character.prompt.split(/[,|\n]/, 1)[0].trim().toLowerCase();
  if (/^(?:\d+\s*)?(?:girl|woman|female)$/.test(firstTag)) return "female";
  if (/^(?:\d+\s*)?(?:boy|man|male)$/.test(firstTag)) return "male";
  return undefined;
}

function genderLabel(gender?: CharacterGender) {
  return gender === "female" ? "女" : gender === "male" ? "男" : gender === "other" ? "其他" : "角色";
}

function GenderPicker({
  gender,
  onSelect,
  label,
  add = false,
  disabled = false,
}: {
  gender?: CharacterGender;
  onSelect: (gender: CharacterGender) => void;
  label: string;
  add?: boolean;
  disabled?: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);

  function onToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const current = event.currentTarget;
    if (current.open) {
      if (activeGenderPicker && activeGenderPicker !== current) activeGenderPicker.open = false;
      activeGenderPicker = current;
    } else if (activeGenderPicker === current) {
      activeGenderPicker = null;
    }
    setOpen(current.open);
  }

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (!details.current?.contains(event.target as Node)) {
        if (details.current) details.current.open = false;
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !details.current?.open || activeGenderPicker !== details.current) return;
      event.preventDefault();
      details.current.open = false;
      summary.current?.focus();
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <details className="cp-gender-picker" ref={details} onToggle={onToggle}>
      <summary ref={summary} aria-label={label} aria-disabled={disabled || undefined} title={label}
        onClick={event => { if (disabled) event.preventDefault(); }}>
        {add ? <Plus aria-hidden="true" /> : <GenderGlyph gender={gender} />}
      </summary>
      <div className="cp-gender-menu" role="group" aria-label={add ? "添加角色" : "角色性别"}>
        {genderChoices.map(choice => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={add ? undefined : (gender ?? "other") === choice.value}
            onClick={() => {
              onSelect(choice.value);
              if (details.current) details.current.open = false;
              summary.current?.focus();
            }}
          >
            <GenderGlyph gender={choice.value} />{choice.label}
          </button>
        ))}
      </div>
    </details>
  );
}

function CharacterCard({
  character,
  index,
  count,
  collapsed,
  characters,
  enabledCharacters,
  model,
  basePrompt,
  baseNegative,
  onChange,
  onToggleCollapsed,
  onRemove,
  onSuggestTags,
  registerNameInput,
}: {
  character: CharacterPromptEntry;
  index: number;
  count: number;
  collapsed: boolean;
  characters: CharacterPromptEntry[];
  enabledCharacters: CharacterPromptEntry[];
  model: string;
  basePrompt: string;
  baseNegative: string;
  onChange: (characters: CharacterPromptEntry[]) => void;
  onToggleCollapsed: (id: string) => void;
  onRemove: (character: CharacterPromptEntry) => void;
  onSuggestTags?: Props["onSuggestTags"];
  registerNameInput: (id: string, node: HTMLInputElement | null) => void;
}) {
  const [tab, setTab] = useState<"positive" | "negative">("positive");
  const medium = isMediumModel(model);
  const id = character.ui_id ?? `legacy-${index}`;
  const enabled = character.enabled !== false;
  const summary = character.prompt.trim() || "尚无正面提示词";

  function patch(patch: Partial<CharacterPromptEntry>) {
    onChange(characters.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  return (
    <article className={`cp-card${enabled ? "" : " is-disabled"}`} data-character-id={id}>
      <header className="cp-card-header">
        <span className="cp-gender-icon" title={genderLabel(inferredGender(character))}>
          <GenderGlyph gender={inferredGender(character)} />
        </span>
        <input
          ref={node => registerNameInput(id, node)}
          className="cp-name"
          aria-label={`角色 ${index + 1} 名称`}
          placeholder={`角色 ${index + 1}`}
          value={character.name ?? ""}
          onChange={event => patch({ name: event.target.value })}
        />
        <div className="cp-card-actions">
          <button type="button" aria-label={`上移角色 ${index + 1}`} title="上移" disabled={index === 0}
            onClick={() => onChange(moveCharacter(characters, index, index - 1))}>
            <ChevronUp aria-hidden="true" />
          </button>
          <button type="button" aria-label={`下移角色 ${index + 1}`} title="下移" disabled={index === count - 1}
            onClick={() => onChange(moveCharacter(characters, index, index + 1))}>
            <ChevronDown aria-hidden="true" />
          </button>
          <button type="button" className={enabled ? "is-enabled" : ""} aria-pressed={enabled}
            aria-label={`${enabled ? "停用" : "启用"}角色 ${index + 1}`} title={enabled ? "停用角色" : "启用角色"}
            onClick={() => patch({ enabled: !enabled })}>
            {enabled ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
          </button>
          <button type="button" aria-label={`删除角色 ${index + 1}`} title="删除"
            onClick={() => { onChange(characters.filter((_, itemIndex) => itemIndex !== index)); onRemove(character); }}>
            <Trash2 aria-hidden="true" />
          </button>
          <button type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? "展开" : "收起"}角色 ${index + 1}`}
            title={collapsed ? "展开" : "收起"} onClick={() => onToggleCollapsed(id)}>
            {collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          </button>
        </div>
      </header>
      {collapsed ? (
        <button type="button" className="cp-summary" onClick={() => onToggleCollapsed(id)} aria-label={`展开角色 ${index + 1}`}>
          {!enabled && <span className="cp-disabled-label">停用</span>}
          <span>{summary}</span>
        </button>
      ) : (
        <div className="cp-card-body">
          {!enabled && <p className="cp-disabled-note">此角色已停用，不参与本次生成。</p>}
          {!medium && <div className="cp-tabs" role="group" aria-label={`角色 ${index + 1} 提示词类型`}>
            <button type="button" aria-pressed={tab === "positive"} onClick={() => setTab("positive")}>正面</button>
            <button type="button" aria-pressed={tab === "negative"} onClick={() => setTab("negative")}>负面</button>
          </div>}
          {medium || tab === "positive" ? (
            <>
              <TagInput label={`角色 ${index + 1} 正面提示词`} value={character.prompt}
                onChange={prompt => patch({ prompt })} model={model} suggest={onSuggestTags}
                placeholder="角色的外观、服装与动作" />
              {enabled && <TokenMeter compact model={model} label="角色正面" text={character.prompt}
                characterTexts={[basePrompt, ...enabledCharacters.filter(item => item !== character).map(item => item.prompt)]} />}
            </>
          ) : (
            <>
              <TagInput label={`角色 ${index + 1} 负面提示词`} value={character.negative_prompt}
                onChange={negative_prompt => patch({ negative_prompt })} model={model} suggest={onSuggestTags}
                placeholder="此角色的负面提示词" />
              {enabled && <TokenMeter compact model={model} label="角色负面" text={character.negative_prompt}
                characterTexts={[baseNegative, ...enabledCharacters.filter(item => item !== character).map(item => item.negative_prompt)]} />}
            </>
          )}
        </div>
      )}
    </article>
  );
}

export default function CharacterPrompts({
  characters,
  useCoords,
  maxCharacters,
  model,
  basePrompt,
  baseNegative,
  onChange,
  onUseCoordsChange,
  onEditPositions,
  onSuggestTags,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(() =>
    characters.length ? characters[0].ui_id ?? "legacy-0" : null,
  );
  const nameInputs = useRef(new Map<string, HTMLInputElement>());
  const focusAfterAdd = useRef<string | null>(null);
  const generatedIds = useRef(new WeakMap<object, string>());
  const activeCount = enabledCharacterCount(characters);
  const enabledCharacters = useMemo(() => characters.filter(character => character.enabled !== false), [characters]);

  useEffect(() => {
    const next = withUniqueCharacterIds(characters, (character, _index, used) => {
      let id = generatedIds.current.get(character);
      if (!id || used.has(id)) {
        id = newUiId();
        generatedIds.current.set(character, id);
      }
      return id;
    });
    if (next) {
      setExpandedId(current => {
        if (!current?.startsWith("legacy-")) return current;
        const oldIndex = Number(current.slice("legacy-".length));
        return next[oldIndex]?.ui_id ?? current;
      });
      onChange(next);
    }
  }, [characters, onChange]);

  useEffect(() => {
    const id = focusAfterAdd.current;
    if (!id) return;
    nameInputs.current.get(id)?.focus();
    focusAfterAdd.current = null;
  }, [characters]);

  function toggleCollapsed(id: string) {
    setExpandedId(current => current === id ? null : id);
  }

  function addCharacter(gender: CharacterGender) {
    if (activeCount >= maxCharacters) return;
    const next = createCharacterPrompt(gender, newUiId());
    setExpandedId(next.ui_id ?? null);
    focusAfterAdd.current = next.ui_id ?? null;
    onChange([...characters, next]);
  }

  function removeCharacter(character: CharacterPromptEntry) {
    if (!character.ui_id) return;
    setExpandedId(current => current === character.ui_id ? null : current);
  }

  const canAdd = activeCount < maxCharacters;
  const showPositionControls = model.startsWith("nai-diffusion-5")
    ? characters.length >= 1
    : model.startsWith("nai-diffusion-4") && characters.length >= 2;
  const renderIds: string[] = [];
  const seenRenderIds = new Set<string>();
  characters.forEach((character, index) => {
    let id = typeof character.ui_id === "string" ? character.ui_id.trim() : "";
    if (!id || seenRenderIds.has(id)) id = `legacy-${index}`;
    let suffix = 0;
    while (seenRenderIds.has(id)) {
      suffix += 1;
      id = `legacy-${index}-${suffix}`;
    }
    seenRenderIds.add(id);
    renderIds.push(id);
  });

  return (
    <section id="nai-characters-settings" className="cp-root" aria-label="角色提示词">
      <div className="cp-intro">
      <header className="cp-heading">
        <div>
          <strong>角色提示词</strong>
          <p>为画面中的每个角色单独设置提示词。</p>
        </div>
        <GenderPicker add disabled={!canAdd} label={canAdd ? "添加角色" : `已达到 ${maxCharacters} 个启用角色上限`}
          onSelect={addCharacter} />
      </header>
      {showPositionControls && (
        <div className="cp-position-row">
          <span>位置</span>
          <div className="cp-segmented" role="group" aria-label="角色定位方式">
            <button type="button" aria-pressed={!useCoords} onClick={() => onUseCoordsChange(false)}>自动</button>
            <button type="button" aria-pressed={useCoords} onClick={() => onUseCoordsChange(true)}>自定义</button>
          </div>
          <button type="button" className="cp-position-edit" aria-label="角色位置网格" title="角色位置网格" onClick={onEditPositions}>
            <Grid2X2 aria-hidden="true" />
          </button>
        </div>
      )}
      </div>
      {characters.length > 0 && (
        <div className="cp-list">
          {characters.map((character, index) => {
            const id = renderIds[index];
            return (
              <CharacterCard key={id} character={character} index={index} count={characters.length}
                collapsed={expandedId !== id} characters={characters} enabledCharacters={enabledCharacters}
                model={model} basePrompt={basePrompt} baseNegative={baseNegative} onChange={onChange}
                onToggleCollapsed={toggleCollapsed} onRemove={removeCharacter} onSuggestTags={onSuggestTags}
                registerNameInput={(inputId, node) => {
                  if (node) nameInputs.current.set(inputId, node);
                  else nameInputs.current.delete(inputId);
                }} />
            );
          })}
        </div>
      )}
    </section>
  );
}
