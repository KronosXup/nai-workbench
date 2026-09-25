import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Download, ImagePlus, Layers2, MoreHorizontal, Paintbrush, Pencil, Plus, ScanFace, ScanLine, SquareArrowOutUpRight, SquareArrowUp, Trash2, Upload } from "lucide-react";
import type { Capabilities, Draft, Operation } from "./types";
import NaiSelect from "./NaiSelect";
import SourceImageMenu from "./SourceImageMenu";
import { effectiveModelForOperation, usesGenerationSettings } from "./taskValidation";
import "./referenceImages.css";

type Props = {
  draft: Draft;
  models: Capabilities["models"];
  operations?: Operation[];
  patch: (value: Partial<Draft>) => void;
  onUpload: (kind: "image" | "mask" | "vibe" | "character" | "inpaint" | "upscale", file: File) => void;
  onImport: () => void;
  onNewCanvas: () => void;
  onEditSource: () => void;
  onPixelSource: () => void;
  onMask: () => void;
  onImportVibe: (file: File) => void;
  onExportVibes: (indices: number[]) => void;
};

type MenuKind = "source" | "vibe" | null;

const referenceTypes = [
  { value: "character", label: "角色" },
  { value: "style", label: "风格" },
  { value: "character&style", label: "角色与风格" },
];

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clearFileInput(event: ChangeEvent<HTMLInputElement>, callback: (file: File) => void) {
  const file = event.currentTarget.files?.[0];
  if (file) callback(file);
  event.currentTarget.value = "";
}

