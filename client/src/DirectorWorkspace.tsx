import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  Clock3,
  Download,
  Eraser,
  ImagePlus,
  LoaderCircle,
  Minus,
  Paintbrush,
  PencilLine,
  Plus,
  ScanFace,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { Api, ApiError } from "./api";
import { gateJobLabel } from "./GateQueueStatus";
import { directorEmotions, directorMatchesJob, directorSourceIssue, directorTask } from "./director";
import type { DirectorDraft, DirectorSource, DirectorTool } from "./director";
import type { Job, LocalImage, Operation, Task } from "./types";
import { configurationIssueFor } from "./taskValidation";
import * as local from "./storage";
import "./directorWorkspace.css";

type Quote = {
  units: number;
  generation_units?: number;
  unit_label?: string;
  verified: boolean;
  message: string;
};

type QuoteFailure = {
  message: string;
  retryable: boolean;
  connection: boolean;
  blocksSubmit: boolean;
};

type Props = {
  state: DirectorDraft;
  onChange: (patch: Partial<DirectorDraft>) => void;
  api: Api;
  operations?: Operation[];
  busy: boolean;
  rows: LocalImage[];
  jobs: Job[];
  onSubmit: (task: Task) => void;
  onUpload: (file: File) => void;
  onSelectResult: (row: LocalImage) => void;
  onUseResult: (row: LocalImage) => void;
  onContinue: (row: LocalImage) => void;
  onPixel: (source: DirectorSource) => void;
  renderImage: (row: LocalImage) => ReactNode;
};

const visibleTools: { id: "bg-removal" | "lineart" | "sketch" | "colorize" | "emotion" | "declutter"; label: string; Icon: typeof Sparkles }[] = [
  { id: "bg-removal", label: "去背景", Icon: WandSparkles },
  { id: "lineart", label: "线稿", Icon: PencilLine },
  { id: "sketch", label: "草图", Icon: Paintbrush },
  { id: "colorize", label: "上色", Icon: Sparkles },
  { id: "emotion", label: "表情", Icon: ScanFace },
  { id: "declutter", label: "清理", Icon: Eraser },
];

const defryLevels = ["正常", "稍弱", "较弱", "更弱", "很弱", "最弱"] as const;

const toolNames: Record<DirectorTool, string> = {
  "bg-removal": "去背景",
  lineart: "线稿",
  sketch: "草图",
  colorize: "上色",
  emotion: "表情",
  declutter: "清理",
  "declutter-keep-bubbles": "清理 · 保留气泡",
};

function currentIssue(task: Task, state: DirectorDraft, operations?: Operation[]) {
  return directorSourceIssue(state.source)
    ?? configurationIssueFor(task, [], operations)?.message
    ?? (!state.model.trim() ? "当前没有可用模型。" : undefined);
}

function quoteFailure(error: unknown): QuoteFailure {
  const message = error instanceof Error ? error.message : "报价暂时不可用。";
  if (error instanceof ApiError) {
    const connection = error.status === 401 || error.status === 403;
    const transient = error.status === 408 || error.status === 429 || error.status >= 500;
    return { message, connection, retryable: transient, blocksSubmit: !transient };
  }
  return { message, connection: false, retryable: true, blocksSubmit: false };
}

function jobStatusLabel(job: Job) {
  return (job.storage_mode === 'browser' && gateJobLabel(job)) ||
    ({ queued: "排队中", waiting: "等待服务", running: "处理中", succeeded: "已完成", failed: "失败", unknown: "结果待核对", cancelled: "已取消" })[job.status];
}

function EmptyPreviewIcon() {
  return <svg className="director-empty-image" viewBox="0 0 108 76" aria-hidden="true">
    <rect width="108" height="76" rx="12" fill="currentColor" />
    <path d="M17 60 37 36 49 50 66 27 92 60Z" fill="var(--director-card)" />
  </svg>;
}

