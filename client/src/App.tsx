import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDownToLine,

  ArrowRight,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Download,
  FolderOpen,
  Layers,
  LoaderCircle,
  LogOut,
  Paintbrush,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Api, ApiError } from "./api";
import { connectionTarget } from "./connection";
import { configurationIssueFor, effectiveModelForOperation, usesGenerationSettings } from "./taskValidation";
import type { QuoteError } from "./taskValidation";
import { GateApi, MAX_PENDING } from "./gateApi";
import GateQueueStatus, { useGateQueueStatus, gateJobLabel, queueWaitLabel } from "./GateQueueStatus";
import * as local from "./storage";
import { defaultParameters, labels, newDraft, uuid } from "./types";
import type {
  BatchDraft,
  BatchItem,
  Capabilities,
  Draft,
  Job,
  LocalImage,
  Operation,
  QueueWaitReason,
  StorageSettings,
  Strings,
  Task,
  User,
} from "./types";
import ImageViewer from "./ImageViewer";
import MaskEditor from "./MaskEditor";
import CanvasEditor from "./CanvasEditor";
import { canvasProjectScope } from "./canvasProject";
import LocalPixelSnap from "./LocalPixelSnap";
import ImageImportDialog from "./ImageImportDialog";
import type { ImageUse } from "./ImageImportDialog";
import { readImage, applyMetadata, vibeKey } from "./imageImport";
import { VibeReferenceError, encodingFor, makeVibeFile, readVibeFile, resolveVibeReference, vibeDownload, vibeModelKey, vibeParameterHash } from "./vibeFiles";
import type { VibeFileItem } from "./vibeFiles";
import type { ImportedImage, ImportOptions } from "./imageImport";
import AccessManagement from "./AccessManagement";
import OfficialWorkspace from "./OfficialWorkspace";
import ReferenceImages from "./ReferenceImages";
import DirectorWorkspace from "./DirectorWorkspace";
import { directorFromJob, directorMatchesJob, directorSourceIssue, migrateDirectorDraft, readDirectorDraft } from "./director";
import type { DirectorDraft, DirectorSource } from "./director";
import WorkspaceHeader from "./WorkspaceHeader";
import { composePrompts } from "./promptPresets";
import { generationParameters } from "./modelSettings";
import TokenMeter from "./TokenMeter";
import type { TagSuggestion } from "./TagInput";