function SliderField({
  label,
  ariaLabel = label,
  step = 0.01,
  value,
  onChange,
  disabled = false,
  className = "",
}: {
  label: string;
  ariaLabel?: string;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const safeValue = clamp01(value);
  return (
    <div className={`nai-ri-slider-field ${className}`}>
      <span className="nai-ri-slider-label">{label}</span>
      <span className="nai-ri-slider-controls">
        <input
          className="nai-ri-number"
          type="number"
          aria-label={ariaLabel}
          min={0}
          max={1}
          step={step}
          value={safeValue}
          disabled={disabled}
          onChange={event => { if (Number.isFinite(event.currentTarget.valueAsNumber)) onChange(clamp01(event.currentTarget.valueAsNumber)); }}
        />
        <input
          className="nai-ri-range"
          type="range"
          aria-label={`${ariaLabel}滑杆`}
          min={0}
          max={1}
          step={step}
          value={safeValue}
          disabled={disabled}
          onChange={event => { if (Number.isFinite(event.currentTarget.valueAsNumber)) onChange(clamp01(event.currentTarget.valueAsNumber)); }}
        />
      </span>
    </div>
  );
}

function MorePanel({ children }: { children: ReactNode }) {
  return <div className="nai-ri-more-panel">{children}</div>;
}

export default function ReferenceImages({
  draft,
  models,
  operations,
  patch,
  onUpload,
  onImport,
  onNewCanvas,
  onEditSource,
  onPixelSource,
  onMask,
  onImportVibe,
  onExportVibes,
}: Props) {
  const params = draft.parameters;
  const effectiveModel = effectiveModelForOperation(draft.model, draft.operation);
  const model = models.find(item => item.id === effectiveModel);
  const can = (operation: Operation) => !operations || operations.includes(operation);
  const vibeImages = params.reference_image_multiple;
  const characterImages = params.character_reference_images;
  const isGenerationOperation = usesGenerationSettings(draft.operation);
  const canVibe = !effectiveModel.startsWith("nai-diffusion-5") && model?.vibe_transfer !== false;
  const canCharacter = effectiveModel.startsWith("nai-diffusion-4-5") && model?.precise_reference !== false;
  const mixed = vibeImages.length > 0 && characterImages.length > 0;
  const vibeAddReason = !canVibe
    ? "当前模型不支持 Vibe 参考。"
    : characterImages.length > 0
      ? "Vibe 与精准参考不能混用。请先移除精准参考。"
      : vibeImages.length >= 16
        ? "Vibe 参考最多 16 项。"
        : "";
  const characterAddReason = !canCharacter
    ? "精准参考仅支持 V4.5。"
    : vibeImages.length > 0
      ? "Vibe 与精准参考不能混用。请先移除 Vibe。"
      : characterImages.length >= 16
        ? "精准参考最多 16 项。"
        : "";

  const [openMenu, setOpenMenu] = useState<MenuKind>(null);
  const sourceMenuId = useId();
  const sourceMenuTrigger = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const sourceInput = useRef<HTMLInputElement>(null);
  const maskInput = useRef<HTMLInputElement>(null);
  const vibeInput = useRef<HTMLInputElement>(null);
  const characterInput = useRef<HTMLInputElement>(null);
  const vibeFileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openMenu !== "vibe") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openMenu]);

  const updateStrength = (value: number) =>
    patch({ parameters: { ...params, strength: clamp01(value) } });
  const updateNoise = (value: number) =>
    patch({ parameters: { ...params, noise: clamp01(value) } });

  // Each reference's image and per-image settings share an index; remove them in one patch.
  const removeVibe = (index: number) => {
    const kept = vibeImages.map((_, i) => i).filter(i => i !== index);
    patch({
      parameters: {
        ...params,
        reference_image_multiple: kept.map(i => vibeImages[i]),
        reference_strength_multiple: kept.map(i => params.reference_strength_multiple[i] ?? 0.6),
        reference_information_extracted_multiple: kept.map(i => params.reference_information_extracted_multiple[i] ?? 1),
        vibe_files: kept.map(i => params.vibe_files?.[i] ?? null),
      },
    });
  };
  const removeCharacter = (index: number) => {
    const kept = characterImages.map((_, i) => i).filter(i => i !== index);
    patch({
      parameters: {
        ...params,
        character_reference_images: kept.map(i => characterImages[i]),
        character_reference_descriptions: kept.map(i => params.character_reference_descriptions?.[i] ?? "character"),
        character_reference_strengths: kept.map(i => params.character_reference_strengths?.[i] ?? 1),
        character_reference_fidelities: kept.map(i => params.character_reference_fidelities?.[i] ?? 1),
      },
    });
  };
  const updateCharacterType = (index: number, value: string) =>
    patch({
      parameters: {
        ...params,
        character_reference_descriptions: characterImages.map((_, i) =>
          i === index ? value : params.character_reference_descriptions?.[i] ?? "character",
        ),
      },
    });
  const updateCharacterNumber = (
    field: "character_reference_strengths" | "character_reference_fidelities",
    index: number,
    value: number,
  ) =>
    patch({
      parameters: {
        ...params,
        [field]: characterImages.map((_, i) =>
          i === index ? clamp01(value) : params[field]?.[i] ?? 1,
        ),
      },
    });
  const updateVibeNumber = (
    field: "reference_strength_multiple" | "reference_information_extracted_multiple",
    index: number,
    value: number,
  ) =>
    patch({
      parameters: {
        ...params,
        [field]: vibeImages.map((_, i) =>
          i === index ? clamp01(value) : params[field][i] ?? (field === "reference_strength_multiple" ? 0.6 : 1),
        ),
      },
    });

  const sourceActive = draft.operation === "img2img" || draft.operation === "inpaint";
  const sourceTitle = draft.operation === "upscale" ? "高清放大" : draft.operation === "inpaint" ? "局部重绘" : "图生图";
  const sourceDescription = !params.image && draft.operation !== "generate"
    ? "当前方式需要源图，请先上传图片。"
    : params.image && !sourceActive
      ? "源图已载入，启用图生图后才会用于本次生成。"
      : "以图片为起点，继续创作。";
  const sourceUploadKind = draft.operation === "inpaint" || draft.operation === "upscale" ? draft.operation : "image";
  const sourceCanUpload = can(sourceUploadKind === "image" ? "img2img" : sourceUploadKind);
  const sourceEnabledReason = sourceCanUpload ? "" : "当前服务未提供此图像操作。";
  const showVibe = vibeImages.length > 0 || characterImages.length === 0;

  return (
    <section id="nai-references-settings" className="nai-reference-images">
      <div className="nai-ri-section-heading">
        <h2>参考图像</h2>
        <button type="button" className="nai-ri-link" onClick={onImport}>导入图片 / 参数</button>
      </div>

      <section className={`nai-ri-card nai-ri-source-card${params.image ? " has-source" : ""}`} aria-label="图生图源图">
        <div className={`nai-ri-source-head${params.image ? " has-image" : " is-empty"}`}>
          {params.image
            ? <img className="nai-ri-source-thumb" src={`data:image/png;base64,${params.image}`} alt="图生图源图预览" />
            : <span className="nai-ri-empty-icon"><ImagePlus size={25} /></span>}
          <div className="nai-ri-source-copy">
            <div className="nai-ri-card-title-row">
              <b>{sourceTitle}</b>
              {params.image && draft.operation === "generate" && <span className="nai-ri-state">未启用</span>}
              {params.image && <button
                ref={sourceMenuTrigger}
                type="button"
                className="nai-ri-source-more"
                aria-label="源图更多操作"
                title="更多操作"
                aria-haspopup="menu"
                aria-controls={openMenu === "source" ? sourceMenuId : undefined}
                aria-expanded={openMenu === "source"}
                onClick={() => setOpenMenu(openMenu === "source" ? null : "source")}
                onKeyDown={event => {
                  if (event.key === "ArrowDown") { event.preventDefault(); setOpenMenu("source"); }
                }}
              ><MoreHorizontal size={17} /></button>}
            </div>
            {(!params.image || draft.operation === "generate") && <p>{sourceDescription}</p>}
          </div>
          {params.image ? (
            <div className="nai-ri-source-actions" aria-label="源图操作">
              <button
                type="button"
                className="nai-ri-compact-action"
                disabled={!can("inpaint")}
                title={can("inpaint") ? (draft.operation === "inpaint" ? "编辑重绘蒙版" : "局部重绘") : "当前服务未提供局部重绘"}
                onClick={onMask}
              ><ScanLine size={16} />{draft.operation === "inpaint" ? "重绘蒙版" : "局部重绘"}</button>
              <button type="button" className="nai-ri-icon-action" aria-label="编辑源图" title="绘制：编辑源图" onClick={onEditSource}><Pencil size={16} /></button>
              <button type="button" className="nai-ri-icon-action" aria-label="替换源图" title={sourceEnabledReason || "替换源图"} disabled={!sourceCanUpload} onClick={() => sourceInput.current?.click()}><SquareArrowUp size={16} /></button>
              <button
                type="button"
                className="nai-ri-icon-action nai-ri-remove-source"
                aria-label="移除源图"
                title="移除源图"
                onClick={() => { patch({ operation: "generate", parameters: { ...params, image: undefined, mask: undefined } }); setOpenMenu(null); }}
              ><Trash2 size={16} /></button>
            </div>
          ) : (
            <div className="nai-ri-source-actions nai-ri-source-empty-actions">
              <button type="button" aria-label="上传图生图源图" disabled={!sourceCanUpload} title={sourceEnabledReason || "上传图片"} onClick={() => sourceInput.current?.click()}><Upload size={20} /></button>
              <button type="button" aria-label="新建绘图画布" title="新建画布" onClick={onNewCanvas}><Paintbrush size={20} /></button>
            </div>
          )}
          <input
            ref={sourceInput}
            className="nai-ri-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="上传或替换图生图源图"
            disabled={!sourceCanUpload}
            onChange={event => clearFileInput(event, file => onUpload(sourceUploadKind, file))}
          />
        </div>

        {params.image && (
          <>
            {draft.operation === "generate" && (
              <div className="nai-ri-source-enable-row">
                <button
                  type="button"
                  disabled={!can("img2img")}
                  title={sourceEnabledReason || undefined}
                  onClick={() => patch({ operation: "img2img" })}
                >启用图生图</button>
              </div>
            )}
            {draft.operation === "inpaint" && (
              <div className="nai-ri-mask-state">
                <span>{params.mask ? "已有重绘蒙版" : "尚未设置重绘蒙版"}</span>
                <button type="button" disabled={!can("inpaint")} onClick={onMask}>{params.mask ? "重新编辑" : "绘制蒙版"}</button>
              </div>
            )}
            {draft.operation !== "upscale" ? <div className={`nai-ri-source-parameters${!sourceActive ? " is-disabled" : ""}`}>
              <SliderField label="变化强度" value={params.strength} onChange={updateStrength} disabled={!sourceActive} />
              <SliderField label="噪声" value={params.noise} onChange={updateNoise} disabled={!sourceActive} />
            </div> : <p className="nai-ri-upscale-info">放大倍数 <b>2 倍</b></p>}
            {openMenu === "source" && (
              <SourceImageMenu id={sourceMenuId} anchor={sourceMenuTrigger} onClose={closeMenu}>
                <button role="menuitem" type="button" disabled={!can("inpaint")} onClick={() => { setOpenMenu(null); sourceMenuTrigger.current?.focus(); maskInput.current?.click(); }}><Upload size={16} />上传蒙版</button>
                <button role="menuitem" type="button" onClick={() => { setOpenMenu(null); onPixelSource(); }}><ImagePlus size={16} />本地像素整理</button>
                {(params.mask || draft.operation === "inpaint" || draft.operation === "upscale") && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!can("img2img")}
                    onClick={() => {
                      patch({
                        operation: "img2img",
                        parameters: { ...params, mask: undefined },
                      });
                      setOpenMenu(null);
                      sourceMenuTrigger.current?.focus();
                    }}
                  >{params.mask ? "移除蒙版并切回图生图" : "切回图生图"}</button>
                )}
                <button role="menuitem" type="button" disabled={!can("upscale")} onClick={() => { patch({ operation: "upscale", parameters: { ...params, scale_factor: 2 } }); setOpenMenu(null); sourceMenuTrigger.current?.focus(); }}><SquareArrowOutUpRight size={16} />高清放大</button>
                <button role="menuitem" type="button" disabled={!can("generate")} onClick={() => { patch({ operation: "generate" }); setOpenMenu(null); sourceMenuTrigger.current?.focus(); }}>切回文生图</button>
              </SourceImageMenu>
            )}
            <input
              ref={maskInput}
              className="nai-ri-file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="上传重绘蒙版"
              onChange={event => clearFileInput(event, file => onUpload("mask", file))}
            />
          </>
        )}
        {!params.image && draft.operation !== "generate" && (
          <div className="nai-ri-source-missing-actions">
            <button type="button" disabled={!can("generate")} onClick={() => patch({ operation: "generate" })}>切回文生图</button>
          </div>
        )}
      </section>

      {isGenerationOperation && showVibe && (
        <section className="nai-ri-card nai-ri-reference-card" data-kind="vibe" aria-label="Vibe Transfer 参考">
          <div className={`nai-ri-reference-head${vibeImages.length ? " has-items" : " is-empty"}`}>
            <span className="nai-ri-empty-icon"><Layers2 size={20} /></span>
            <div className="nai-ri-reference-title">
              <b>Vibe Transfer{vibeImages.length ? ` · ${vibeImages.length}` : ""}</b>
              {vibeImages.length === 0 && <p>保留画面的氛围与特征。</p>}
            </div>
            <div className="nai-ri-reference-actions">
              <button
                type="button"
                disabled={Boolean(vibeAddReason)}
                aria-label="添加 Vibe 参考图片"
                title={vibeAddReason || "添加 Vibe 参考"}
                onClick={() => vibeInput.current?.click()}
              >{vibeImages.length ? <Plus size={20} /> : <Upload size={20} />}</button>
              <button type="button" aria-label="Vibe 更多操作" aria-expanded={openMenu === "vibe"} onClick={() => setOpenMenu(openMenu === "vibe" ? null : "vibe")}><MoreHorizontal size={16} /></button>
            </div>
            <input
              ref={vibeInput}
              className="nai-ri-file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="添加 Vibe 参考图片"
              disabled={Boolean(vibeAddReason)}
              onChange={event => clearFileInput(event, file => onUpload("vibe", file))}
            />
          </div>
          {vibeImages.length > 0 && (
            <div className="nai-ri-reference-list">
              {vibeImages.map((image, index) => {
                const encoding = params.vibe_files?.[index]?.type === "encoding";
                return (
                  <article className="nai-ri-reference-item" key={`vibe-${index}`}>
                    {encoding
                      ? <div className="nai-ri-encoding-thumb">已编码<br />Vibe</div>
                      : <img className="nai-ri-reference-thumb" src={`data:image/png;base64,${image}`} alt={`Vibe 参考 ${index + 1}`} />}
                    <div className="nai-ri-reference-item-actions">
                      <button type="button" className="nai-ri-small-action" aria-label={`移除 Vibe ${index + 1}`} title="移除" onClick={() => removeVibe(index)}><Trash2 size={15} /></button>
                      <button type="button" className="nai-ri-small-action" aria-label={`导出 Vibe ${index + 1}`} title="导出 Vibe 数据文件" onClick={() => onExportVibes([index])}><Download size={15} /></button>
                    </div>
                    <div className="nai-ri-reference-fields">
                      <SliderField label="信息提取" ariaLabel={`Vibe ${index + 1} 信息提取`} value={params.reference_information_extracted_multiple[index] ?? 1} disabled={encoding} onChange={value => updateVibeNumber("reference_information_extracted_multiple", index, value)} />
                      <SliderField label="参考强度" ariaLabel={`Vibe ${index + 1} 强度`} value={params.reference_strength_multiple[index] ?? 0.6} onChange={value => updateVibeNumber("reference_strength_multiple", index, value)} />
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {openMenu === "vibe" && (
            <MorePanel>
              <button type="button" disabled={Boolean(vibeAddReason)} title={vibeAddReason || undefined} onClick={() => { setOpenMenu(null); vibeFileInput.current?.click(); }}>导入 Vibe 文件 / PNG</button>
              {vibeImages.length > 1 && <button type="button" onClick={() => { setOpenMenu(null); onExportVibes(vibeImages.map((_, index) => index)); }}>导出合集</button>}
            </MorePanel>
          )}
          <input
            ref={vibeFileInput}
            className="nai-ri-file-input"
            type="file"
            accept=".naiv4vibe,.naiv4vibebundle,.png,application/json,image/png"
            aria-label="导入 Vibe 数据文件或 PNG"
            disabled={Boolean(vibeAddReason)}
            onChange={event => clearFileInput(event, onImportVibe)}
          />
        </section>
      )}

      {isGenerationOperation && <section className="nai-ri-card nai-ri-reference-card" data-kind="character" aria-label="精准参考">
        <div className={`nai-ri-reference-head${characterImages.length ? " has-items" : " is-empty"}`}>
          <span className="nai-ri-empty-icon"><ScanFace size={20} /></span>
          <div className="nai-ri-reference-title">
            <b>精准参考{characterImages.length ? ` · ${characterImages.length}` : ""}</b>
            {characterImages.length === 0 && <p>参考角色外观或画面风格。</p>}
          </div>
          <div className="nai-ri-reference-actions">
            <button
              type="button"
              disabled={Boolean(characterAddReason)}
              aria-label="添加精准参考图片"
              title={characterAddReason || "添加精准参考"}
              onClick={() => characterInput.current?.click()}
            >{characterImages.length ? <Plus size={20} /> : <Upload size={20} />}</button>
          </div>
          <input
            ref={characterInput}
            className="nai-ri-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="添加精准参考图片"
            disabled={Boolean(characterAddReason)}
            onChange={event => clearFileInput(event, file => onUpload("character", file))}
          />
        </div>
        {characterImages.length > 0 && (
          <div className="nai-ri-reference-list">
            {characterImages.map((image, index) => (
              <article className="nai-ri-reference-item" key={`character-${index}`}>
                <img className="nai-ri-reference-thumb" src={`data:image/png;base64,${image}`} alt={`精准参考 ${index + 1}`} />
                <div className="nai-ri-reference-item-actions">
                  <button type="button" className="nai-ri-small-action" aria-label={`移除精准参考 ${index + 1}`} title="移除" onClick={() => removeCharacter(index)}><Trash2 size={15} /></button>
                </div>
                <div className="nai-ri-reference-fields">
                  <label className="nai-ri-character-type">
                    <span>参考类型</span>
                    <NaiSelect
                      ariaLabel={`精准参考 ${index + 1} 类型`}
                      className="nai-ri-character-select"
                      value={params.character_reference_descriptions?.[index] ?? "character"}
                      options={referenceTypes}
                      onChange={value => updateCharacterType(index, value)}
                      menuWidth={190}
                    />
                  </label>
                  <SliderField label="参考强度" ariaLabel={`精准参考 ${index + 1} 强度`} step={0.05} value={params.character_reference_strengths?.[index] ?? 1} onChange={value => updateCharacterNumber("character_reference_strengths", index, value)} />
                  <SliderField label="保真度" ariaLabel={`精准参考 ${index + 1} 保真度`} step={0.05} value={params.character_reference_fidelities?.[index] ?? 1} onChange={value => updateCharacterNumber("character_reference_fidelities", index, value)} />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>}

      {isGenerationOperation && mixed && <p className="nai-ri-conflict-note" role="status">Vibe 与精准参考不能混用。移除其中一类后即可继续使用。</p>}
    </section>
  );
}