export default function DirectorWorkspace(p: Props) {
  const { state } = p;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const quoteVersion = useRef(0);
  const [historyOpen, setHistoryOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 850);
  const [mobileShowSource, setMobileShowSource] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<QuoteFailure | null>(null);
  const [quoteRefresh, setQuoteRefresh] = useState(0);

  // A fresh quote follows only Director fields; drawing prompts and references never enter it.
  const stateKey = `${state.model}\u0000${state.tool}\u0000${state.prompt}\u0000${state.emotion}\u0000${state.defry}\u0000${state.source?.data ?? ""}\u0000${state.source?.width ?? 0}\u0000${state.source?.height ?? 0}`;
  const task = useMemo(() => directorTask(state), [stateKey]);
  const issue = currentIssue(task, state, p.operations);
  const selectedResult = state.resultId ? p.rows.find((row) => row.id === state.resultId) : undefined;
  const matchingJobs = p.jobs.filter((job) => directorMatchesJob(state, job));
  const pendingMatches = matchingJobs
    .filter((job) => ["queued", "waiting", "running", "unknown"].includes(job.status))
    .sort((a, b) => b.created_at - a.created_at);
  const matchingJob = pendingMatches[0] ?? matchingJobs.reduce<Job | undefined>(
    (latest, job) => !latest || job.created_at > latest.created_at ? job : latest,
    undefined,
  );
  const matchingPending = matchingJob && ["queued", "waiting", "running", "unknown"].includes(matchingJob.status);
  const matchingWorking = matchingJob && ["queued", "waiting", "running"].includes(matchingJob.status);
  const submitBlocked = Boolean(issue || quoteError?.blocksSubmit || matchingPending);

  useEffect(() => {
    const version = ++quoteVersion.current;
    setQuote(null);
    setQuoteError(null);
    if (issue) return () => {
      if (quoteVersion.current === version) quoteVersion.current++;
    };

    const timer = window.setTimeout(() => {
      void p.api.request<Quote>("/quote", directorTask(state)).then((value) => {
        if (quoteVersion.current !== version) return;
        setQuote(value);
        setQuoteError(null);
      }).catch((error: unknown) => {
        if (quoteVersion.current !== version) return;
        setQuote(null);
        setQuoteError(quoteFailure(error));
      });
    }, 350);

    return () => {
      window.clearTimeout(timer);
      if (quoteVersion.current === version) quoteVersion.current++;
    };
  // stateKey intentionally captures exactly the director inputs represented in directorTask.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.api, stateKey, issue, quoteRefresh]);

  useEffect(() => () => {
    quoteVersion.current++;
  }, []);

  function chooseTool(id: (typeof visibleTools)[number]["id"]) {
    const tool: DirectorTool = id === "declutter"
      ? state.tool === "declutter-keep-bubbles" ? "declutter-keep-bubbles" : "declutter"
      : id;
    p.onChange({ tool });
  }

  function chooseMobileTool(value: string) {
    if (value === "pixel") {
      if (sourceValid && state.source) p.onPixel(state.source);
      return;
    }
    if (visibleTools.some(({ id }) => id === value)) {
      chooseTool(value as (typeof visibleTools)[number]["id"]);
    }
  }

  function submit() {
    const currentTask = directorTask(state);
    if (currentIssue(currentTask, state, p.operations) || quoteError?.blocksSubmit || matchingPending) return;
    p.onSubmit(currentTask);
  }

  const sourceValid = Boolean(state.source && !directorSourceIssue(state.source));
  const sourceUrl = sourceValid && state.source ? `data:image/png;base64,${state.source.data}` : "";
  const hasPrompt = state.tool === "colorize" || state.tool === "emotion";
  const estimateLabel = issue
    ? "等待原图"
    : quoteError
      ? "报价失败"
      : quote
        ? `${quote.verified ? "" : "约 "}${quote.units} ${quote.unit_label || "积分"}`
        : "估算中…";

  return (
    <main className={`director-workspace${historyOpen ? " history-open" : " history-collapsed"}${mobileShowSource ? " mobile-show-source" : ""}`} aria-label="导演工具">
      <aside className="director-source-rail" aria-label="原图与上传">
        <button className="director-upload-button" type="button" aria-label={state.source ? "更换图片" : "上传图片"} onClick={() => fileInput.current?.click()}>
          <ImagePlus size={16} />
          <span>{state.source ? "更换图片" : "上传图片"}</span>
        </button>
        {sourceValid && state.source && <>
          <div className="director-source-thumb" aria-hidden="true">
            <img src={sourceUrl} alt="" />
          </div>
          <button className="director-mobile-source-thumb" type="button" aria-label={mobileShowSource ? "显示处理结果" : "查看原图"} onClick={() => setMobileShowSource((show) => !show)}>
            <img src={sourceUrl} alt="" />
            <span>{mobileShowSource ? "结果" : "原图"}</span>
          </button>
          <span className="director-source-size">{state.source.width} × {state.source.height}</span>
        </>}
      </aside>

      <section className="director-center" aria-label="图片预览与处理参数">
        <div className="director-stage" aria-label="原图与处理结果">
          <figure className="director-image-pane director-source-pane" aria-label="原图预览">
          <div className="director-image-frame">
            {sourceValid && state.source ? <img src={sourceUrl} alt="导演工具原图" /> : (
              <div className="director-empty">
                <EmptyPreviewIcon />
                <span className={state.source ? "" : "director-sr-only"}>{state.source ? issue || "原图不可用" : "尚未载入原图"}</span>
              </div>
            )}
            {sourceValid && state.source && <div className="director-frame-meta">{state.source.width} × {state.source.height}</div>}
          </div>
          </figure>

          <figure className="director-image-pane director-result-pane" aria-label="处理结果预览">
          <div className={`director-image-frame${selectedResult ? " has-result" : ""}`}>
            {selectedResult ? p.renderImage(selectedResult) : (
              <div className="director-empty director-result-empty">
                {matchingWorking ? <LoaderCircle size={25} className="director-spin" /> : <EmptyPreviewIcon />}
                <span className={matchingPending ? "" : "director-sr-only"}>{matchingJob?.status === "unknown" ? "结果待核对" : matchingWorking ? jobStatusLabel(matchingJob) : "处理结果"}</span>
                {matchingJob?.status === "failed" && <small>{matchingJob.error || "本次处理失败。"}</small>}
              </div>
            )}
            {selectedResult && <div className="director-result-overlay">
              <span className="director-result-name" title={selectedResult.result.filename}>{directorMatchesJob(state, selectedResult.job) ? "结果" : "上次结果"} · {toolNames[selectedResult.job.parameters.req_type as DirectorTool] || "图片处理"}</span>
              <div className="director-result-actions">
                <button type="button" title="下载 PNG" aria-label="下载结果 PNG" onClick={() => local.download(selectedResult.blob, selectedResult.result.filename || "director-result.png")}><Download size={14} /></button>
                <button type="button" onClick={() => p.onUseResult(selectedResult)}>图生图</button>
                <button type="button" onClick={() => p.onContinue(selectedResult)}>用作原图</button>
              </div>
            </div>}
          </div>
          </figure>
        </div>

        <footer className="director-controls" aria-label="工具和参数">
        {(hasPrompt || state.tool === "declutter" || state.tool === "declutter-keep-bubbles") && (
          <div className="director-detail-row">
            {state.tool === "emotion" && <p className="director-emotion-note">仅适用于动漫图片，建议从中性表情原图开始。</p>}
            {state.tool === "colorize" && <div className="director-colorize-field">
              <span className="director-field-title">Defry</span>
              <div className="director-defry-segments" role="group" aria-label="Defry">
                {[0, 1, 2, 3, 4, 5].map(value => <button key={value} type="button" className={state.defry === value ? "is-selected" : ""} aria-pressed={state.defry === value} onClick={() => p.onChange({ defry: value })}>{value}</button>)}
              </div>
            </div>}
            {state.tool === "emotion" && <div className="director-emotion-config">
              <div className="director-field-title director-emotion-title"><span>表情</span><b>{defryLevels[state.defry] || defryLevels[0]}</b></div>
              <label className="director-emotion-field">
                <select aria-label="表情" value={state.emotion} onChange={(event) => p.onChange({ emotion: event.target.value })}>
                  {directorEmotions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
              <div className="director-strength-field">
                <div className="director-strength-stepper" role="group" aria-label="表情强度">
                  {/* NovelAI's minus button moves toward weaker output; the stored Defry value advances 0 → 5 directly. */}
                  <button type="button" aria-label="减弱一档" title="减弱一档" disabled={state.defry >= 5} onClick={() => p.onChange({ defry: Math.min(5, state.defry + 1) })}><Minus size={14} /></button>
                  <button type="button" aria-label="增强一档" title="增强一档" disabled={state.defry <= 0} onClick={() => p.onChange({ defry: Math.max(0, state.defry - 1) })}><Plus size={14} /></button>
                </div>
              </div>
            </div>}
            {hasPrompt && <label className="director-prompt-field">
              <span>{state.tool === "colorize" ? "补充上色描述 · 可选" : "补充表情描述 · 可选"}</span>
              <textarea value={state.prompt} rows={1} onChange={(event) => p.onChange({ prompt: event.target.value })} />
            </label>}
            {(state.tool === "declutter" || state.tool === "declutter-keep-bubbles") && <label className="director-bubbles-field">
              <input type="checkbox" checked={state.tool === "declutter-keep-bubbles"} onChange={(event) => p.onChange({ tool: event.target.checked ? "declutter-keep-bubbles" : "declutter" })} />
              <span>保留气泡</span>
            </label>}
          </div>
        )}

        <div className="director-action-row">
          <div className="director-tool-row" role="group" aria-label="选择处理工具">
            {visibleTools.map(({ id, label, Icon }) => {
              const selected = id === "declutter"
                ? state.tool === "declutter" || state.tool === "declutter-keep-bubbles"
                : state.tool === id;
              const unsupported = Boolean(p.operations && !p.operations.includes("augment"));
              return <button key={id} type="button" className={selected ? "is-selected" : ""} aria-pressed={selected} disabled={unsupported} onClick={() => chooseTool(id)}>
                <Icon size={15} /><span>{label}</span>
              </button>;
            })}
            <button type="button" className="director-pixel-tool" disabled={!sourceValid} onClick={() => state.source && p.onPixel(state.source)}>
              <Sparkles size={15} /><span>像素整理</span>
            </button>
          </div>
          <label className="director-mobile-tool-select">
            <span className="director-sr-only">选择处理工具</span>
            <select aria-label="选择处理工具" value={state.tool === "declutter-keep-bubbles" ? "declutter" : state.tool} onChange={(event) => chooseMobileTool(event.target.value)}>
              {visibleTools.map(({ id, label }) => <option key={id} value={id} disabled={Boolean(p.operations && !p.operations.includes("augment"))}>{label}</option>)}
              <option value="pixel" disabled={!sourceValid}>像素整理</option>
            </select>
          </label>
          <div className="director-status" role="status" aria-live="polite">
            {issue ? <span className="is-error">{issue}</span>
              : quoteError ? <><span className={quoteError.blocksSubmit ? "is-error" : ""}>{quoteError.message}{quoteError.connection ? " · 请检查连接" : ""}</span>{quoteError.retryable && <button type="button" onClick={() => setQuoteRefresh((n) => n + 1)}>重试报价</button>}</>
                : matchingJob && matchingPending ? <span>{jobStatusLabel(matchingJob)} · {toolNames[state.tool]}</span>
                  : !quote ? <span>正在获取当前工具的报价…</span> : null}
          </div>
          <button className="director-submit" type="button" title={quote?.message || quoteError?.message || estimateLabel} disabled={submitBlocked || p.busy} onClick={submit}>
            {(p.busy || matchingWorking) && <LoaderCircle size={17} className="director-spin" />}
            <span className="director-submit-copy">{p.busy || matchingWorking ? "处理中…" : "开始处理"}</span>
            <strong className="director-cost-chip">{estimateLabel}</strong>
          </button>
          <button className="director-mobile-history-toggle" type="button" aria-label={historyOpen ? "收起历史记录" : "打开历史记录"} aria-expanded={historyOpen} aria-controls="director-history-panel" onClick={() => setHistoryOpen((open) => !open)}>
            <Clock3 size={18} />
          </button>
        </div>
        </footer>
      </section>

      <input ref={fileInput} className="director-file-input" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择导演工具原图" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) p.onUpload(file);
        // Clearing permits selecting the same file again. Cancelling the chooser changes no draft state.
        event.currentTarget.value = "";
      }} />

      {historyOpen && <button className="director-history-scrim" type="button" aria-label="关闭历史记录" onClick={() => setHistoryOpen(false)} />}
      <aside id="director-history-panel" className={`director-history${historyOpen ? " is-open" : " is-collapsed"}`} aria-label="导演工具历史记录">
        {historyOpen ? <>
          <div className="director-history-header"><b>历史记录</b><button type="button" aria-label="收起历史记录" aria-expanded="true" aria-controls="director-history-panel" onClick={() => setHistoryOpen(false)}><X size={17} /></button></div>
          <div className="director-history-list">
            {p.rows.length ? p.rows.map((row) => <button key={row.id} type="button" className={row.id === state.resultId ? "is-selected" : ""} onClick={() => { p.onSelectResult(row); setMobileShowSource(false); if (window.matchMedia('(max-width: 850px)').matches) setHistoryOpen(false); }}>
              <span className="director-history-thumb">{p.renderImage(row)}</span>
              <span className="director-history-copy"><b>{row.job.label || "导演处理"}</b><small>{new Date((row.job.completed_at ?? row.job.created_at) * 1000).toLocaleString()}</small></span>
              {row.id === state.resultId && <Check size={15} />}
            </button>) : <div className="director-history-empty">还没有导演工具记录。</div>}
          </div>
          {p.jobs.some((job) => job.status !== "succeeded") && <div className="director-history-jobs">
            <b>任务状态</b>
            {p.jobs.filter((job) => job.status !== "succeeded").slice(0, 8).map((job) => <div key={job.id}><LoaderCircle size={14} className={job.status === "queued" || job.status === "waiting" || job.status === "running" ? "director-spin" : ""} /><span>{job.label || "导演处理"}</span><small>{jobStatusLabel(job)}</small></div>)}
          </div>}
        </> : <button className="director-history-collapsed" type="button" aria-label="打开历史记录" aria-expanded="false" aria-controls="director-history-panel" onClick={() => setHistoryOpen(true)}><Clock3 size={16} /><span>历史</span></button>}
      </aside>
    </main>
  );
}
