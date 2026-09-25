import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Clock,
  Check,
  Coins,
  Images,
  Download,
  Expand,
  FolderOpen,
  Grid2X2,
  LoaderCircle,
  Paintbrush,
  Plus,
  Settings2,
  SlidersHorizontal,
  Sprout,
  Sun,
  PawPrint,
  X,
} from "lucide-react";
import type { Capabilities, Draft, LocalImage, Operation, User } from "./types";
import { labels } from "./types";
import { hasTransparentBackground, setTransparentBackground } from "./promptTags";
import type { ConfigurationIssue, QuoteError } from "./taskValidation";
import { effectiveModelForOperation, usesGenerationSettings } from "./taskValidation";
import { samplersFor, defaultNoiseSchedule, noiseSchedulesFor } from "./modelSettings";
import { ucOptions, presetLabels, hasFurryTag, removeFurryTag, mapUcPreset } from "./promptPresets";
import PromptChunks from "./PromptChunks";
import AdvancedSettings from "./AdvancedSettings";
import TokenMeter from "./TokenMeter";
import TagInput from "./TagInput";
import type { TagSuggestion } from "./TagInput";
import NaiSelect from "./NaiSelect";
import { composePrompts } from "./promptPresets";

type Props = {
  draft: Draft;
  patch: (value: Partial<Draft>) => void;
  setParam: (key: string, value: unknown) => void;
  models: Capabilities["models"];
  operations?: Operation[];
  user: User;
  isMock: boolean;
  busy: boolean;
  pending: number;
  quote: {
    units: number;
    generation_units?: number;
    encoding_units?: number;
    unit_label: string;
    verified: boolean;
    message: string;
  } | null;
  quoteError?: QuoteError | null;
  configurationIssue?: ConfigurationIssue;
  blankCanvasSignal?: number;
  quoteRequest: () => void;
  submit: () => void;
  characters: ReactNode;
  references: ReactNode;
  rows: LocalImage[];
  selected?: LocalImage;
  select: (row: LocalImage) => void;
  renderImage: (row: LocalImage) => ReactNode;
  preview?: { image: string; media_type: string; step?: number };
  onLibrary: () => void;
  onNegativeLibrary: () => void;
  onFinal: () => void;
  onQueue: () => void;
  onPage: (page: "draw" | "batch" | "gallery" | "settings") => void;
  mobile: "edit" | "result";
  onMobileChange: (view: "edit" | "result") => void;
  onEnlarge: () => void;
  onReuse: () => void;
  onEditSelected: (row: LocalImage) => void;
  onPixelSelected: (row: LocalImage) => void;
  onUseAs: (operation: "img2img" | "vibe" | "character" | "inpaint" | "upscale" | "augment") => void;
  onSave: () => void;
  onSuggestTags?: (model: string, fragment: string) => Promise<TagSuggestion[]>;
};

// Display newest models first without changing the service list or selected model.
const modelDisplayOrder = new Map([
  ["nai-diffusion-5-full", 0],
  ["nai-diffusion-5-curated", 1],
  ["nai-diffusion-4-5-full", 2],
  ["nai-diffusion-4-5-curated", 3],
  ["nai-diffusion-4-full", 4],
  ["nai-diffusion-4-curated-preview", 5],
  ["nai-diffusion-3", 6],
  ["nai-diffusion-furry-3", 7],
]);

function modelDescription(modelId: string): string | undefined {
  const version = modelId.startsWith("nai-diffusion-5") ? "V5"
    : modelId.startsWith("nai-diffusion-4-5") ? "V4.5"
    : modelId.startsWith("nai-diffusion-4") ? "V4"
    : modelId.endsWith("-3") ? "V3" : undefined;
  if (!version) return undefined;
  const edition = modelId.includes("curated-preview") ? "精选版预览"
    : modelId.includes("curated") ? "精选版"
    : modelId.includes("full") ? "完整版" : undefined;
  return edition ? `${version} · ${edition}` : version;
}