type Page = "draw" | "director" | "batch" | "gallery" | "settings";
type ConfirmationRequest = {
  title: string;
  message: string;
  confirmLabel: string;
};
type PreviewJob = Job & {
  preview?: { image: string; media_type: string; step?: number };
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const statusNames: Record<Job["status"], string> = {
  queued: "排队中",
  waiting: "等待限流解除",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "结果待核对",
  cancelled: "已取消",
};
const stringLabels: Record<keyof Strings, string> = {
  artist: "画师串",
  quality: "质量串",
  negative: "负面串",
};
const stringKeys = ["artist", "quality", "negative"] as const;
const fallbackModels: Capabilities["models"] = [
  {
    id: "nai-diffusion-5-full",
    name: "NAI Diffusion V5 Full",
    max_characters: 32,
    precise_reference: false,
    vibe_transfer: false,
  },
  {
    id: "nai-diffusion-5-curated",
    name: "NAI Diffusion V5 Curated",
    max_characters: 32,
    precise_reference: false,
    vibe_transfer: false,
  },
  {
    id: "nai-diffusion-4-5-full",
    name: "NAI Diffusion V4.5 Full",
    max_characters: 6,
    precise_reference: true,
    vibe_transfer: true,
  },
  {
    id: "nai-diffusion-4-5-curated",
    name: "NAI Diffusion V4.5 Curated",
    max_characters: 6,
    precise_reference: true,
    vibe_transfer: true,
  },
  {
    id: "nai-diffusion-4-full",
    name: "NAI Diffusion V4 Full",
    max_characters: 6,
  },
  { id: "nai-diffusion-4-curated-preview", name: "NAI Diffusion V4 Curated", max_characters: 6 },
  { id: "nai-diffusion-furry-3", name: "NAI Diffusion Furry V3", max_characters: 0 },
  { id: "nai-diffusion-3", name: "NAI Diffusion V3", max_characters: 0 },
];

function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function Section({
  name,
  children,
  initial = false,
  number,
}: {
  name: string;
  children: ReactNode;
  initial?: boolean;
  number?: string;
}) {
  return (
    <details className="section" open={initial || undefined}>
      <summary>
        <span className="section-number">{number ?? "+"}</span>
        <span>{name}</span>
        <ChevronDown size={15} />
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
}
function ImageView({
  row,
  className = "",
  onClick,
}: {
  row: LocalImage;
  className?: string;
  onClick?: () => void;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(row.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [row.blob]);
  return row.result.media_type.startsWith("image/") ? (
    <img
      src={url}
      alt={row.job.label || row.job.prompt || "生成图片"}
      className={className}
      onClick={onClick}
    />
  ) : (
    <div className={`encoded-file ${className}`} onClick={onClick}>
      <Layers />
      <span>Vibe 数据</span>
    </div>
  );
}
function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  disabled = false,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      aria-label={label}
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value !== "" && Number.isFinite(+e.target.value))
          onChange(+e.target.value);
      }}
    />
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("draw");
  const pageRef = useRef(page);
  pageRef.current = page;
  const [mobileTab, setMobileTab] = useState<"edit" | "result">("edit");
  const [token, setToken] = useState(
    () => sessionStorage.getItem("nai-wb-token") || "",
  );
  const [base, setBase] = useState(
    () => localStorage.getItem("nai-wb-base") || "",
  );
  const [loginToken, setLoginToken] = useState(token);
  const [loginBase, setLoginBase] = useState(base);
  const [api, setApi] = useState<Api | null>(null);
  const suggestTags = useCallback(async (model: string, fragment: string): Promise<TagSuggestion[]> => {
    if (!api) return [];
    const result = await api.request<{tags:TagSuggestion[]}>('/suggest-tags',{model,prompt:fragment});
    return result.tags;
  }, [api]);
  const apiRef = useRef<Api | null>(null);
  const [isGate, setIsGate] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<LocalImage[]>([]);
  const [jobs, setJobs] = useState<PreviewJob[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [blankCanvas, setBlankCanvas] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [queueEncoding, setQueueEncoding] = useState(false);
  const [encodingPaused, setEncodingPaused] = useState(false);
  const [encodingRetryAt, setEncodingRetryAt] = useState<number>();
  const [encodingWaitReason, setEncodingWaitReason] = useState<QueueWaitReason>();
  const [queueNow, setQueueNow] = useState(() => Date.now() / 1000);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [backupWarning, setBackupWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Saving failures belong to a result, so recovery cannot clear an unrelated error.
  const [saveIssue, setSaveIssue] = useState<{ resultId: string; saved: boolean; message: string } | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [showLibrary, setShowLibrary] = useState<false | "all" | "negative">(false);
  const [showMask, setShowMask] = useState(false);
  const [canvasInput, setCanvasInput] = useState<{ image: string; width: number; height: number; scope: string } | null>(null);
  const [pixelInput, setPixelInput] = useState<{ image: string; width: number; height: number; target?: 'director' } | null>(null);
  const [pendingMaskDraft, setPendingMaskDraft] = useState<Draft | null>(null);
  const [imports,setImports]=useState<ImportedImage[]>([]);
  const [dragging,setDragging]=useState(false);
  const importInput=useRef<HTMLInputElement>(null);
  const importSequence=useRef(0);
  const submitting=useRef(false);
  const [showFinal, setShowFinal] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(
    null,
  );
  const confirmationPending = useRef<{
    resolve: (accepted: boolean) => void;
    seq: number;
    owner: string;
  } | null>(null);
  const [presetName, setPresetName] = useState("");
  const [quote, setQuote] = useState<{
    units: number;
    generation_units?: number;
    encoding_units?: number;
    unit_label: string;
    verified: boolean;
    message: string;
  } | null>(null);
  const [quoteError, setQuoteError] = useState<QuoteError | null>(null);
  const quoteVersion = useRef(0);
  const [storage, setStorage] = useState<StorageSettings | null>(null);
  const [galleryQuery, setGalleryQuery] = useState("");
  const generation = useRef(0),
    draftRef = useRef(draft),
    identity = useRef(""),
    canvasScope = useRef(""),
    submitCache = useRef<{
      fingerprint: string;
      requestId: string;
      items: Task[];
    } | null>(null),
    syncBusy = useRef(false);
  draftRef.current = draft;
  const notify = (message: string) => {
    setNotice(message);
    setFailure("");
  };
  const fail = (e: unknown) => {
    setFailure(errorText(e));
    setNotice("");
  };
  const setParam = (key: string, value: unknown) =>
    setDraft((d) => ({ ...d, parameters: { ...d.parameters, [key]: value } }));
  // Model changes preserve imported references; shared validation asks the user to resolve conflicts.
  const patchDraft = (patch: Partial<Draft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const director = useMemo(() => readDirectorDraft(draft.director, draft.model), [draft.director, draft.model]);
  function patchDirector(patch: Partial<DirectorDraft>) {
    setDraft(d => ({ ...d, director: { ...readDirectorDraft(d.director, d.model), ...patch } }));
  }
  function openDirector(source?: DirectorSource) {
    if (source) {
      const issue = directorSourceIssue(source);
      if (issue) throw new Error(issue);
      patchDirector({ source, resultId: undefined });
    }
    setPage('director');
  }
  // Preview selection belongs to this session; loading the gallery must not select an old result.
  const selected = rows.find((r) => r.id === selectedId);
  const drawingRows = rows.filter(row => row.job.operation !== 'augment');
  const drawingSelected = drawingRows.find(row => row.id === selectedId);
  const activeJobs = jobs.filter(
    (j) => ["queued", "waiting", "running"].includes(j.status),
  );
  const preview = jobs.find(
    (j) => j.operation !== 'augment' && j.status === "running" && j.preview,
  )?.preview;
  const isMock = caps?.mode === "mock";
  const pendingSaveJobs = jobs.filter(job => job.status === 'succeeded' && job.results.some(r => !r.acknowledged && !r.deleted));
  const queuePending = activeJobs.length + pendingSaveJobs.length + (queueEncoding ? 1 : 0);
  const serverQueue = useGateQueueStatus(user && isGate ? api : null, queuePending > 0 || showQueue);
  const hasRetryCountdown = Boolean(encodingRetryAt || jobs.some(j => j.status === "waiting" && j.retry_at));
  const displayJobs = jobs.map((job, index) => ({ job, index }))
    .sort((a, b) => b.job.created_at - a.job.created_at || b.index - a.index)
    .map(({ job }) => job);
  const countdown = (retryAt?: number) => Math.max(0, Math.ceil((retryAt ?? queueNow) - queueNow));
  const waitingJob = jobs.find(job => job.status === 'waiting');
  const runningJob = jobs.find(job => job.status === 'running');
  const unsentCount = jobs.filter(job => job.status === 'queued' || job.status === 'waiting').length;
  const queueMessage = saveIssue ? (saveIssue.saved ? '图片已保存本机，等待保存确认' : '本机保存失败，后续任务等待保存恢复') :
    pendingSaveJobs.length ? (queuePaused ? '生成完成，等待保存到本机；后续任务已暂停' : '生成完成，等待保存到本机') :
    encodingPaused ? 'Vibe 编码已暂停' : queuePaused ?
      (unsentCount ? `队列已暂停，${unsentCount} 项待发送` : runningJob ? '后续任务已暂停，当前任务继续处理' : '队列已暂停，暂无待发任务') :
    encodingRetryAt ? `Vibe 编码：${queueWaitLabel(encodingWaitReason)} · ${countdown(encodingRetryAt)} 秒后自动重试` :
    waitingJob ? `${queueWaitLabel(waitingJob.retry_reason)} · ${countdown(waitingJob.retry_at)} 秒后自动重试` :
    queueEncoding ? 'Vibe 编码：等待服务器结果' : runningJob ? gateJobLabel(runningJob, queueNow) : '本机队列等待发送';
  const quoteUnitLabel = (units: number) => quote?.unit_label.includes("V5") ? `${units} 次 V5` : `${units} 积分`;
  function closeMask() { setShowMask(false); setPendingMaskDraft(null); }
  function saveMask(mask: string) {
    setDraft(current => {
      const source = pendingMaskDraft ?? current;
      return { ...source, operation: "inpaint", parameters: { ...source.parameters, mask } };
    });
    closeMask();
    setPage("draw");
    setMobileTab("edit");
    notify("重绘蒙版已应用");
  }
  useEffect(() => {
    if (preview) setBlankCanvas(false);
  }, [preview?.image]);
  useEffect(() => {
    if (!hasRetryCountdown) return;
    setQueueNow(Date.now() / 1000);
    const timer = setInterval(() => setQueueNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [hasRetryCountdown]);

  const settleConfirmation = useCallback((accepted: boolean) => {
    const pending = confirmationPending.current;
    confirmationPending.current = null;
    setConfirmation(null);
    pending?.resolve(
      accepted &&
        pending.seq === generation.current &&
        pending.owner === identity.current,
    );
  }, []);
  function askConfirmation(request: ConfirmationRequest) {
    confirmationPending.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      confirmationPending.current = {
        resolve,
        seq: generation.current,
        owner: identity.current,
      };
      setConfirmation(request);
    });
  }
  useEffect(
    () => () => {
      confirmationPending.current?.resolve(false);
      confirmationPending.current = null;
    },
    [],
  );

  const disconnect = useCallback(() => {
    const current = apiRef.current;
    if (current instanceof GateApi) {
      if (current.pending() && !window.confirm("还有任务或未保存的结果。退出会停止本页队列，已发出的请求可能仍扣额度，确定退出？")) return;
      current.close();
    }
    apiRef.current = null;
    settleConfirmation(false);
    if (identity.current)
      void local.saveDraft(identity.current, draftRef.current).catch(() => {});
    generation.current++;
    identity.current = "";
    canvasScope.current = "";
    submitCache.current = null;
    setImports([]);
    setDragging(false);
    importSequence.current++;
    setUser(null);
    setApi(null);
    setCaps(null);
    setJobs([]);
    setSaveIssue(null);
    setQueuePaused(false); setQueueEncoding(false); setEncodingPaused(false); setEncodingRetryAt(undefined); setEncodingWaitReason(undefined);
    setBlankCanvas(false); setPendingMaskDraft(null); setShowMask(false); setCanvasInput(null); setPixelInput(null);
    setRows([]);
    setSelectedId(undefined);
    setLoaded(false);
    setDraft(newDraft());
    setStorage(null);
    setQuote(null);
    setQuoteError(null);
    setToken("");
    setLoginToken("");
    sessionStorage.removeItem("nai-wb-token");
    syncBusy.current = false;
    setFailure("");
    setNotice("");
    setBackupWarning("");
  }, []);
  const connect = useCallback(async (access: string, address: string) => {
    settleConfirmation(false);
    const seq = ++generation.current;
    syncBusy.current = false;
    submitCache.current = null;
    setConnecting(true);
    setFailure("");
    setBackupWarning("");
    setLoaded(false);
    setImports([]);
    setDragging(false);
    importSequence.current++;
    setUser(null);
    setApi(null);
    setRows([]);
    setJobs([]);
    setSaveIssue(null);
    setQueuePaused(false); setQueueEncoding(false); setEncodingPaused(false); setEncodingRetryAt(undefined); setEncodingWaitReason(undefined);
    setBlankCanvas(false); setPendingMaskDraft(null); setShowMask(false); setCanvasInput(null); setPixelInput(null);
    setSelectedId(undefined);
    setDraft(newDraft());
    setStorage(null);
    setQuote(null);
    setQuoteError(null);
    identity.current = "";
    canvasScope.current = "";
    try {
      if (!access.trim()) throw new Error("请填写工具访问口令。");
      const { base: normalized, gate } = await connectionTarget(address);
      if (seq !== generation.current) return;
      const client = gate ? new GateApi(normalized, access.trim()) : new Api(normalized, access.trim());
      setIsGate(gate);
      const [me, capabilities] = await Promise.all([
        client.request<User>("/me"),
        client.request<Capabilities>("/capabilities"),
      ]);
      if (me.gate_quota?.imageModelScope === 'legacy') capabilities.models = capabilities.models.filter(m=>!m.id.startsWith('nai-diffusion-5'));
      if (seq !== generation.current) return;
      // A server's stable user ID scopes its local data; the server address prevents cross-install collisions.
      const owner = `${normalized || location.origin}|${me.id}`;
      let recoveredDraft = false;
      const [stored, images] = await Promise.all([
        local.readDraft(owner).catch(error => {
          if (!(error instanceof local.InvalidDraftError)) throw error;
          recoveredDraft = true;
          return undefined;
        }),
        local.gallery(owner),
      ]);
      if (seq !== generation.current) return;
      identity.current = owner;
      canvasScope.current = canvasProjectScope(owner, access.trim());
      const restoredDraft = migrateDirectorDraft(stored ?? newDraft());
      // Restore the tool inputs, but leave its result preview empty after reconnecting.
      if (restoredDraft.director) restoredDraft.director.resultId = undefined;
      setDraft(restoredDraft);
      if (stored?.operation === 'augment') setPage('director');
      setRows(images);
      setUser(me);
      setCaps(capabilities);
      setApi(client);
      apiRef.current = client;
      setToken(access.trim());
      setBase(normalized);
      setLoginBase(normalized);
      sessionStorage.setItem("nai-wb-token", access.trim());
      if (normalized) localStorage.setItem("nai-wb-base", normalized);
      else localStorage.removeItem("nai-wb-base");
      setLoaded(true);
      if (recoveredDraft) notify("草稿已损坏，已恢复默认设置；图库仍保留。");
      if (me.is_admin) {
        try {
          const s = await client.request<StorageSettings>("/settings");
          if (seq === generation.current) setStorage(s);
        } catch (e) {
          if (seq === generation.current) fail(e);
        }
      }
    } catch (e) {
      if (seq === generation.current) {
        fail(e);
        sessionStorage.removeItem("nai-wb-token");
      }
    } finally {
      if (seq === generation.current) setConnecting(false);
    }
  }, []);
  useEffect(() => {
    void fetch('/api/health').then(r=>r.json()).then(h=>setIsGate(h.mode==='gate')).catch(()=>{});
    const warn = (event: BeforeUnloadEvent) => {
      if (apiRef.current instanceof GateApi && apiRef.current.pending()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(() => {
    if (token) void connect(token, base);
    return () => {
      generation.current++;
    };
  }, []); // Restore only the current tab's token.
  useEffect(() => {
    if (!loaded || !identity.current) return;
    const owner = identity.current;
    // Start the IndexedDB write immediately; a debounce could lose the last edit on refresh.
    void local.saveDraft(owner, draft).catch(fail);
  }, [draft, loaded]);
  useEffect(() => {
    const save = () => {
      if (identity.current && loaded)
        void local
          .saveDraft(identity.current, draftRef.current)
          .catch(() => {});
    };
    document.addEventListener("visibilitychange", save);
    return () => document.removeEventListener("visibilitychange", save);
  }, [loaded]);

  const refresh = useCallback(async () => {
    if (!api || !user || syncBusy.current) return;
    syncBusy.current = true;
    const seq = generation.current,
      owner = identity.current;
    let saving: { resultId: string; saved: boolean } | undefined;
    try {
      const [result, me] = await Promise.all([
        api.request<{ jobs: PreviewJob[]; queue_paused?: boolean; encoding?: boolean; encoding_retry_at?: number; encoding_paused?: boolean; encoding_wait_reason?: QueueWaitReason }>("/jobs"),
        api.request<User>("/me"),
      ]);
      if (seq !== generation.current) return;
      setJobs(result.jobs);
      setQueuePaused(Boolean(result.queue_paused));
      setQueueEncoding(Boolean(result.encoding));
      setEncodingPaused(Boolean(result.encoding_paused));
      setEncodingRetryAt(result.encoding_retry_at);
      setEncodingWaitReason(result.encoding_wait_reason);
      setQueueNow(Date.now() / 1000);
      setUser(me);
      let newestSaved: LocalImage | undefined;
      let newestDirectorSaved: LocalImage | undefined;
      for (const job of result.jobs) {
        if (job.status !== "succeeded") continue;
        for (const result of job.results ?? []) {
          if (seq !== generation.current) return;
          saving = { resultId: result.id, saved: false };
          const removed = result.deleted || (await local.isRemoved(owner, result.id));
          if (seq !== generation.current) return;
          if (removed) {
            setSaveIssue(current => current?.resultId === result.id ? null : current);
            saving = undefined;
            continue;
          }
          let existing = await local.getImage(owner, result.id);
          if (!existing) {
            setSyncing(true);
            const blob = await api.content(result.id);
            if (seq !== generation.current) return;
            existing = await local.storeResult(owner, job, result, blob);
            if (!existing) { saving = undefined; continue; }
            const images = await local.gallery(owner);
            if (seq !== generation.current) return;
            setRows(images);
            if (job.operation === 'augment') {
              // A finished tool job must not replace the drawing selection or a
              // different source the user has since loaded into Director Tools.
              if (directorMatchesJob(readDirectorDraft(draftRef.current.director, draftRef.current.model), existing.job) && (!newestDirectorSaved || (existing.job.completed_at ?? existing.job.created_at) >= (newestDirectorSaved.job.completed_at ?? newestDirectorSaved.job.created_at))) {
                newestDirectorSaved = existing;
                const saved = existing;
                setDraft(current => {
                  const tools = readDirectorDraft(current.director, current.model);
                  return directorMatchesJob(tools, saved.job) ? { ...current, director: { ...tools, resultId: saved.id } } : current;
                });
              }
            } else if (pageRef.current === 'draw' && (!newestSaved || (existing.job.completed_at ?? existing.job.created_at) >= (newestSaved.job.completed_at ?? newestSaved.job.created_at))) {
              newestSaved = existing;
              setSelectedId(existing.id);
              setBlankCanvas(false);
            }
          }
          if (seq !== generation.current) return;
          // This branch is reached only after the IndexedDB transaction has committed.
          if (!result.acknowledged) {
            if (
              existing.result.sha256 !== result.sha256 ||
              (await local.digest(existing.blob)) !== result.sha256
            )
              throw new Error("本地图片校验未通过，未确认服务器副本。");
            if (seq !== generation.current) return;
            saving.saved = true;
            await api.request(
              `/results/${encodeURIComponent(result.id)}/ack`,
              { sha256: result.sha256 },
            );
          }
          if (seq !== generation.current) return;
          setSaveIssue(current => current?.resultId === result.id ? null : current);
          // Reflect the confirmed save immediately, rather than waiting for the next poll.
          setJobs(current => current.map(item => item.id !== job.id ? item : { ...item,
            results: item.results.map(r => r.id !== result.id ? r : { ...r, acknowledged: true }) }));
          saving = undefined;
        }
      }
      const images = await local.gallery(owner);
      if (seq === generation.current) setRows(images);
    } catch (e) {
      if (seq === generation.current) {
        if (saving) setSaveIssue({ ...saving, message: saving.saved
          ? `图片已保存本机，确认稍后自动重试：${errorText(e)}`
          : e instanceof Error && e.name === 'QuotaExceededError'
            ? '本机存储空间不足，图片尚未保存；请保持页面打开并释放空间。'
            : `本机保存失败，稍后自动重试：${errorText(e)}` });
        else fail(e);
      }
    } finally {
      if (seq === generation.current) {
        syncBusy.current = false;
        setSyncing(false);
      }
    }
  }, [api, user?.id]);
  useEffect(() => {
    if (!api) return;
    void refresh();
    const t = setInterval(() => void refresh(), 2200);
    return () => clearInterval(t);
  }, [api, refresh]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    quoteVersion.current++;
    if (!api || (page !== 'draw' && page !== 'batch')) return;
    const timer = setTimeout(() => void requestQuote(true), 450);
    return () => clearTimeout(timer);
  }, [
    api,
    draft.model,
    draft.operation,
    page,
    draft.prompt,
    draft.artist,
    draft.quality,
    draft.negative,
    draft.parameters,
  ]);
  useEffect(() => {
    if (
      !showQueue &&
      !showLibrary &&
      !showMask &&
      !canvasInput &&
      !pixelInput &&
      !showFinal &&
      !lightbox &&
      !confirmation && !imports.length
    )
      return;
    const previous = document.activeElement as HTMLElement | null;
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return;
    const selector =
      'button:not(:disabled),input:not(:disabled),textarea,select,[tabindex="0"]';
    const first = dialog.querySelector<HTMLElement>(selector);
    first?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (confirmation) {
          settleConfirmation(false);
          return;
        }
        setImports([]);
        setShowQueue(false);
        setShowLibrary(false);
        setShowMask(false);
        setCanvasInput(null);
        setPixelInput(null);
        setPendingMaskDraft(null);
        setShowFinal(false);
        setLightbox(false);
      }
      if (event.key === "Tab") {
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(selector),
        ).filter((el) => el.getClientRects().length > 0);
        const first = focusables[0],
          last = focusables[focusables.length - 1];
        if (!first) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus({ preventScroll: true });
    };
  }, [
    showQueue,
    showLibrary,
    showMask,
    canvasInput,
    pixelInput,
    showFinal,
    lightbox,
    confirmation,
    settleConfirmation,
    imports,
  ]);

  function taskFor(
    prompt = draft.prompt,
    strings: Strings = draft,
    label = "工作台",
    operation = draft.operation,
  ): Task {
    const effectiveModel = effectiveModelForOperation(draft.model, operation);
    const p = generationParameters(effectiveModel, draft.parameters);
    p.stream = draft.parameters.stream === true;
    const rawVibeFiles=draft.parameters.vibe_files;
    const vibeFiles=Array.isArray(rawVibeFiles)?rawVibeFiles:[];
    p.n_samples = 1;
    p.character_prompts = p.character_prompts.filter(c => c.enabled !== false);
    delete p.vibe_encodings;
    delete p.vibe_files;
    delete p.vibe_source_files;
    delete p.vibe_source_images;
    delete p.vibe_pending_indices;
    if(operation !== 'inpaint')delete p.mask;
    if(operation === 'generate')delete p.image;
    if(!['generate','img2img','inpaint'].includes(operation)) {
      p.character_prompts=[];p.reference_image_multiple=[];p.reference_strength_multiple=[];p.reference_information_extracted_multiple=[];
      p.character_reference_images=[];p.character_reference_descriptions=[];p.character_reference_strengths=[];p.character_reference_fidelities=[];
    }
    if(rawVibeFiles!==undefined && !Array.isArray(rawVibeFiles))p.vibe_source_files=rawVibeFiles;
    else if(p.reference_image_multiple.length && vibeFiles.some(item=>item?.type==='encoding' || Boolean(item?.importInfo?.mask)))
      p.vibe_source_files=[...vibeFiles];
    if(effectiveModel.startsWith('nai-diffusion-4') && p.reference_image_multiple.length) {
      p.vibe_source_images=[...p.reference_image_multiple];
      p.vibe_source_files=Array.isArray(rawVibeFiles)?[...vibeFiles]:rawVibeFiles;
      const pending:number[]=[];
      p.reference_image_multiple=p.reference_image_multiple.map((image,i)=>{
        const file=vibeFiles[i], extracted=p.reference_information_extracted_multiple[i]??1;
        try {
          const result=resolveVibeReference(image,file,effectiveModel,extracted,draft.parameters.vibe_encodings?.[vibeKey(image,effectiveModel,extracted)]);
          if(result.pending)pending.push(i);
          return result.value;
        } catch(error) {
          // Keep render/quote preparation safe. Shared configuration validation
          // shows the reference issue and blocks submission before any API call.
          if(error instanceof VibeReferenceError)return image;
          throw error;
        }
      });
      p.vibe_pending_indices=pending;
    }
    return {
      request_id: uuid(),
      operation,
      model: draft.model,
      prompt: ["upscale","augment","encode_vibe"].includes(operation)?prompt:prompt.trim()?composePrompts(draft, prompt, strings).prompt:'',
      negative_prompt: usesGenerationSettings(operation) ? composePrompts(draft, prompt, strings).negative : "",
      parameters: p,
      label,
    };
  }
  function validateTask(task: Task) {
    const effectiveModel = effectiveModelForOperation(task.model, task.operation);
    if(!effectiveModel.startsWith('nai-diffusion-4') && Array.isArray(task.parameters.vibe_source_files) && task.parameters.vibe_source_files.some((item:VibeFileItem|null)=>item?.type==='encoding'))
      throw new Error('导入的 Vibe 编码仅适用于文件对应的 V4 或 V4.5 模型');
    const issue = configurationIssueFor(task, caps?.models ?? fallbackModels, caps?.operations);
    if (issue) throw new Error(issue.message);
    if (usesGenerationSettings(task.operation) && !task.prompt.trim())
      throw new Error("先写一点提示词，再加入生成队列。");
  }
  async function submit(items: Task[]) {
    if (!api || submitting.current) return;
    submitting.current=true;setBusy(true);
    const seq = generation.current, owner=identity.current;
    try {
      items.forEach(validateTask);
      // Check before Vibe encoding, which may incur a charge. Recheck on enqueue too.
      if (api instanceof GateApi) api.checkCapacity(items.length);
      const cache={...draftRef.current.parameters.vibe_encodings};
      for(const task of items) {
        const pending=(task.parameters.vibe_pending_indices??[]) as number[];
        const encodingModel = effectiveModelForOperation(task.model, task.operation);
        for(const index of pending) {
          if(!(api instanceof GateApi))throw new Error('自动 Vibe 编码需要连接 Gate');
          const source=task.parameters.reference_image_multiple[index], extracted=task.parameters.reference_information_extracted_multiple[index]??1;
          const key=vibeKey(source,encodingModel,extracted);
          if(!cache[key]) {
            notify(`正在编码 Vibe 参考 ${index+1}，预计 2 积分…`);
            cache[key]=await api.encodeVibe({request_id:uuid(),operation:'encode_vibe',model:encodingModel,prompt:'',negative_prompt:'',label:'Vibe 编码',parameters:{...structuredClone(defaultParameters),image:source,information_extracted:extracted}});
            if(seq!==generation.current || owner!==identity.current)return;
            const next={...draftRef.current,parameters:{...draftRef.current.parameters,vibe_encodings:{...draftRef.current.parameters.vibe_encodings,[key]:cache[key]}}};
            draftRef.current=next;setDraft(next);
            await local.saveDraft(owner,next);
          }
          task.parameters.reference_image_multiple[index]=cache[key];
        }
        delete task.parameters.vibe_pending_indices;
      }
      if (!items.length) throw new Error("没有可提交的任务。");
      const fingerprint = JSON.stringify(
        items.map(({ request_id: _, ...rest }) => rest),
      );
      let cached = submitCache.current;
      if (!cached || cached.fingerprint !== fingerprint) {
        cached = {
          fingerprint,
          requestId: uuid(),
          items: items.map((t) => ({
            ...t,
            parameters: {
              ...t.parameters,
              seed:
                t.parameters.seed === -1
                  ? crypto.getRandomValues(new Uint32Array(1))[0]
                  : t.parameters.seed,
            },
          })),
        };
        submitCache.current = cached;
      }
      setBusy(true);
      setFailure("");
      if(seq!==generation.current || owner!==identity.current)return;
      await api.request("/batches", {
        request_id: cached.requestId,
        items: cached.items,
      });
      if (seq !== generation.current) return;
      submitCache.current = null;
      notify(`${items.length} 张已加入队列`);
      if (items.length > 1) setShowQueue(true);
      void refresh();
    } catch (e) {
      if (seq === generation.current) fail(e);
    } finally {
      submitting.current=false;
      if (seq === generation.current) setBusy(false);
    }
  }
  function submitMain() {
    const count = Math.max(1, Math.min(20, Math.floor(draft.count)));
    void submit(Array.from({ length: count }, () => taskFor()));
  }
  function batchStrings(item: BatchItem): Strings {
    return Object.fromEntries(stringKeys.map(key => [
      key, draft.batch.unified[key] ? draft.batch.shared[key] : item[key],
    ])) as Strings;
  }
  function batchTasks(index?: number) {
    return draft.batch.items.flatMap((item, i) => {
      if (
        (index !== undefined && i !== index) ||
        (index === undefined && !item.enabled) ||
        !item.prompt.trim()
      )
        return [];
      const strings = batchStrings(item);
      return Array.from(
        { length: Math.max(1, Math.min(20, Math.floor(item.count))) },
        () =>
          taskFor(
            item.prompt,
            strings,
            `批量 ${String(i + 1).padStart(2, "0")}`,
            ["generate","img2img","inpaint"].includes(draft.operation)?draft.operation:"generate",
          ),
      );
    });
  }
  async function requestQuote(quiet = false) {
    if (!api) return;
    const seq = generation.current;
    const version = ++quoteVersion.current;
    setQuoteError(null);
    setQuote(null);
    try {
      const operation=page==='batch' && !['generate','img2img','inpaint'].includes(draft.operation)?'generate':draft.operation;
      const task = taskFor(draft.prompt,draft,"预估",operation);
      if(!effectiveModelForOperation(task.model,task.operation).startsWith('nai-diffusion-4') && Array.isArray(task.parameters.vibe_source_files) && task.parameters.vibe_source_files.some((item:VibeFileItem|null)=>item?.type==='encoding'))return;
      // Configuration feedback is derived immediately from the draft. Do not
      // send a known-invalid quote or turn it into a network error with Retry.
      if (configurationIssueFor(task, caps?.models ?? fallbackModels, caps?.operations)) return;
      delete task.parameters.vibe_source_images;
      delete task.parameters.vibe_source_files;
      const q = await api.request<{
        units: number;
        generation_units?: number;
        encoding_units?: number;
        unit_label: string;
        verified: boolean;
        message: string;
      }>("/quote", task);
      if (seq === generation.current && version === quoteVersion.current) { setQuote(q); setQuoteError(null); }
    } catch (e) {
      if (seq === generation.current && version === quoteVersion.current) { setQuote(null); setQuoteError({ message: errorText(e), connection: e instanceof ApiError && [401, 403].includes(e.status), retryable: !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429 }); if (!quiet) fail(e); }
    }
  }
  function acceptImage(kind: ImageUse, image: ImportedImage) {
    if (kind === 'augment') {
      openDirector({ data: image.data, width: image.width, height: image.height, name: image.name });
      notify('图片已载入导演工具');
      return;
    }
    const d=draftRef.current, p=d.parameters;
    const effectiveModel=effectiveModelForOperation(d.model,d.operation);
    if(kind==='vibe' && effectiveModel.startsWith('nai-diffusion-5'))throw new Error('当前模型不支持 Vibe，请先选择 V3、V4 或 V4.5');
    if(kind==='character' && !effectiveModel.startsWith('nai-diffusion-4-5'))throw new Error('精准参考需要 V4.5 模型');
    if(kind==='vibe' && p.character_reference_images.length)throw new Error('请先移除精准参考，再添加 Vibe；两者不能同时使用');
    if(kind==='character' && p.reference_image_multiple.length)throw new Error('请先移除 Vibe，再添加精准参考；两者不能同时使用');
    if(kind==='vibe' || kind==='character') {
      const key=kind==='vibe'?'reference_image_multiple':'character_reference_images';
      if(p[key].length>=16)throw new Error('最多添加 16 张参考图');
      setDraft(d=>({...d,operation:usesGenerationSettings(d.operation)?d.operation:'generate',parameters:kind==='vibe'?{...d.parameters,
        reference_image_multiple:[...d.parameters.reference_image_multiple,image.data],
        reference_strength_multiple:[...d.parameters.reference_strength_multiple,.6],
        reference_information_extracted_multiple:[...d.parameters.reference_information_extracted_multiple,1],
        vibe_files:[...(d.parameters.vibe_files??Array(d.parameters.reference_image_multiple.length).fill(null)),null],
      }:{...d.parameters,character_reference_images:[...d.parameters.character_reference_images,image.data],
        character_reference_descriptions:[...d.parameters.character_reference_images.map((_,i)=>d.parameters.character_reference_descriptions?.[i]??'character'),'character'],
        character_reference_strengths:[...d.parameters.character_reference_images.map((_,i)=>d.parameters.character_reference_strengths?.[i]??1),1],
        character_reference_fidelities:[...d.parameters.character_reference_images.map((_,i)=>d.parameters.character_reference_fidelities?.[i]??1),1]}}));
    } else {
      if(['upscale','augment'].includes(kind) && image.width*image.height>3145728)throw new Error('此图片超过工具的 3145728 像素上限，请先缩小');
      const width=Math.max(64,Math.min(4096,Math.round(image.width/8)*8)),height=Math.max(64,Math.min(4096,Math.round(image.height/8)*8));
      const next:Draft={...d,operation:kind==='image'?'img2img':kind,count:1,parameters:{...d.parameters,image:image.data,mask:undefined,width,height,source_width:image.width,source_height:image.height,scale_factor:2,req_type:d.parameters.req_type??'lineart'}};
      if(kind==='inpaint'){setPendingMaskDraft(next);setShowMask(true);return;}
      setDraft(next);
    }
    setPage('draw');setMobileTab('edit');notify(kind==='vibe'?'已添加 Vibe 参考；生成前会自动处理编码':kind==='character'?'已添加精准参考':'图片已载入');
  }
  async function uploadDirectorImage(file: File) {
    const seq = generation.current, owner = identity.current, selection = ++importSequence.current;
    const current = () => seq === generation.current && owner === identity.current && selection === importSequence.current && pageRef.current === 'director';
    try {
      const image = await readImage(file);
      if (!current()) return;
      openDirector({ data: image.data, width: image.width, height: image.height, name: image.name });
    } catch (error) { if (current()) fail(error); }
  }
  function openBlankDrawingCanvas() {
    const {width,height}=draftRef.current.parameters;
    if(width*height>4_194_304 || width>4096 || height>4096){fail(new Error('画布最长边不能超过 4096 像素，总像素不能超过 419 万。'));return;}
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');
    if(!context){fail(new Error('浏览器无法创建 2D 画布'));return;}
    context.fillStyle='#ffffff';context.fillRect(0,0,width,height);
    setCanvasInput({image:canvas.toDataURL('image/png'),width,height,scope:canvasScope.current});
  }
  function openSourceCanvas() {
    const p=draftRef.current.parameters;
    if(!p.image){fail(new Error('请先导入源图片'));return;}
    setCanvasInput({image:p.image,width:Number(p.source_width??p.width),height:Number(p.source_height??p.height),scope:canvasScope.current});
  }
  function openSourcePixelSnap() {
    const p=draftRef.current.parameters;
    if(!p.image){fail(new Error('请先导入源图片'));return;}
    setPixelInput({image:p.image,width:Number(p.source_width??p.width),height:Number(p.source_height??p.height)});
  }
  async function openResultCanvas(row: LocalImage) {
    const seq=generation.current,owner=identity.current;
    try {
      const image=await readImage(new File([row.blob],row.result.filename,{type:row.result.media_type}));
      if(seq!==generation.current || owner!==identity.current)return;
      setCanvasInput({image:image.data,width:image.width,height:image.height,scope:canvasScope.current});
    } catch(error){if(seq===generation.current)fail(error);}
  }
  async function openResultPixelSnap(row: LocalImage) {
    const seq=generation.current,owner=identity.current;
    try {
      const image=await readImage(new File([row.blob],row.result.filename,{type:row.result.media_type}));
      if(seq!==generation.current || owner!==identity.current)return;
      setPixelInput({image:image.data,width:image.width,height:image.height});
    } catch(error){if(seq===generation.current)fail(error);}
  }
  async function uploadImage(kind: 'image'|'mask'|'vibe'|'character'|'inpaint'|'upscale',file:File) {
    const seq=generation.current,owner=identity.current,originPage=pageRef.current,selection=++importSequence.current;
    const current=()=>seq===generation.current && owner===identity.current && originPage===pageRef.current && selection===importSequence.current;
    try {
      if(kind==='mask') {
        const image=await readImage(file);
        if(!current())return;
        if(draftRef.current.parameters.source_width && (image.width!==draftRef.current.parameters.source_width || image.height!==draftRef.current.parameters.source_height))throw new Error('蒙版尺寸必须与源图一致');
        setParam('mask',image.data);patchDraft({operation:'inpaint'});return;
      }
      const image=await readImage(file);
      if(!current())return;
      acceptImage(kind,image);
    } catch(e){if(current())fail(e);}
  }
  async function importVibeData(file: File) {
    const seq=generation.current,owner=identity.current;
    try {
      const items=await readVibeFile(file);
      if(seq!==generation.current || owner!==identity.current)return;
      const d=draftRef.current, p=d.parameters;
      if(p.character_reference_images.length)throw new Error('请先移除精准参考，再导入 Vibe');
      if(p.reference_image_multiple.length+items.length>16)throw new Error('Vibe 参考最多 16 项');
      const models=new Set((caps?.models??fallbackModels).map(model=>model.id));
      const preferred=items[0].importInfo?.model;
      const nextOperation=usesGenerationSettings(d.operation)?d.operation:'generate';
      const currentEffective=effectiveModelForOperation(d.model,nextOperation);
      const model=preferred && models.has(preferred) && preferred!==currentEffective ? preferred : d.model;
      const referenceModel=effectiveModelForOperation(model,nextOperation);
      if(!vibeModelKey(referenceModel) || referenceModel.startsWith('nai-diffusion-5'))throw new Error('请先选择支持 Vibe 的 V4 或 V4.5 模型');
      for(const item of items) {
        if(item.type==='encoding' && !encodingFor(item,referenceModel,item.importInfo?.information_extracted??1))
          throw new Error('文件中的 Vibe 编码不适用于当前模型，或合集使用了不同模型');
        if(item.type==='image' && item.importInfo?.mask && !encodingFor(item,referenceModel,item.importInfo.information_extracted,item.importInfo.mask))
          throw new Error('这份带蒙版的 Vibe 原图没有当前模型可用的编码；现有 Gate 不能按蒙版重新编码，请导入已编码的文件');
      }
      const next:Draft={...d,model,operation:nextOperation,parameters:{...p,
        reference_image_multiple:[...p.reference_image_multiple,...items.map(item=>item.type==='image'?item.image!:encodingFor(item,referenceModel,item.importInfo?.information_extracted??1)!)],
        reference_strength_multiple:[...p.reference_strength_multiple,...items.map(item=>item.importInfo?.strength??.6)],
        reference_information_extracted_multiple:[...p.reference_information_extracted_multiple,...items.map(item=>item.importInfo?.information_extracted??1)],
        vibe_files:[...(p.vibe_files??Array(p.reference_image_multiple.length).fill(null)),...items],
      }};
      setDraft(next);setPage('draw');setMobileTab('edit');notify(`已导入 ${items.length} 项 Vibe 数据`);
    } catch(e){if(seq===generation.current)fail(e);}
  }
  function exportVibes(indices: number[]) {
    try {
      const current=draftRef.current,referenceModel=effectiveModelForOperation(current.model,current.operation);
      const p=current.parameters,items=indices.map(i=>{
        const source=p.reference_image_multiple[i],extracted=p.reference_information_extracted_multiple[i]??1,strength=p.reference_strength_multiple[i]??.6;
        if(!source)throw new Error('Vibe 数据已不存在');
        const existing=p.vibe_files?.[i];
        if(existing?.type==='encoding' && !encodingFor(existing,referenceModel,extracted))throw new Error('当前模型与此编码不匹配，无法按当前设置导出');
        const item:VibeFileItem=existing?structuredClone(existing):makeVibeFile(source,referenceModel,extracted,strength);
        item.importInfo={model:referenceModel,information_extracted:extracted,strength,...(existing?.importInfo?.mask?{mask:existing.importInfo.mask}:{})};
        if(item.type==='image') {
          const key=vibeModelKey(referenceModel), cached=p.vibe_encodings?.[vibeKey(source,referenceModel,extracted)];
          if(key && cached && !item.importInfo.mask)(item.encodings[key]??={})[vibeParameterHash(extracted)]={encoding:cached,params:{information_extracted:extracted}};
        }
        return item;
      });
      const output=vibeDownload(items);local.download(output.blob,output.name);
    } catch(e){fail(e);}
  }
  async function openImages(files:File[]) {
    if(!user)return;
    if (pageRef.current === 'director') {
      if (files.length !== 1) { fail(new Error('导演工具每次选择一张原图。')); return; }
      await uploadDirectorImage(files[0]);
      return;
    }
    const seq=generation.current,owner=identity.current,originPage=pageRef.current,selection=++importSequence.current;
    const current=()=>seq===generation.current && owner===identity.current && originPage===pageRef.current && selection===importSequence.current;
    try {
      if(files.length>16)throw new Error('一次最多导入 16 张图片');
      const images:ImportedImage[]=[];
      for(const file of files){images.push(await readImage(file));if(!current())return;}
      setImports(images);setDragging(false);
    } catch(e){if(current())fail(e);}
  }
  function importParameters(options:ImportOptions) {
    const metadata=imports[0]?.metadata;if(!metadata)return;
    const next=applyMetadata(draftRef.current,metadata,options),models=caps?.models??fallbackModels;
    if(!models.some(m=>m.id===next.model)){fail(new Error('图片中的模型当前不可用，请取消“模型与生成设置”后导入'));return;}
    const limit=models.find(m=>m.id===effectiveModelForOperation(next.model,next.operation))?.max_characters??0;
    if(next.parameters.character_prompts.length>limit){fail(new Error(`当前模型最多支持 ${limit} 个角色，请调整导入选项`));return;}
    setDraft(next);setImports(v=>v.slice(1));setPage('draw');setMobileTab('edit');notify('已导入选中的参数');
  }
  async function useAs(operation: Operation | "vibe" | "character", row = selected) {
    if (!row) return;
    const seq = generation.current,
      owner = identity.current, originPage = pageRef.current, selection = ++importSequence.current;
    // Decoding a large local image must not overwrite a newer import or reopen a page the user left.
    const current = () => seq === generation.current && owner === identity.current && originPage === pageRef.current && selection === importSequence.current;
    try {
      if (!row.result.media_type.startsWith("image/"))
        throw new Error("请选择一张图片。");
      const image=await readImage(new File([row.blob],row.result.filename,{type:row.blob.type||row.result.media_type}));
      if (!current()) return;
      acceptImage(operation==='img2img'?'image':operation as ImageUse,image);
    } catch (e) {
      if (current()) fail(e);
    }
  }
  async function reuse(row: LocalImage) {
    if (row.job.operation === 'augment') {
      patchDirector(directorFromJob(row.job, row.id));
      setPage('director');
      notify('已回填导演工具的原图和参数');
      return;
    }
    const seq = generation.current;
    let actual: ImportedImage | undefined;
    try { actual = await readImage(new File([row.blob], row.result.filename, { type: row.result.media_type })); } catch { /* Old or non-PNG results retain their request parameters. */ }
    if (seq !== generation.current) return;
    setSelectedId(row.id);
    setBlankCanvas(false);
    const j = row.job;
    setDraft((d) => {
      const restored: Draft = {
      ...d,
      model: j.model,
      operation: j.operation,
      prompt: j.prompt,
      artist: "",
      quality: "",
      qualityPreset: "none", ucPreset: "none", furryMode: false,
      negative: j.negative_prompt,
      parameters: {
        ...structuredClone(defaultParameters),
        ...structuredClone(j.parameters),
        ...(Array.isArray(j.parameters.vibe_source_images)?{reference_image_multiple:j.parameters.vibe_source_images as string[]}:{}),
        ...(Array.isArray(j.parameters.vibe_source_files)?{vibe_files:j.parameters.vibe_source_files as (VibeFileItem|null)[]}:{}),
        vibe_encodings:d.parameters.vibe_encodings,
      },
      count: 1,
      };
      if (actual) { restored.parameters.width = actual.width; restored.parameters.height = actual.height; }
      return actual?.metadata ? applyMetadata(restored, actual.metadata, { prompt: true, negative: true, characters: true, settings: true, seed: true, append: false, cleanBrackets: false }) : restored;
    });
    setPage("draw");
    setMobileTab("edit");
    notify(actual?.metadata ? "已从成图回填参数" : "图片没有可读参数，已回填原请求（可能与成图不同）");
  }
  async function removeLocal(row: LocalImage) {
    const seq = generation.current,
      owner = identity.current;
    const accepted = await askConfirmation({
      title: "移除本机图片？",
      message: "这项结果会从本机图库移除。已导出的备份和服务器副本不会改变。",
      confirmLabel: "确认移除",
    });
    if (!accepted || seq !== generation.current || owner !== identity.current)
      return;
    try {
      await local.removeImage(owner, row.id);
      const images = await local.gallery(owner);
      if (seq !== generation.current || owner !== identity.current) return;
      setRows(images);
      notify("已从本机图库移除");
    } catch (e) {
      if (seq === generation.current) fail(e);
    }
  }
  async function backup() {
    const seq = generation.current,
      owner = identity.current,
      scope = canvasScope.current;
    try {
      const exported = await local.exportBackup(owner, draft, scope);
      if (seq !== generation.current || owner !== identity.current || scope !== canvasScope.current) return;
      downloadBackup(exported.blobs, exported.setId);
      const partNote = exported.blobs.length > 1
        ? `共 ${exported.blobs.length} 个文件；请全部保存，导入时一次选中。` : "";
      if (exported.projectsUnavailable || exported.omitted) {
        const warning = exported.projectsUnavailable
          ? "备份已导出，但本机画布工程读取失败，文件不含这些工程。图库与草稿仍已导出。"
          : `备份已导出；${exported.omitted} 个画布工程未纳入（其中 ${exported.referencedOmitted} 个关联当前草稿或历史任务）。本机原工程未删除，未纳入工程的图层无法靠此备份恢复。`;
        setBackupWarning(`${warning} ${partNote}`.trim());
        notify(`${warning} ${partNote}`.trim());
      } else {
        setBackupWarning(partNote);
        notify(`备份已开始下载，包含 ${exported.projects} 个画布工程。${partNote}`);
      }
    } catch (e) {
      if (seq === generation.current) fail(e);
    }
  }
  function downloadBackup(blobs: Blob[], setId: string) {
    const name = `nai-workbench-${new Date().toISOString().slice(0, 10)}`;
    for (const [index, blob] of blobs.entries()) {
      const suffix = blobs.length === 1 ? "" : `-${setId}-part-${String(index + 1).padStart(2, "0")}-of-${String(blobs.length).padStart(2, "0")}`;
      local.download(blob, `${name}${suffix}.json`);
    }
  }
  async function restore(files: File[]) {
    const seq = generation.current,
      owner = identity.current,
      scope = canvasScope.current;
    let ordered: File[];
    try { ordered = local.orderBackupFiles(files); }
    catch (e) { fail(e); return; }
    const accepted = await askConfirmation({
      title: "导入备份？",
      message: `将导入 ${ordered.length} 个备份文件，合并本机图库和画布工程，并替换绘图草稿、导演工具草稿与提示词预设。`,
      confirmLabel: "确认导入",
    });
    if (!accepted || seq !== generation.current || owner !== identity.current || scope !== canvasScope.current)
      return;
    let imported = 0;
    let imageCount = 0;
    let projectCount = 0;
    let warning = "";
    let restoredDraft: Draft | undefined;
    try {
      for (const file of ordered) {
        const result = await local.importBackup(owner, file, scope);
        imported++;
        imageCount += result.count;
        projectCount += result.projects;
        if (result.draft) restoredDraft = result.draft;
        if (result.projectsUnavailable || result.omittedProjects) {
          warning = result.projectsUnavailable
            ? "这份备份未包含画布工程；图库与草稿已导入，原工程图层无法从此文件恢复。"
            : `这份备份省略了 ${result.omittedProjects} 个画布工程（其中 ${result.referencedOmitted} 个关联草稿或历史任务）；相关图层无法从此文件恢复。`;
        }
      }
      if (seq !== generation.current || owner !== identity.current || scope !== canvasScope.current) return;
      const images = await local.gallery(owner);
      if (seq !== generation.current || owner !== identity.current) return;
      setRows(images);
      if (restoredDraft) setDraft(migrateDirectorDraft(restoredDraft));
      if (warning) {
        setBackupWarning(warning);
        notify(`已导入 ${imageCount} 项结果、${projectCount} 个画布工程；${warning}`);
      } else {
        setBackupWarning("");
        notify(`已导入 ${imageCount} 项结果、${projectCount} 个画布工程`);
      }
    } catch (e) {
      if (seq === generation.current) {
        if (imported) {
          setRows(await local.gallery(owner));
          if (restoredDraft) setDraft(migrateDirectorDraft(restoredDraft));
          setBackupWarning(`已导入 ${imported}/${ordered.length} 个文件；请重新选择整组备份重试。`);
        }
        fail(e);
      }
    }
  }
  const models = caps?.models?.length ? caps.models : fallbackModels;
  const effectiveOperation = page === "batch" && !usesGenerationSettings(draft.operation) ? "generate" : draft.operation;
  const configurationIssue = configurationIssueFor({ ...draft, operation: effectiveOperation }, models, caps?.operations);
  const generationBlocked = Boolean(configurationIssue || (quoteError && !quoteError.retryable));
  const maxCharacters = models.find(m => m.id === effectiveModelForOperation(draft.model, effectiveOperation))?.max_characters ?? 6;
  const batchCapacityIssue = isGate && batchTasks().length + queuePending > MAX_PENDING
    ? `本次 ${batchTasks().length} 张，队列还可加入 ${Math.max(0, MAX_PENDING - queuePending)} 张。` : "";
  const characters = (
    <Section
      name="角色提示词"
      number="02"
      initial
    >
      <label className="field">角色定位
        <select aria-label="角色定位" value={draft.parameters.use_coords === true ? "manual" : "auto"} onChange={e => setParam("use_coords", e.target.value === "manual")}>
          <option value="auto">自动安排位置</option><option value="manual">手动指定位置</option>
        </select>
      </label>
      <div className="characters">
        {draft.parameters.character_prompts.map((c, i) => (
          <div className="character-editor" key={i}>
            <header>
              <span>角色 {i + 1}</span>
              <label><input aria-label={`启用角色 ${i + 1}`} type="checkbox" checked={c.enabled !== false} onChange={e => setParam("character_prompts", draft.parameters.character_prompts.map((v,j) => j === i ? {...v, enabled:e.target.checked} : v))}/>启用</label>
              {[-1, 1].map(offset => <button key={offset} aria-label={`${offset < 0 ? "上移" : "下移"}角色 ${i + 1}`} disabled={i + offset < 0 || i + offset >= draft.parameters.character_prompts.length} onClick={() => { const next = [...draft.parameters.character_prompts]; [next[i], next[i+offset]] = [next[i+offset], next[i]]; setParam("character_prompts", next); }}>{offset < 0 ? "↑" : "↓"}</button>)}
              <button
                className="icon-button"
                aria-label={`删除角色 ${i + 1}`}
                onClick={() =>
                  setParam(
                    "character_prompts",
                    draft.parameters.character_prompts.filter(
                      (_, j) => i !== j,
                    ),
                  )
                }
              >
                <X size={14} />
              </button>
            </header>
            <textarea
              aria-label={`角色 ${i + 1} 提示词`}
              rows={3}
              placeholder="角色的外观、服装与动作"
              value={c.prompt}
              onChange={(e) =>
                setParam(
                  "character_prompts",
                  draft.parameters.character_prompts.map((v, j) =>
                    j === i ? { ...v, prompt: e.target.value } : v,
                  ),
                )
              }
            />
            <textarea
              aria-label={`角色 ${i + 1} 负面词`}
              rows={2}
              placeholder="此角色的负面提示词"
              value={c.negative_prompt}
              onChange={(e) =>
                setParam(
                  "character_prompts",
                  draft.parameters.character_prompts.map((v, j) =>
                    j === i ? { ...v, negative_prompt: e.target.value } : v,
                  ),
                )
              }
            />
            {draft.parameters.use_coords === true && <><div className="character-position-grid" aria-label={`角色 ${i+1} 画面位置`}>
              {[.1,.5,.9].flatMap((y,yi) => [.1,.5,.9].map((x,xi) => <button key={`${x}-${y}`} aria-label={`角色 ${i+1} 定位 ${["上","中","下"][yi]}${["左","中","右"][xi]}`} aria-pressed={c.x === x && c.y === y} onClick={() => setParam("character_prompts", draft.parameters.character_prompts.map((v,j) => j===i?{...v,x,y}:v))}>·</button>))}
            </div><div className="field-grid">
              {(["x", "y"] as const).map((axis) => (
                <Field key={axis} label={`位置 ${axis.toUpperCase()}`}>
                  <NumberInput
                    label={`角色 ${i + 1} ${axis}`}
                    value={c[axis]}
                    min={0}
                    max={1}
                    step={0.1}
                    onChange={(n) =>
                      setParam(
                        "character_prompts",
                        draft.parameters.character_prompts.map((v, j) =>
                          j === i ? { ...v, [axis]: n } : v,
                        ),
                      )
                    }
                  />
                </Field>
              ))}
            </div></>}
          </div>
        ))}
      </div>
      <button
        disabled={draft.parameters.character_prompts.length >= maxCharacters}
        onClick={() =>
          setParam("character_prompts", [
            ...draft.parameters.character_prompts,
            { prompt: "", negative_prompt: "", x: 0.5, y: 0.5 },
          ])
        }
      >
        <Plus size={15} />
        添加角色
      </button>
    </Section>
  );
  const refs = (
    <ReferenceImages
      draft={draft}
      models={models}
      operations={caps?.operations}
      patch={patchDraft}
      onUpload={(kind, file) => { void uploadImage(kind, file); }}
      onImport={() => importInput.current?.click()}
      onNewCanvas={openBlankDrawingCanvas}
      onEditSource={openSourceCanvas}
      onPixelSource={openSourcePixelSnap}
      onMask={() => { setPendingMaskDraft(null); setShowMask(true); }}
      onImportVibe={file => { void importVibeData(file); }}
      onExportVibes={exportVibes}
    />
  );
  const updateBatch = (patch: Partial<BatchDraft>) =>
    setDraft((d) => ({ ...d, batch: { ...d.batch, ...patch } }));
  const updateBatchItem = (index: number, patch: Partial<BatchItem>) =>
    setDraft((d) => ({
      ...d,
      batch: {
        ...d.batch,
        items: d.batch.items.map((it, i) =>
          i === index ? { ...it, ...patch } : it,
        ),
      },
    }));

  const officialDraw = Boolean(user && page === "draw");
  return (
    <div
      onDragOver={e=>{if(user && Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';setDragging(true);}}}
      onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false);}}
      onDrop={e=>{if(Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();setDragging(false);if(user)void openImages(Array.from(e.dataTransfer.files));}}}
      onPaste={e=>{const files=Array.from(e.clipboardData.items).filter(i=>i.kind==='file' && i.type.startsWith('image/')).map(i=>i.getAsFile()).filter((f):f is File=>!!f);if(user && files.length){e.preventDefault();void openImages(files);}}}
      className={`app theme-official ${officialDraw ? "official-draw" : ""} ${user && page === 'director' ? 'director-page' : ''} ${!user ? "login-screen" : ""}`}
    >
      <input ref={importInput} hidden type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="导入图片文件" onChange={e=>{void openImages(Array.from(e.target.files??[]));e.target.value='';}}/>
      {dragging && user && <div className="image-drop-overlay">松开导入图片<span>{page === 'director' ? '载入导演工具原图' : '选择图生图、Vibe、精准参考或导入生成参数'}</span></div>}
      {user && !showMask && imports.length>0 && <ImageImportDialog key={imports[0].name+imports.length} image={imports[0]} remaining={imports.length} model={effectiveModelForOperation(draft.model,draft.operation)} onClose={()=>{importSequence.current++;setImports([]);}} onUse={kind=>{try{acceptImage(kind,imports[0]);setImports(v=>v.slice(1));}catch(e){fail(e);}}} onMetadata={importParameters}/>}
      {user && <WorkspaceHeader page={page} onPage={setPage} user={user} isMock={isMock} pending={queuePending}
        onQueue={() => setShowQueue(true)} onLibrary={() => setShowLibrary("all")}
        onNewCanvas={openBlankDrawingCanvas}
        onBlankCanvas={() => { setBlankCanvas(true); setPage("draw"); setMobileTab("result"); }} />}
      {user && isGate && (queuePending > 0 || queuePaused || encodingPaused) && <div className="queue-status-banner" role="status">
        <div className="queue-status-copy"><span>{queueMessage}</span><small><GateQueueStatus monitor={serverQueue}/></small></div>
        <button onClick={() => setShowQueue(true)}>查看队列</button>
      </div>}
      {(failure || notice) && (
        <div
          className={`message-bar ${failure ? "error" : ""}`}
          role={failure ? "alert" : "status"}
        >
          <span>{failure || notice}</span>
          <button
            className="icon-button"
            aria-label="关闭消息"
            onClick={() => {
              setFailure("");
              setNotice("");
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {!user ? (
        <main className="login-page">
          <form
            className="login-form"
            aria-labelledby="login-title"
            onSubmit={(e) => {
              e.preventDefault();
              void connect(loginToken, loginBase);
            }}
          >
            <header className="login-heading">
              <Paintbrush size={30} strokeWidth={1.6} aria-hidden="true" />
              <h1 id="login-title">NAI 工作台</h1>
            </header>
            <Field label={isGate ? "Gate Key" : "访问口令"}>
              <input
                autoFocus
                type="password"
                autoComplete="current-password"
                value={loginToken}
                onChange={(e) => setLoginToken(e.target.value)}
                placeholder={isGate ? "输入现有 Gate 的 Key" : "输入本站访问口令"}
                aria-describedby="login-token-help"
                required
              />
            </Field>
            <p id="login-token-help" className="login-help">
              {isGate ? "使用现有 Gate 分配的 Key，无需填写 NovelAI 官方密钥。" : "由工作台维护者提供，无需填写 NovelAI 密钥。"}
            </p>
            <button className="primary" disabled={connecting}>
              {connecting && <LoaderCircle className="spin" size={17} />}
              {connecting ? "连接中…" : "进入绘图"}
            </button>
            {!isGate && <details className="connection-extra" open={Boolean(base) || undefined}>
              <summary>
                连接其他服务
                <ChevronDown size={14} />
              </summary>
              <Field label="服务地址">
                <input
                  type="url"
                  value={loginBase}
                  onChange={(e) => setLoginBase(e.target.value)}
                  placeholder="留空连接当前站点"
                  autoComplete="url"
                />
              </Field>
            </details>}
          </form>
        </main>
      ) : (
        <>
          {page === "draw" && (
            <OfficialWorkspace
              draft={draft}
              patch={patchDraft}
              setParam={setParam}
              models={models}
              operations={caps?.operations}
              user={user}
              isMock={isMock}
              busy={busy}
              pending={queuePending}
              quote={quote}
              quoteError={quoteError}
              configurationIssue={configurationIssue}
              quoteRequest={() => void requestQuote()}
              submit={() => void submitMain()}
              characters={characters}
              references={refs}
              rows={drawingRows}
              selected={blankCanvas ? undefined : drawingSelected}
              select={(row) => { setSelectedId(row.id); setBlankCanvas(false); }}
              renderImage={(row) => <ImageView row={row} />}
              preview={blankCanvas ? undefined : preview}
              onSuggestTags={isGate ? suggestTags : undefined}
              onLibrary={() => setShowLibrary("all")}
              onNegativeLibrary={() => setShowLibrary("negative")}
              onFinal={() => setShowFinal(true)}
              onQueue={() => setShowQueue(true)}
              onPage={setPage}
              mobile={mobileTab}
              onMobileChange={setMobileTab}
              onEnlarge={() => { if (drawingSelected) { setSelectedId(drawingSelected.id); setLightbox(true); } }}
              onReuse={() => drawingSelected && reuse(drawingSelected)}
              onEditSelected={(row) => void openResultCanvas(row)}
              onPixelSelected={(row) => void openResultPixelSnap(row)}
              onUseAs={(operation) => void useAs(operation, drawingSelected)}
              onSave={() =>
                drawingSelected &&
                local.download(drawingSelected.blob, drawingSelected.result.filename)
              }
            />
          )}
          {page === 'director' && api && <DirectorWorkspace
            key={identity.current} state={director} onChange={patchDirector} api={api}
              operations={caps?.operations} busy={busy}
            rows={rows.filter(row => row.job.operation === 'augment')}
            jobs={jobs.filter(job => job.operation === 'augment')}
            onSubmit={task => void submit([task])}
            onUpload={file => void uploadDirectorImage(file)}
            onSelectResult={row => patchDirector(directorFromJob(row.job, row.id))}
            onUseResult={row => void useAs('img2img', row)}
            onContinue={row => void useAs('augment', row)}
            onPixel={source => setPixelInput({image:source.data,width:source.width,height:source.height,target:'director'})}
            renderImage={row => <ImageView row={row}/>}
          />}
          {page === "batch" && (
            <main className="batch-page">
              <div className="page-title">
                <div>
                  <h1>批量绘图</h1>
                  <p>各组使用下方公共参数，按顺序逐张生成。</p>
                </div>
                <button onClick={() => setPage("draw")}>
                  <SlidersHorizontal size={15} />
                  编辑公共参数
                </button>
              </div>
              <section className="batch-config-summary" aria-label="批量公共生成参数">
                <div><span>生成方式</span><b>{labels[["generate", "img2img", "inpaint"].includes(draft.operation) ? draft.operation : "generate"]}</b></div>
                <div><span>模型</span><b>{(models.find(model => model.id === draft.model)?.name ?? draft.model).replace(/^NAI Diffusion /, "")}</b></div>
                <div><span>尺寸 / 步数</span><b>{draft.parameters.width}×{draft.parameters.height} · {draft.parameters.steps} 步</b></div>
                <div><span>种子</span><b>{draft.parameters.seed < 0 ? "每张随机" : draft.parameters.seed}</b></div>
                <div><span>源图 / 蒙版</span><b>{["img2img", "inpaint"].includes(draft.operation) ? `源图${draft.parameters.image ? "已设置" : "未设置"}${draft.operation === "inpaint" ? ` · 蒙版${draft.parameters.mask ? "已设置" : "未设置"}` : ""}` : "未使用"}</b></div>
                <div><span>角色 / 图像参考</span><b>{draft.parameters.character_prompts.filter(character => character.enabled !== false).length} 角色 · {draft.parameters.reference_image_multiple.length} Vibe · {draft.parameters.character_reference_images.length} 精准参考</b></div>
                {!["generate", "img2img", "inpaint"].includes(draft.operation) && <p>当前绘图页为图片工具；批量页使用文生图。</p>}
                {["img2img", "inpaint"].includes(draft.operation) && <p>所有组共用当前源图{draft.operation === "inpaint" ? "和蒙版" : ""}。</p>}
              </section>
              <div className="batch-shared">
                <div className="batch-shared-heading">
                  <h2>辅助提示词</h2>
                  <span>三项可分别选择共用或独立</span>
                </div>
                <div className="batch-strings">
                  {stringKeys.map((key) => (
                    <div key={key}>
                      <div className="batch-field-heading">
                        <label htmlFor={`shared-${key}`}>
                          {stringLabels[key]}
                        </label>
                        <div className="segmented">
                          <button
                            className={draft.batch.unified[key] ? "active" : ""}
                            onClick={() =>
                              updateBatch({
                                unified: {
                                  ...draft.batch.unified,
                                  [key]: true,
                                },
                              })
                            }
                          >
                            统一填写
                          </button>
                          <button
                            className={
                              !draft.batch.unified[key] ? "active" : ""
                            }
                            onClick={() =>
                              updateBatch({
                                unified: {
                                  ...draft.batch.unified,
                                  [key]: false,
                                },
                              })
                            }
                          >
                            每组单独
                          </button>
                        </div>
                      </div>
                      {draft.batch.unified[key] ? (
                        <textarea
                          id={`shared-${key}`}
                          rows={3}
                          value={draft.batch.shared[key]}
                          onChange={(e) =>
                            updateBatch({
                              shared: {
                                ...draft.batch.shared,
                                [key]: e.target.value,
                              },
                            })
                          }
                          placeholder={`五套任务共用${stringLabels[key]}`}
                        />
                      ) : (
                        <div className="separate-hint">
                          在每张任务卡内分别填写
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="batch-list">
                {draft.batch.items.map((item, index) => (
                  <article
                    className={`batch-card ${!item.enabled ? "disabled" : ""}`}
                    key={item.id}
                  >
                    <header>
                      <label className="batch-check">
                        <input
                          type="checkbox"
                          aria-label={`启用第 ${index + 1} 组`}
                          checked={item.enabled}
                          onChange={(e) =>
                            updateBatchItem(index, {
                              enabled: e.target.checked,
                            })
                          }
                        />
                        <b>{String(index + 1).padStart(2, "0")}</b>
                        <span>提示词 {index + 1}</span>
                      </label>
                      <div>
                        <Field label="张数">
                          <NumberInput
                            label={`任务 ${index + 1} 张数`}
                            min={1}
                            max={20}
                            value={item.count}
                            onChange={(n) =>
                              updateBatchItem(index, { count: n })
                            }
                          />
                        </Field>
                        <button
                          title="清空主提示词"
                          aria-label={`清空任务 ${index + 1} 提示词`}
                          className="icon-button"
                          onClick={() => updateBatchItem(index, { prompt: "" })}
                        >
                          <RotateCcw size={14} />
                        </button>
                      </div>
                    </header>
                    <textarea
                      aria-label={`批量提示词 ${index + 1}`}
                      rows={5}
                      value={item.prompt}
                      placeholder={`粘贴第 ${index + 1} 套完整提示词…`}
                      onChange={(e) =>
                        updateBatchItem(index, { prompt: e.target.value })
                      }
                    />
                    {stringKeys
                      .filter((k) => !draft.batch.unified[k])
                      .map((key) => (
                        <Field key={key} label={stringLabels[key]}>
                          <textarea
                            rows={2}
                            aria-label={`任务 ${index + 1} ${stringLabels[key]}`}
                            value={item[key]}
                            onChange={(e) =>
                              updateBatchItem(index, { [key]: e.target.value })
                            }
                          />
                        </Field>
                      ))}
                    {item.prompt.trim() ? <div className="batch-token-meters">
                      <TokenMeter model={effectiveModelForOperation(draft.model,effectiveOperation)} label="正面" text={composePrompts(draft,item.prompt,batchStrings(item)).prompt}
                        characterTexts={draft.parameters.character_prompts.filter(character=>character.enabled!==false).map(character=>character.prompt)}/>
                      <TokenMeter model={effectiveModelForOperation(draft.model,effectiveOperation)} label="负面" text={composePrompts(draft,item.prompt,batchStrings(item)).negative}
                        characterTexts={draft.parameters.character_prompts.filter(character=>character.enabled!==false).map(character=>character.negative_prompt)}/>
                    </div> : <small className="batch-token-empty">填写本组提示词后显示 Token 占用</small>}
                    <footer>
                      <span>{item.enabled ? '当前组' : '未启用'}</span>
                      <button
                        disabled={!item.enabled || !item.prompt.trim() || busy || generationBlocked}
                        onClick={() => void submit(batchTasks(index))}
                      >
                        <Play size={13} />
                        生成本组 · {Math.max(1, Math.min(20, Math.floor(item.count)))} 张
                      </button>
                    </footer>
                    <details className="batch-history">
                      <summary>本组历史结果 <span>{rows.filter(r => r.job.label === `批量 ${String(index + 1).padStart(2, "0")}`).length}</span></summary>
                      <div className="batch-results">
                      {rows
                        .filter(
                          (r) =>
                            r.job.label ===
                            `批量 ${String(index + 1).padStart(2, "0")}`,
                        )
                        .slice(0, 8)
                        .map((r) => (
                          <div className="batch-history-item" key={r.id}>
                          <button
                            aria-label={`查看历史图片：${r.job.prompt}`}
                            onClick={() => {
                              setSelectedId(r.id);
                              setBlankCanvas(false);
                              setPage("draw");
                              setMobileTab("result");
                            }}
                          >
                            <ImageView row={r} />
                          </button>
                          <p title={r.job.prompt}>{r.job.prompt || labels[r.job.operation]}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  </article>
                ))}
              </div>
              <div className="batch-submit">
                <span>
                  <b>{batchTasks().length}</b> 张待生成{" "}
                  {!configurationIssue && quote && <small title={quote.message}>预计消耗 {quoteUnitLabel((quote.generation_units ?? quote.units) * batchTasks().length + (batchTasks().length ? quote.encoding_units ?? 0 : 0))}</small>}
                  {configurationIssue ? <small className="batch-quote-error" role="status">{configurationIssue.message} <button onClick={() => { setPage("draw"); setMobileTab("edit"); }}>编辑公共参数</button></small> : quoteError && <small className="batch-quote-error" role="status">{quoteError.message} {quoteError.retryable ? <button onClick={() => void requestQuote()}>重试报价</button> : quoteError.connection ? <button onClick={() => setPage("settings")}>检查连接</button> : <button onClick={() => { setPage("draw"); setMobileTab("edit"); }}>检查公共参数</button>}</small>}
                  <small>{batchCapacityIssue || "空白任务自动跳过 · 逐张生成，限流后自动继续"}</small>
                </span>
                <button
                  className="primary"
                  disabled={busy || batchTasks().length === 0 || generationBlocked || Boolean(batchCapacityIssue)}
                  onClick={() => void submit(batchTasks())}
                >
                  <Play size={16} fill="currentColor" />
                  生成已勾选组 · {batchTasks().length} 张
                  <ArrowRight size={16} />
                </button>
              </div>
            </main>
          )}
          {page === "gallery" && (
            <main className="gallery-page">
              <div className="page-title">
                <div>
                  <small>保存在此浏览器</small>
                  <h1>
                    本机图库 <em>{rows.length}</em>
                  </h1>
                  <p>保存在此浏览器。换设备前，记得导出备份。</p>
                </div>
                <div className="page-actions">
                  <input
                    aria-label="搜索图库"
                    placeholder="搜索提示词或任务名称"
                    value={galleryQuery}
                    onChange={(e) => setGalleryQuery(e.target.value)}
                  />
                  <button onClick={() => void backup()}>
                    <Download size={15} />
                    导出备份
                  </button>
                  <label className="button">
                    <Upload size={15} />
                    导入
                    <input
                      type="file"
                      hidden
                      multiple
                      accept="application/json,.json"
                      onChange={(e) => {
                        const selected = Array.from(e.target.files ?? []);
                        if (selected.length) void restore(selected);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>
              {!rows.length ? (
                <div className="gallery-empty">
                  <FolderOpen size={42} />
                  <h2>还没有收藏到本机的作品</h2>
                  <p>生成完成后会自动保存。也可以导入之前的完整备份。</p>
                  <button onClick={() => setPage("draw")}>
                    开始绘图
                    <ArrowRight size={15} />
                  </button>
                </div>
              ) : (
                <div className="gallery-grid">
                  {rows
                    .filter((r) =>
                      (r.job.prompt + " " + r.job.label)
                        .toLowerCase()
                        .includes(galleryQuery.toLowerCase()),
                    )
                    .map((row) => (
                      <article key={row.id}>
                        <button
                          className="gallery-image"
                          onClick={() => {
                            setSelectedId(row.id);
                            setBlankCanvas(false);
                            setLightbox(true);
                          }}
                        >
                          <ImageView row={row} />
                          {row.result.metadata.mock === true && (
                            <span>模拟</span>
                          )}
                        </button>
                        <div className="gallery-info">
                          <span>{row.job.label || "未命名作品"}</span>
                          <small>
                            {new Date(row.stored_at).toLocaleDateString()}
                          </small>
                        </div>
                        <p title={row.job.prompt}>{row.job.prompt}</p>
                        <div className="gallery-actions">
                          <button onClick={() => reuse(row)}>
                            <Copy size={13} />
                            回填
                          </button>
                          <button
                            onClick={() =>
                              local.download(row.blob, row.result.filename)
                            }
                            aria-label="下载图片"
                          >
                            <Download size={14} />
                          </button>
                          <button
                            onClick={() => void removeLocal(row)}
                            aria-label="移除本机图片"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
              )}
            </main>
          )}
          {page === "settings" && (
            <main className="settings-page">
              <div className="page-title">
                <div>
                  <small>工作台设置</small>
                  <h1>设置</h1>
                  <p>连接、绘图偏好与本机备份。</p>
                </div>
              </div>
              <div className="settings-grid">
                <section>
                  <div className="settings-heading">
                    <Users size={19} />
                    <h2>当前连接</h2>
                  </div>
                  <dl>
                    <dt>身份</dt>
                    <dd>{user.name}</dd>
                    <dt>服务</dt>
                    <dd>{base || location.origin}</dd>
                    <dt>运行方式</dt>
                    <dd>
                      {isMock
                        ? "本地模拟 · 不调用 NovelAI"
                        : isGate ? "现有 Gate · 页面内串行队列" : "NovelAI · 实际能力待验证"}
                    </dd>
                    <dt>{isGate ? "可用 Anlas" : "个人可用额度"}</dt>
                    <dd>
                      {user.quota.remaining}{" "}
                      {!isGate && <span className="muted">
                        已用 {user.quota.used} · 预留 {user.quota.reserved}
                      </span>}
                    </dd>
                    {user.gate_quota && <><dt>今日 V5 可用</dt><dd>{user.gate_quota.v5Unlimited ? '未设张数限制' : `${user.gate_quota.v5LeftToday} 次`}</dd></>}
                  </dl>
                  <button onClick={disconnect}>
                    <LogOut size={15} />
                    退出并切换口令
                  </button>
                  <p className="muted small">
                    口令只保留到当前标签页会话结束。
                  </p>
                </section>
                <section>
                  <div className="settings-heading">
                    <SlidersHorizontal size={19} />
                    <h2>绘图与输入</h2>
                  </div>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={draft.parameters.stream === true}
                      onChange={(e) => setParam("stream", e.target.checked)}
                    />
                    <span>
                      <b>生成中流式预览</b>
                      <small>开启后请求生成过程的预览；关闭后只在完成时显示图片。</small>
                    </span>
                  </label>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={draft.tagSuggestionsDisabled !== true}
                      onChange={(e) => patchDraft({ tagSuggestionsDisabled: !e.target.checked })}
                    />
                    <span>
                      <b>提示词标签建议</b>
                      <small>输入提示词时查询标签；关闭后不再发送这类查询。</small>
                    </span>
                  </label>
                  <p className="muted small">这些选项随当前 Key 的本机草稿保存，对新任务生效。</p>
                </section>
                <section>
                  <div className="settings-heading">
                    <Save size={19} />
                    <h2>本地与服务器副本</h2>
                  </div>
                  <p>{isGate ? '结果直接保存到当前浏览器，服务器不保留图片。批量生成时请保持页面打开，等待本机保存完成。' : '完整结果先暂存在服务器，再领取到本机图库。'}</p>
                  {isGate ? <p className="muted small">本机图库按 Key 隔离。更换 Key、浏览器或访问地址前请导出备份，新 Key 下可导入恢复。</p> : storage ? (
                    <>
                      <label className="setting-toggle">
                        <input
                          type="checkbox"
                          checked={storage.mode === "retain_until_expiry"}
                          onChange={(e) =>
                            setStorage((s) =>
                              s
                                ? {
                                    ...s,
                                    mode: e.target.checked
                                      ? "retain_until_expiry"
                                      : "delete_after_ack",
                                  }
                                : s,
                            )
                          }
                        />
                        <span>
                          <b>本地保存后保留服务器副本</b>
                          <small>
                            {storage.mode === "retain_until_expiry"
                              ? "保留到期，期间可重新领取。"
                              : "本地保存成功后删除服务器副本。"}
                          </small>
                        </span>
                      </label>
                      <Field label="服务器暂存期限（小时）">
                        <NumberInput
                          label="暂存期限"
                          value={storage.retention_hours}
                          min={1}
                          max={720}
                          onChange={(n) =>
                            setStorage((s) =>
                              s ? { ...s, retention_hours: n } : s,
                            )
                          }
                        />
                      </Field>
                      <button
                        onClick={async () => {
                          try {
                            if (api) {
                              const s = await api.request<StorageSettings>(
                                "/settings",
                                storage,
                                "PUT",
                              );
                              setStorage(s);
                              notify("保存策略已更新，对新任务生效");
                              void refresh();
                            }
                          } catch (e) {
                            fail(e);
                          }
                        }}
                      >
                        <Check size={15} />
                        保存设置
                      </button>
                      <p className="muted small">
                        变更只影响新任务；尚未领取的结果也会到期清理。
                      </p>
                    </>
                  ) : (
                    <>
                      <dl>
                        <dt>保留策略</dt>
                        <dd>
                          {user.storage_policy.mode === "retain_until_expiry"
                            ? "保留到期"
                            : "本机保存后删除"}
                        </dd>
                        <dt>暂存期限</dt>
                        <dd>{user.storage_policy.retention_hours} 小时</dd>
                      </dl>
                      <p className="muted small">
                        保存策略由工作台维护者设置。
                      </p>
                    </>
                  )}
                </section>
                <section>
                  <div className="settings-heading">
                    <FolderOpen size={19} />
                    <h2>备份与迁移</h2>
                  </div>
                  <p>备份包含原图、参数、参考图、草稿、提示词预设，并优先收录当前口令下正在使用的可编辑画布工程。画布工程最多收录 128 项、512 MB；若有省略会在这里显示数量，本机原工程不会删除。</p>
                  {backupWarning && <p className="muted small" role="alert">{backupWarning}</p>}
                  <div className="settings-actions">
                    <button onClick={() => void backup()}>
                      <ArrowDownToLine size={16} />
                      导出本机备份
                    </button>
                    <label className="button">
                      <Upload size={16} />
                      导入备份
                      <input
                        type="file"
                        hidden
                        multiple
                        accept="application/json,.json"
                        onChange={(e) => {
                          const selected = Array.from(e.target.files ?? []);
                          if (selected.length) void restore(selected);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  <p className="muted small">
                    本机图库不会自动跨设备同步。清除浏览器数据前请备份。
                  </p>
                </section>
                {user.is_admin && api && (
                  <AccessManagement key={user.id} api={api} onError={fail} />
                )}
              </div>
            </main>
          )}
          {!officialDraw && page !== 'director' && (
            <footer className="status-bar">
              <span>
                <i className={syncing ? "working" : ""} />
                {syncing ? "正在保存到本机" : "本机图库"}
                <b>{rows.length}</b>
              </span>
              <button onClick={() => setShowQueue(!showQueue)}>
                <Clock size={13} />
                任务队列 <b>{queuePending}</b>
                {queuePending > 0 && (
                  <LoaderCircle size={12} className="spin" />
                )}
              </button>
              <span className="status-right">
                {user.name}
                <span className="status-divider" />{" "}
                {isMock
                  ? "模拟输出不消耗 NAI 额度"
                  : isGate ? `积分 ${user.quota.remaining} · 今日 V5 ${user.gate_quota?.v5Unlimited ? '不限' : `${user.gate_quota?.v5LeftToday ?? '—'} 次`}` : `剩余额度 ${user.quota.remaining}`}
              </span>
            </footer>
          )}
        </>
      )}
      {showQueue && user && (
        <div className="drawer-backdrop" onClick={() => setShowQueue(false)}>
          <aside
            className="queue-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="任务队列"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <small>排队与生成状态</small>
                <h2>
                  任务队列 <span>{queuePending}</span>
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭任务队列"
                onClick={() => setShowQueue(false)}
              >
                <X />
              </button>
            </header>
            <div className="queue-toolbar">
              <span>{isGate ? "请保持页面打开；图片保存后继续下一张。最新任务显示在上方，执行仍按提交顺序。" : "关闭页面后，已提交的任务仍继续执行。"}</span>
              <button
                className="icon-button"
                aria-label="刷新队列"
                onClick={() => void refresh()}
              >
                <RefreshCw size={16} />
              </button>
            </div>
            {isGate && <div className="queue-controls">
              <span>{queuePending || queuePaused ? queueMessage : '队列按提交顺序执行'}</span>
              <button disabled={!queuePending && !queuePaused && !encodingPaused} onClick={async () => {
                try {
                  await api?.request(queuePaused ? "/queue/resume" : "/queue/pause", {});
                  setQueuePaused(!queuePaused);
                  void refresh();
                } catch (error) { fail(error); }
              }}>{queuePaused ? <Play size={14}/> : <Pause size={14}/>} {queuePaused ? "继续后续任务" : "暂停后续任务"}</button>
            </div>}
            {isGate && <div className="queue-server-summary" role="status"><GateQueueStatus monitor={serverQueue}/></div>}
            {(encodingRetryAt || encodingPaused) && <p className="queue-wait" role="status">{encodingPaused || queuePaused ? "Vibe 编码已暂停，继续后续任务后恢复。" : `Vibe 编码：${queueWaitLabel(encodingWaitReason)}，${countdown(encodingRetryAt)} 秒后自动重试。`}</p>}
            <div className="queue-list">
              {jobs.length ? (
                displayJobs.map((job) => (
                  <article key={job.id}>
                    <div className="job-title">
                      <span className={`job-status status-${job.status}`}>
                        {job.status === "running" && (
                          <LoaderCircle size={12} className="spin" />
                        )}
                        {(isGate && job.status === 'succeeded' && job.results.some(r => !r.acknowledged && !r.deleted) ? '生成完成' : undefined) || (isGate && gateJobLabel(job, queueNow)) || statusNames[job.status]}
                      </span>
                      <small>
                        {new Date(job.created_at * 1000).toLocaleTimeString()}
                      </small>
                    </div>
                    <h3>{job.label || labels[job.operation]}</h3>
                    <p>{job.prompt || labels[job.operation]}</p>
                    {job.status === "waiting" && <div className="queue-wait" role="status">{queuePaused ? "已暂停，继续队列后恢复等待" : `${countdown(job.retry_at)} 秒后自动重试`}</div>}
                    {job.error && <div className="job-error">{job.error}</div>}
                    {saveIssue && job.results.some(r => r.id === saveIssue.resultId) && <div className="job-error" role="alert">{saveIssue.message}</div>}
                    {job.status === "unknown" && (
                      <div className="job-error">
                        上游结果不明确，未自动重新生成。请先核对。
                      </div>
                    )}
                    <footer>
                      <span>
                        {job.parameters?.width}×{job.parameters?.height}
                      </span>
                      {["queued", "waiting"].includes(job.status) && (
                        <button
                          onClick={async () => {
                            try {
                              await api?.request(`/jobs/${job.id}/cancel`, {});
                              void refresh();
                            } catch (e) {
                              fail(e);
                            }
                          }}
                        >
                          <Square size={12} />
                          取消
                        </button>
                      )}
                      {["failed", "cancelled"].includes(job.status) && (
                        <button
                          onClick={() =>
                            void submit([
                              {
                                request_id: uuid(),
                                operation: job.operation,
                                model: job.model,
                                prompt: job.prompt,
                                negative_prompt: job.negative_prompt,
                                parameters: job.parameters,
                                label: job.label,
                              },
                            ])
                          }
                        >
                          <RotateCcw size={12} />
                          重新提交
                        </button>
                      )}
                      {job.status === "succeeded" && (
                        <small>
                          {job.results.every((r) => r.deleted)
                            ? "服务器副本已清理"
                            : job.results.every((r) => r.acknowledged)
                              ? "已保存本机"
                              : saveIssue && job.results.some(r => r.id === saveIssue.resultId)
                                ? saveIssue.saved ? "已保存本机，等待确认" : "保存失败，正在重试"
                                : "等待保存到本机"}
                        </small>
                      )}
                    </footer>
                  </article>
                ))
              ) : (
                <div className="queue-empty">暂无生成任务</div>
              )}
            </div>
          </aside>
        </div>
      )}
      {showLibrary && (
        <div className="modal-backdrop">
          <section
            className="modal preset-modal"
            role="dialog"
            aria-modal="true"
            aria-label={showLibrary === "negative" ? "负面提示词预设" : "提示词预设"}
          >
            <header>
              <div>
                <small>常用提示词</small>
                <h2>{showLibrary === "negative" ? "负面提示词预设" : "提示词预设"}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭预设"
                onClick={() => setShowLibrary(false)}
              >
                <X />
              </button>
            </header>
            <div className="modal-content">
              {showLibrary === "negative" && (
                <p className="muted">仅载入所选预设的负面词，其他提示词保持不变。</p>
              )}
              <form
                className="preset-save"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!presetName.trim()) return;
                  setDraft((d) => ({
                    ...d,
                    presets: [
                      ...d.presets,
                      {
                        id: uuid(),
                        name: presetName.trim(),
                        qualityPreset:d.qualityPreset, ucPreset:d.ucPreset, furryMode:d.furryMode,
                        prompt: d.prompt,
                        artist: d.artist,
                        quality: d.quality,
                        negative: d.negative,
                      },
                    ],
                  }));
                  setPresetName("");
                  notify("已保存当前提示词");
                }}
              >
                <input
                  aria-label="预设名称"
                  placeholder="给当前提示词起个名字"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <button type="submit">
                  <Plus size={15} />
                  保存当前整套提示词
                </button>
              </form>
              <div className="preset-list">
                {draft.presets.length ? (
                  draft.presets.map((p) => (
                    <article key={p.id}>
                      <div>
                        <h3>{p.name}</h3>
                        <p>{showLibrary === "negative" ? (p.negative || "无负面词（载入将清空当前负面词）") : (p.prompt || p.artist || p.quality || p.negative)}</p>
                      </div>
                      <button
                        onClick={() => {
                          // Negative preset loading preserves all other active prompt fields.
                          patchDraft(showLibrary === "negative" ? { negative: p.negative, ucPreset: p.ucPreset ?? "none" } : {
                            qualityPreset:p.qualityPreset ?? "none", ucPreset:p.ucPreset ?? "none", furryMode:p.furryMode ?? false,
                            prompt: p.prompt,
                            artist: p.artist,
                            quality: p.quality,
                            negative: p.negative,
                          });
                          setShowLibrary(false);
                          notify(showLibrary === "negative" ? "已载入负面提示词" : "已载入提示词预设");
                        }}
                      >
                        载入
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`删除预设 ${p.name}`}
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            presets: d.presets.filter((v) => v.id !== p.id),
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </article>
                  ))
                ) : (
                  <p className="muted">保存常用提示词，下次直接取用。</p>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
      {showFinal && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="最终提示词"
          >
            <header>
              <h2>最终发送的提示词</h2>
              <button
                className="icon-button"
                aria-label="关闭最终提示词"
                onClick={() => setShowFinal(false)}
              >
                <X />
              </button>
            </header>
            <div className="modal-content">
              <Field label="正面提示词">
                <textarea
                  rows={9}
                  readOnly
                  value={draft.operation === "upscale" || draft.operation === "encode_vibe" ? "（此操作不发送提示词）" : draft.operation === "augment" && draft.parameters.req_type === "emotion" ? `${draft.parameters.emotion ?? "neutral"};;${draft.prompt}` : taskFor().prompt}
                />
              </Field>
              <Field label="负面提示词">
                <textarea rows={5} readOnly value={usesGenerationSettings(draft.operation) ? taskFor().negative_prompt : "（此操作不发送负面词）"} />
              </Field>
            </div>
          </section>
        </div>
      )}
      {showMask && (pendingMaskDraft ?? draft).parameters.image && (
        <MaskEditor
          image={(pendingMaskDraft ?? draft).parameters.image!}
          initial={(pendingMaskDraft ?? draft).parameters.mask}
          onClose={closeMask}
          onSave={saveMask}
        />
      )}
      {user && canvasInput && <div className="modal-backdrop">
        <CanvasEditor image={canvasInput.image} width={canvasInput.width} height={canvasInput.height} scope={canvasInput.scope}
          onCancel={() => setCanvasInput(null)}
          onSave={async ({data,width,height,project}) => {
            const seq = generation.current, owner = identity.current, scope = canvasInput.scope;
            if (!owner || scope !== canvasScope.current) throw new Error('当前连接已改变，请重新打开画布。');
            // Commit the editable project before replacing the draft with a flat PNG.
            await local.saveCanvasProject(scope, data, project);
            if (seq !== generation.current || owner !== identity.current || scope !== canvasScope.current)
              throw new Error('连接已改变，画布未应用到当前草稿。');
            acceptImage('image',{name:'画布编辑.png',data,width,height});
            setCanvasInput(null);
            notify('合成图已设为图生图源图；可编辑工程已保存在本机，原蒙版已清空');
          }}/>
      </div>}
      {user && pixelInput && <LocalPixelSnap image={pixelInput.image} width={pixelInput.width} height={pixelInput.height}
        saveLabel={pixelInput.target === 'director' ? '用作导演原图' : undefined}
        onCancel={() => setPixelInput(null)}
        onSave={({data,width,height}) => {
          try {
            if (pixelInput.target === 'director') {
              openDirector({data,width,height,name:'像素整理.png'});
              setPixelInput(null);
              notify('像素整理结果已设为导演原图');
              return;
            }
            acceptImage('image',{name:'pixel-cleanup.png',data,width,height});
            setPixelInput(null);
            notify('本地像素整理结果已设为图生图源图；原蒙版已清空');
          } catch(error) { fail(error); }
        }}/>
      }
      {lightbox && selected && <ImageViewer row={selected} rows={rows} onSelect={setSelectedId} onClose={() => setLightbox(false)}/>}
      {confirmation && (
        <div className="modal-backdrop confirmation-backdrop">
          <section
            className="modal confirmation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirmation-title"
            aria-describedby="confirmation-message"
          >
            <header>
              <h2 id="confirmation-title">{confirmation.title}</h2>
              <button
                className="icon-button"
                aria-label="取消确认"
                onClick={() => settleConfirmation(false)}
              >
                <X />
              </button>
            </header>
            <div className="modal-content">
              <p id="confirmation-message">{confirmation.message}</p>
              <div className="confirmation-actions">
                <button onClick={() => settleConfirmation(false)}>取消</button>
                <button
                  className="primary"
                  onClick={() => settleConfirmation(true)}
                >
                  {confirmation.confirmLabel}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

