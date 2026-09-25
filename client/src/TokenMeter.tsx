import { useEffect, useId, useMemo, useState } from "react";
import { countImageTokenSegments, imageTokenizer, imageTokenizerSpec } from "./imageTokenizer";
import type { Tokenizer } from "@huggingface/tokenizers";

type Props = {
  model: string;
  label: string;
  text: string;
  characterTexts?: string[];
  compact?: boolean;
};

export default function TokenMeter({ model, label, text, characterTexts = [], compact = false }: Props) {
  const tooltipId = useId();
  const spec = imageTokenizerSpec(model);
  const [loaded, setLoaded] = useState<{ kind: string; tokenizer: Tokenizer } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const hasText = Boolean(text || characterTexts.some(Boolean));
  const needsTokenizer = hasText || spec?.kind === "t5";

  useEffect(() => {
    if (!spec || !needsTokenizer) return;
    let current = true;
    setError(false);
    imageTokenizer(spec.kind).then(tokenizer => {
      if (current) { setLoaded({ kind: spec.kind, tokenizer }); setError(false); }
    }, () => {
      if (current) { setLoaded(null); setError(true); }
    });
    return () => { current = false; };
  }, [spec?.kind, needsTokenizer, retry]);

  // V3 checks every prompt-mix segment against its own limit. Character-prompt
  // models add all enabled character and prompt segments to their total.
  const counts = useMemo(() => {
    if (!loaded || loaded.kind !== spec?.kind || !needsTokenizer) return null;
    try {
      const ownSegments = countImageTokenSegments(loaded.tokenizer, text, spec.kind);
      const own = spec.kind === "clip" ? Math.max(...ownSegments) : ownSegments.reduce((sum, value) => sum + value, 0);
      const characters = characterTexts.reduce((sum, value) => sum + countImageTokenSegments(loaded.tokenizer, value, spec.kind).reduce((partSum, count) => partSum + count, 0), 0);
      return { own, total: own + characters, segments: ownSegments.length };
    } catch { return { own: 0, total: 0, failed: true }; }
  }, [loaded, spec?.kind, text, characterTexts, needsTokenizer]);

  if (!spec) return <small className="muted">{label} Token：当前模型暂无分词数据</small>;
  if (error) return <small className="muted">{label} Token：本地分词器加载失败 <button type="button" onClick={() => { setError(false); setRetry(n => n + 1); }}>重试</button></small>;
  if (counts?.failed) return <small className="muted">{label} Token：当前提示词无法分词</small>;
  if (needsTokenizer && !counts) return <small className="muted">{label} Token：正在载入 {spec.name} 分词器…</small>;

  const own = counts?.own ?? 0;
  const total = counts?.total ?? 0;
  const detail = `${label}提示词使用 ${own} Token，含角色共 ${total} Token，上限 ${spec.limit}。`;
  if (compact) return <div className={`nai-token-meter${total > spec.limit ? " is-over" : ""}`} tabIndex={0}
    role="progressbar" aria-label={`${label} Token 使用量`} aria-valuemin={0} aria-valuenow={Math.min(total, spec.limit)}
    aria-valuemax={spec.limit} aria-valuetext={detail} aria-describedby={tooltipId}>
    <span className="nai-token-track"><i style={{ width: `${Math.min(100, total / spec.limit * 100)}%` }} /></span>
    <span className="nai-token-tooltip" id={tooltipId} role="tooltip">{detail}{total > spec.limit ? " 超出上限，生成时可能截断。" : ""}{spec.kind === "clip" && (counts?.segments ?? 0) > 1 ? ` ${counts?.segments} 段提示词按最高段计数。` : ""}</span>
  </div>;
  return <div aria-live="polite" style={{ fontSize: 12, color: total > spec.limit ? "#e4a187" : "inherit" }}>
    <span>{label} {own} Token{characterTexts.length > 0 ? ` · 含角色共 ${total}` : ""} / {spec.limit}{spec.kind === "clip" && (counts?.segments ?? 0) > 1 ? ` · ${counts?.segments} 段取最高` : ""}{spec.kind === "clip" ? " · V3 待官网逐值核对" : ""}</span>
    <progress aria-label={`${label} Token 使用量`} value={Math.min(total, spec.limit)} max={spec.limit} style={{ display: "block", width: "100%", height: 4, marginTop: 5, accentColor: total > spec.limit ? "#e4a187" : "#e2d9a7" }} />
    {total > spec.limit && <span>超出模型提示词上限，生成时可能截断。</span>}
  </div>;
}