// Verified against the official resolution menu; wallpaper has no square preset.
const resolutionPresets: Record<string, {label:string; sizes:number[][]}> = {
  normal:{label:"标准",sizes:[[832,1216],[1024,1024],[1216,832]]},
  large:{label:"大图",sizes:[[1024,1536],[1472,1472],[1536,1024]]},
  wallpaper:{label:"壁纸",sizes:[[1088,1920],[1920,1088]]},
  small:{label:"小图",sizes:[[512,768],[640,640],[768,512]]},
};
export default function OfficialWorkspace(p: Props) {
  const displayModels = [...p.models].sort((a, b) =>
    (modelDisplayOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
    (modelDisplayOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const [promptTab, setPromptTab] = useState<"positive" | "negative">("positive");
  const [history, setHistory] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [auxiliary, setAuxiliary] = useState(false);
  const [promptTools, setPromptTools] = useState(false);
  const [panel, setPanel] = useState<"characters" | null>(null);
  const mobile = p.mobile;
  const setMobile = p.onMobileChange;
  const [welcome, setWelcome] = useState(false);
  const [showSource, setShowSource] = useState(Boolean(p.draft.parameters.image));
  const displayedSelectedId = useRef(p.selected?.id);
  useEffect(() => { setShowSource(Boolean(p.draft.parameters.image)); }, [p.draft.parameters.image]);
  useEffect(() => {
    if (displayedSelectedId.current !== p.selected?.id) {
      displayedSelectedId.current = p.selected?.id;
      setShowSource(false);
    }
  }, [p.selected?.id]);
  const lastBlankSignal = useRef(p.blankCanvasSignal);
  const params = p.draft.parameters;
  const composedPrompt = composePrompts(p.draft, p.draft.prompt, p.draft);
  const enabledCharacters = params.character_prompts.filter(character => character.enabled !== false);
  const [customSize,setCustomSize] = useState(false);
  const resolutionGroup = customSize ? "custom" : Object.keys(resolutionPresets).find(key => resolutionPresets[key].sizes.some(([w,h]) => w===params.width && h===params.height)) ?? "custom";
  const customSizes = params.width === params.height
    ? [[params.width, params.height]]
    : [[params.width, params.height], [params.height, params.width]];
  const generation = usesGenerationSettings(p.draft.operation);
  const effectiveModel = effectiveModelForOperation(p.draft.model, p.draft.operation);
  const samplers = samplersFor(effectiveModel);
  const furryMode = p.draft.model.endsWith('-3')
    ? p.draft.model.includes('furry')
    : Boolean(p.draft.furryMode || hasFurryTag(p.draft.prompt));
  // Gate's tag route accepts a model, but not V5's extra furryv5 type field.
  const tagModel = furryMode && !p.draft.model.startsWith('nai-diffusion-5')
    ? 'nai-diffusion-furry-3' : p.draft.model;
  const tagSuggestionsUnavailable = p.draft.model.startsWith('nai-diffusion-5') && furryMode;
  function selectModel(model: string) {
    const nextEffectiveModel = effectiveModelForOperation(model, p.draft.operation);
    const sampler = samplersFor(nextEffectiveModel).some(([id]) => id === params.sampler)
      ? params.sampler : 'k_euler_ancestral';
    const noiseSchedule = sampler === params.sampler &&
      noiseSchedulesFor(nextEffectiveModel, sampler).includes(String(params.noise_schedule))
      ? params.noise_schedule : defaultNoiseSchedule(sampler);
    // V3's Anime/Furry choice is part of the model ID. Other families use a
    // prompt mode; a stale flag must never make Anime V3 display as Furry.
    p.patch({
      model,
      furryMode: !model.endsWith('-3') && furryMode,
      parameters: {
        ...params, sampler, noise_schedule: noiseSchedule,
        skip_cfg_above_sigma: Number(params.skip_cfg_above_sigma) > 0 && !nextEffectiveModel.startsWith('nai-diffusion-5')
          ? (nextEffectiveModel.startsWith('nai-diffusion-4-5') ? 58 : 19) : null,
      },
      qualityPreset: p.draft.qualityPreset === 'light' && !model.startsWith('nai-diffusion-5')
        ? 'standard' : p.draft.qualityPreset,
      ucPreset: mapUcPreset(p.draft.model, p.draft.ucPreset, model),
    });
  }
  function selectSampler(sampler: string) {
    if (!samplersFor(effectiveModel).some(([id]) => id === sampler)) return;
    p.patch({ parameters: { ...params, sampler, noise_schedule: defaultNoiseSchedule(sampler) } });
  }
  const blocked = Boolean(p.configurationIssue || (p.quoteError && !p.quoteError.retryable));
  function showConfiguration() {
    const target = p.configurationIssue?.target ?? 'settings';
    setMobile('edit');
    if (target === 'characters') setPanel('characters');
    else if (target === 'settings') setAdvanced(true);
    // Uploaded references stay expanded in their own cards.
    requestAnimationFrame(() => document.getElementById((target === 'settings' ? 'nai-generation-settings' : `nai-${target}-settings`))?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
  const selected = welcome ? undefined : p.selected;
  useEffect(() => {
    setWelcome(false);
  }, [p.selected?.id, p.preview]);
  useEffect(() => {
    if (p.blankCanvasSignal !== lastBlankSignal.current) {
      lastBlankSignal.current = p.blankCanvasSignal;
      setWelcome(true);
    }
  }, [p.blankCanvasSignal]);
  const transparent = hasTransparentBackground(p.draft.prompt);
  const supportsTransparency = effectiveModel.startsWith("nai-diffusion-5");
  const canUseResult = Boolean(selected) && !p.preview && !showSource;
  const quoteUnits = p.quote ? (p.quote.generation_units ?? p.quote.units) * p.draft.count + (p.quote.encoding_units ?? 0) : 0;
  const usesV5 = Boolean(p.quote?.unit_label.includes("V5"));
  const quoteLabel = usesV5 ? `${quoteUnits} 次 V5` : `${quoteUnits} 积分`;
  const quoteTitle = p.quote
    ? `预计消耗：${quoteLabel}；实际以 Gate 最终结算为准。${p.quote.message ? ` ${p.quote.message}` : ""}`
    : p.isMock ? "模拟生成；当前不会估算实际消耗。"
    : p.quoteError ? `消耗估算失败：${p.quoteError.message}` : "正在估算消耗";
  const buttonQuoteLabel = p.quote && !p.quote.verified ? `约 ${quoteLabel}` : quoteLabel;
  const encodingUnits = p.quote?.encoding_units ?? 0;
  const modelOptions = [
    ...displayModels.filter(model => model.id.startsWith("nai-diffusion-5")).map(model => ({
      value: model.id,
      label: model.name.replace(/^NAI Diffusion /, ""),
      description: modelDescription(model.id),
      group: "新模型",
    })),
    ...displayModels.filter(model => !model.id.startsWith("nai-diffusion-5")).map(model => ({
      value: model.id,
      label: model.name.replace(/^NAI Diffusion /, ""),
      description: modelDescription(model.id),
      group: "旧版模型",
    })),
    ...(!p.models.some(model => model.id === p.draft.model) ? [{
      value: p.draft.model,
      label: p.draft.model,
      group: "当前模型",
      disabled: true,
    }] : []),
  ];
  const number = (
    label: string,
    value: number,
    action: (value: number) => void,
    min: number,
    max: number,
    step = 1,
  ) => (
    <input
      aria-label={label}
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        if (e.target.value !== "" && Number.isFinite(+e.target.value))
          action(+e.target.value);
      }}
    />
  );
  const navigate = (page: "draw" | "batch" | "gallery" | "settings") => {
    p.onPage(page);
  };
  const size = (width: number, height: number) =>
    p.patch({ parameters: { ...params, width, height } });
  function toggleMode() {
    const furry = !furryMode;
    if (p.draft.model.endsWith('-3')) selectModel(furry ? 'nai-diffusion-furry-3' : 'nai-diffusion-3');
    else p.patch({furryMode:furry,...(!furry ? {
      prompt:removeFurryTag(p.draft.prompt),
    } : {})});
  }
  return (
    <main className={`nai-shell mobile-${mobile}`} >
      <div className="nai-mobile-switch">
        <button
          className={mobile === "edit" ? "active" : ""}
          onClick={() => setMobile("edit")}
        >
          编辑
        </button>
        <button
          className={mobile === "result" ? "active" : ""}
          onClick={() => setMobile("result")}
        >
          结果 {p.rows.length || ""}
        </button>
      </div>
      <aside className="nai-sidebar">
        <div className="nai-scroll">
          {generation && <>
          <div className="nai-model-row">
            <div className="nai-model-control">
              <span>模型</span>
              <NaiSelect
                ariaLabel="模型"
                className="nai-model-select"
                value={p.draft.model}
                options={modelOptions}
                onChange={selectModel}
                menuWidth={300}
              />
            </div>
            <div className="nai-mode-label">
              <span>模式</span>
              <button className="nai-anime-mode" aria-label={`绘图模式：${furryMode ? 'Furry' : '动漫'}，点击切换`} title="切换动漫 / Furry 模式" onClick={toggleMode}>
                {furryMode ? <PawPrint size={16}/> : <Sun size={16}/>} {furryMode ? 'Furry' : '动漫'}
              </button>
            </div>
          </div>
          <div className="nai-prompt-card">
            {p.draft.promptLayout === "tabs" && <div className="nai-prompt-tabs"><button aria-pressed={promptTab === "positive"} onClick={()=>setPromptTab("positive")}>正面</button><button aria-pressed={promptTab === "negative"} onClick={()=>setPromptTab("negative")}>负面</button></div>}
            <section className="nai-prompt-section" hidden={p.draft.promptLayout === "tabs" && promptTab !== "positive"}>
              <div className="nai-card-heading">
                <b>提示词</b>
                <div>
                  <button aria-label="提示词工具" title="预设、辅助提示词与显示方式" aria-expanded={promptTools} onClick={()=>setPromptTools(!promptTools)}><Settings2 size={17}/></button>
                </div>
              </div>
              <TagInput label="主提示词" value={p.draft.prompt}
                onChange={value=>p.patch({prompt:value})} model={tagModel}
                disabled={p.draft.tagSuggestionsDisabled || tagSuggestionsUnavailable} suggest={p.onSuggestTags}/>
              <div className="nai-prompt-options">
                {supportsTransparency ? <button
                  className="nai-transparent"
                  aria-pressed={transparent}
                  disabled={!supportsTransparency}
                  title={supportsTransparency ? "在当前生效提示词中启用透明背景" : "透明背景需要 V5 模型"}
                  onClick={() => p.patch({prompt:setTransparentBackground(p.draft.prompt,!transparent)})}
                >
                  {transparent ? <Check size={12} /> : <X size={12} />}
                  透明背景
                </button> : <span/>}
                <div className="nai-prompt-select-group">
                  <NaiSelect
                    ariaLabel="质量预设"
                    triggerPrefix="质量预设"
                    className="nai-preset-select nai-quality-select"
                    value={p.draft.qualityPreset ?? "none"}
                    options={[
                      { value: "none", label: "无" },
                      { value: "standard", label: "标准" },
                      ...(supportsTransparency ? [{ value: "light", label: "轻量" }] : []),
                    ]}
                    onChange={qualityPreset => p.patch({ qualityPreset: qualityPreset as "none" | "standard" | "light" })}
                    menuWidth={150}
                  />
                </div>
              </div>
              <TokenMeter compact model={effectiveModel} label="正面" text={composedPrompt.prompt} characterTexts={enabledCharacters.map(character => character.prompt)} />
            </section>
            <section className="nai-negative-section" hidden={p.draft.promptLayout === "tabs" && promptTab !== "negative"}>
              <div className="nai-card-heading">
                <b>负面提示词</b>
                <div>
                  <button aria-label="选择负面提示词预设" onClick={p.onNegativeLibrary}>
                    <SlidersHorizontal size={16} />
                  </button>
                  {p.draft.promptLayout === "tabs" && <button aria-label="提示词工具" title="预设、辅助提示词与显示方式" aria-expanded={promptTools} onClick={()=>setPromptTools(!promptTools)}><Settings2 size={17}/></button>}
                </div>
              </div>
              <TagInput label="负面提示词" value={p.draft.negative}
                onChange={value=>p.patch({negative:value})} model={tagModel}
                disabled={p.draft.tagSuggestionsDisabled || tagSuggestionsUnavailable} suggest={p.onSuggestTags}/>
              <div className="nai-prompt-options">
                <span />
                <div className="nai-prompt-select-group">
                  <NaiSelect
                    ariaLabel="负面内容预设"
                    triggerPrefix="负面预设"
                    className="nai-preset-select nai-uc-select"
                    value={p.draft.ucPreset ?? "none"}
                    options={Object.keys(ucOptions(p.draft.model)).map(id => ({ value: id, label: presetLabels[id] ?? id }))}
                    onChange={ucPreset => p.patch({ ucPreset })}
                    menuWidth={170}
                  />
                </div>
              </div>
              <TokenMeter compact model={effectiveModel} label="负面" text={composedPrompt.negative} characterTexts={enabledCharacters.map(character => character.negative_prompt)} />
            </section>
          </div>
          {promptTools && <div className="nai-prompt-tools">
            <div className="nai-prompt-tool-actions"><button onClick={p.onLibrary}><FolderOpen size={15}/>提示词预设</button><button onClick={p.onFinal}>查看最终提示词</button><button onClick={()=>p.patch({promptLayout:p.draft.promptLayout === "tabs" ? "split" : "tabs"})}>{p.draft.promptLayout === "tabs" ? "分开展示正负提示词" : "合并为标签页"}</button></div>
          <details
            className="nai-auxiliary"
            open={auxiliary}
            onToggle={(e) => setAuxiliary(e.currentTarget.open)}
          >
            <summary>
              辅助提示词{p.draft.artist || p.draft.quality ? " · 已启用" : ""}
              <ChevronDown size={13} />
            </summary>
            <label>
              画师串
              <textarea
                aria-label="画师串"
                rows={2}
                value={p.draft.artist}
                onChange={(e) => p.patch({ artist: e.target.value })}
              />
            </label>
            <label>
              质量串
              <textarea
                aria-label="质量串"
                rows={2}
                value={p.draft.quality}
                onChange={(e) => p.patch({ quality: e.target.value })}
              />
            </label>
            <button onClick={p.onFinal}>查看合并后的提示词</button>
          </details>
          <PromptChunks draft={p.draft} patch={p.patch} tagSuggestionsUnavailable={tagSuggestionsUnavailable || !p.onSuggestTags}/>
          </div>}
          <div className="nai-feature-card">
            <div>
              <b>角色提示词</b>
              <p>为画面中的每个角色单独设置提示词。</p>
            </div>
            <button
              aria-label="添加角色提示词"
              disabled={
                params.character_prompts.length >=
                (p.models.find((m) => m.id === effectiveModel)?.max_characters ??
                  6)
              }
              onClick={() => {
                p.setParam("character_prompts", [
                  ...params.character_prompts,
                  { prompt: "", negative_prompt: "", x: 0.5, y: 0.5 },
                ]);
                setPanel("characters");
              }}
            >
              <Plus size={24} />
            </button>
          </div>
          {params.character_prompts.length > 0 && (
            <button
              className="nai-feature-toggle"
              aria-expanded={panel === "characters"}
              onClick={() =>
                setPanel(panel === "characters" ? null : "characters")
              }
            >
              {params.character_prompts.length} 个角色
              <ChevronDown size={14} />
            </button>
          )}
          {panel === "characters" && (
            <div id="nai-characters-settings" className="nai-expanded-panel">{p.characters}</div>
          )}
          </>}
          {!generation && <section className="nai-prompt-card"><h2>{labels[p.draft.operation]}</h2><button onClick={p.onFinal}>查看发送内容</button></section>}
          {p.references}
          <section id="nai-generation-settings" className="nai-resolution">
            {generation && <>
            <h2>图像设置</h2>
            <div className="nai-resolution-heading">
              <b>分辨率</b>
              <div>
                {number(
                  "图片宽度",
                  params.width,
                  (n) => p.setParam("width", n),
                  64,
                  4096,
                  64,
                )}
                <button
                  aria-label="交换宽高"
                  onClick={() => size(params.height, params.width)}
                >
                  <ArrowLeftRight size={13} />
                </button>
                {number(
                  "图片高度",
                  params.height,
                  (n) => p.setParam("height", n),
                  64,
                  4096,
                  64,
                )}
              </div>
            </div>
            <div className="nai-size-row">
              <NaiSelect
                ariaLabel="分辨率档位"
                className="nai-resolution-select"
                value={resolutionGroup}
                options={[
                  ...Object.entries(resolutionPresets).map(([id, preset]) => ({ value: id, label: preset.label })),
                  { value: "custom", label: "自定义" },
                ]}
                onChange={group => {
                  setCustomSize(group === 'custom');
                  const preset=resolutionPresets[group];
                  if(preset) { const [w,h]=preset.sizes.find(([w,h]) => params.width===params.height ? w===h : params.width>params.height ? w>h : w<h) ?? preset.sizes[0]; size(w,h); }
                }}
                menuWidth={150}
              />
              {(resolutionPresets[resolutionGroup]?.sizes ?? customSizes).map(([w,h],i) => (
                <button key={i} aria-label={`${w} × ${h}`} title={`${w} × ${h}`} aria-pressed={params.width === w && params.height === h} onClick={()=>size(w,h)}>
                  <span className={`nai-aspect ${w<h?'portrait':w===h?'square':'landscape'}`}/>
                </button>
              ))}
            </div>
            </>}
            {!generation && <p>处理源图片的实际尺寸；通用采样参数不参与此操作。</p>}
            <label className="nai-count-label">
              生成张数
              {number(
                "生成张数",
                p.draft.count,
                (n) => p.patch({ count: Math.min(20, Math.max(1, Math.trunc(n))) }),
                1,
                20,
              )}
            </label>
            <div className="nai-image-count">
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  aria-label={`生成 ${n} 张`}
                  aria-pressed={p.draft.count === n}
                  onClick={() => p.patch({ count: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </section>
        </div>
        <footer className="nai-footer">
          {advanced && generation && (
            <div className="nai-advanced">
              <label>
                步数
                {number(
                  "完整步数",
                  params.steps,
                  (n) => p.setParam("steps", n),
                  1,
                  50,
                )}
              </label>
              <label>
                提示词引导
                {number(
                  "完整提示词引导",
                  params.scale,
                  (n) => p.setParam("scale", n),
                  0,
                  20,
                  0.1,
                )}
              </label>
              <label>
                种子
                {number(
                  "完整种子",
                  params.seed,
                  (n) => p.setParam("seed", n),
                  -1,
                  4294967295,
                )}
              </label>
              <label>
                采样器
                <select
                  aria-label="采样器"
                  value={params.sampler}
                  onChange={(e) => selectSampler(e.target.value)}
                >
                  {!samplers.some(([id]) => id === params.sampler) && <option value={params.sampler}>{params.sampler}（请更换）</option>}
                  {samplers.map(([id, name]) => (
                    <option value={id} key={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <AdvancedSettings model={effectiveModel} params={params} patch={changes => p.patch({parameters:{...params,...changes}})}/>
              <label className="nai-stream">
                <input
                  type="checkbox"
                  checked={params.stream === true}
                  onChange={(e) => p.setParam("stream", e.target.checked)}
                />
                流式预览
              </label>
            </div>
          )}
          {generation && <div className="nai-parameter-summary">
            <label>
              步数
              {number(
                "步数",
                params.steps,
                (n) => p.setParam("steps", n),
                1,
                50,
              )}
            </label>
            <label>
              引导
              {number(
                "提示词引导",
                params.scale,
                (n) => p.setParam("scale", n),
                0,
                20,
                0.1,
              )}
            </label>
            <div>
              <span>种子</span>
              {params.seed < 0 ? (
                <button
                  aria-label="随机种子，点击设置"
                  onClick={() => setAdvanced(!advanced)}
                >
                  <Sprout size={16} />
                </button>
              ) : (
                <button
                  className="nai-seed-value"
                  title={String(params.seed)}
                  onClick={() => setAdvanced(!advanced)}
                >
                  {params.seed}
                </button>
              )}
            </div>
            <div>
              <span>采样器</span>
              <NaiSelect
                ariaLabel="采样器"
                className="nai-sampler-select"
                value={params.sampler}
                options={[
                  ...(!samplers.some(([id]) => id === params.sampler) ? [{ value: params.sampler, label: `${params.sampler}（请更换）`, disabled: true }] : []),
                  ...samplers.map(([id, name]) => ({ value: id, label: name })),
                ]}
                onChange={selectSampler}
                menuWidth={230}
              />
            </div>
            <button
              className="nai-expand-settings"
              aria-label={advanced ? "收起生成参数" : "展开生成参数"}
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              <ChevronRight size={23} />
            </button>
          </div>
          }
          <button className="nai-generate" title={quoteTitle} disabled={p.busy || blocked} onClick={p.submit}>
            <strong>
              {p.busy ? <LoaderCircle size={17} className="spin" /> : null}
              {p.draft.operation === "generate"
                ? `生成 ${p.draft.count} 张图片`
                : `${labels[p.draft.operation]} · ${p.draft.count} 张`}
            </strong>
            <span className="nai-cost">
              {blocked ? "需调整设置" : p.isMock ? "模拟" : p.quote ? <>{usesV5 ? <Images size={13} /> : <Coins size={13} />}{buttonQuoteLabel}</> : p.quoteError ? "估算失败" : "估算中"}
            </span>
          </button>
          {p.configurationIssue ? (
            <div className="nai-estimate has-error configuration-issue" role="status">
              <span>{p.configurationIssue.message}</span>
              <div>
                {p.configurationIssue.suggestedModel && <button onClick={() => p.patch({ model: p.configurationIssue!.suggestedModel })}>切换至 V4.5</button>}
                <button onClick={showConfiguration}>{p.configurationIssue.target === 'references' ? '查看图像与参考设置' : '检查生成设置'}</button>
              </div>
            </div>
          ) : !p.isMock && p.quoteError ? (
            <div className="nai-estimate has-error">
              <span role="status">{p.quoteError.message}</span>
              {p.quoteError.retryable ? <button onClick={p.quoteRequest}>重试估算</button> : p.quoteError.connection ? <button onClick={() => p.onPage("settings")}>检查连接</button> : <button onClick={showConfiguration}>检查设置</button>}
            </div>
          ) : !p.isMock && p.quote ? (
            encodingUnits > 0 ? <div className="nai-estimate nai-encoding-estimate" role="note">预计首次 Vibe 编码增加 {encodingUnits} 积分，已计入按钮金额</div> : null
          ) : !p.isMock ? (
            <div className="nai-estimate"><span>正在估算消耗…</span></div>
          ) : null}
        </footer>
      </aside>
      <section className="nai-main">
        {!history && (
          <button
            className="nai-open-history"
            aria-label="打开历史记录"
            onClick={() => setHistory(true)}
          >
            <Clock size={25} />
          </button>
        )}
        {p.pending > 0 && (
          <button className="nai-queue-indicator" onClick={p.onQueue}>
            <LoaderCircle size={14} className="spin" />
            {p.pending} 项任务
          </button>
        )}
        {showSource && params.image && !p.preview ? (
          <><div className="nai-stage"><img src={`data:image/png;base64,${params.image}`} alt="当前源图片"/><span className="nai-output-label">当前源图片</span></div>{selected && <button onClick={() => setShowSource(false)}>查看生成结果</button>}</>
        ) : selected || p.preview ? (
          <>
            <div className={`nai-stage${!generation && params.image && !p.preview ? " tool-comparison" : ""}`} onDoubleClick={canUseResult ? p.onEnlarge : undefined}>
              {!generation && params.image && !p.preview && <img src={`data:image/png;base64,${params.image}`} alt="处理前源图片"/>}
              {p.preview ? <img src={`data:${p.preview.media_type};base64,${p.preview.image}`} alt="生成中的临时预览"/> : selected && p.renderImage(selected)}
              {p.preview && <span className="nai-output-label">生成中{p.preview.step ? ` · ${p.preview.step}` : ""}</span>}
              {selected?.result.metadata.mock === true && !p.preview && <span className="nai-output-label">模拟输出 · 不是真实生图</span>}
            </div>
            <div className="nai-image-actions" aria-label={p.preview ? "等待最终图片后可操作" : "图片操作"}>
              <button disabled={!canUseResult} onClick={p.onEnlarge} aria-label="放大查看">
                <Expand size={17} />
              </button>
              <button disabled={!canUseResult} onClick={() => selected && p.onEditSelected(selected)}>
                <Paintbrush size={16} />
                画布编辑
              </button>
              <button disabled={!canUseResult} onClick={() => selected && p.onPixelSelected(selected)}>
                本地像素整理
              </button>
              <button disabled={!canUseResult} onClick={() => p.onUseAs("img2img")}>用作图生图</button>
              <button disabled={!canUseResult || p.models.find(m => m.id === effectiveModel)?.vibe_transfer === false} onClick={() => p.onUseAs("vibe")}>用作 Vibe</button>
              <button disabled={!canUseResult || p.models.find(m => m.id === effectiveModel)?.precise_reference !== true} onClick={() => p.onUseAs("character")}>用作精准参考</button>
              <button disabled={!canUseResult} onClick={p.onReuse}>
                <SlidersHorizontal size={16} />
                回填
              </button>
              <button disabled={!canUseResult || Boolean(p.operations && !p.operations.includes("inpaint"))} onClick={() => p.onUseAs("inpaint")}>
                <Paintbrush size={16} />
                重绘
              </button>
              <button disabled={!canUseResult || Boolean(p.operations && !p.operations.includes('upscale'))} title="2 倍放大" onClick={() => p.onUseAs("upscale")}>
                <Expand size={16} />
                放大
              </button>
              <button disabled={!canUseResult || Boolean(p.operations && !p.operations.includes('augment'))} title="线稿、上色、表情与背景等处理" onClick={() => p.onUseAs("augment")}>
                <Settings2 size={16} />
                导演工具
              </button>
              <button disabled={!canUseResult} onClick={p.onSave}>
                <Download size={16} />
                保存
              </button>
            </div>
          </>
        ) : (
          <div
            className="nai-empty-canvas"
            role="img"
            aria-label="空白画布，生成的图片将显示在这里"
          />
        )}
      </section>
      {history && (
        <aside className="nai-history">
          <div className="nai-history-heading">
            <b>历史记录</b>
            <button aria-label="收起历史记录" onClick={() => setHistory(false)}>
              <ChevronRight size={20} />
            </button>
          </div>
          <div className="nai-history-strip">
            {p.rows.slice(0, 40).map((row) => (
              <button
                key={row.id}
                aria-label={`查看 ${row.job.label} ${row.id.slice(0, 6)}`}
                className={selected?.id === row.id ? "selected" : ""}
                onClick={() => {
                  setWelcome(false);
                  p.select(row);
                }}
              >
                {p.renderImage(row)}
              </button>
            ))}
            {!p.rows.length && <p>生成的图片会显示在这里。</p>}
          </div>
          <button
            className="nai-history-gallery"
            onClick={() => navigate("gallery")}
          >
            <Grid2X2 size={16} />
            图库
          </button>
        </aside>
      )}
    </main>
  );
}
