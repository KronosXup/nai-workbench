import { ApiError } from "./api";

type Mode = "gate" | "mock" | "nai";

async function serverMode(base: string): Promise<Mode> {
  // Detect the destination without credentials; a saved address must not receive a Key first.
  const response = await fetch(`${base}/api/health`, {
    cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new ApiError("暂时无法确认服务状态，请稍后重试。", response.status);
  const health = await response.json();
  if (!["gate", "mock", "nai"].includes(health?.mode)) throw new Error("服务类型无效，连接已取消。");
  return health.mode;
}

export async function connectionTarget(savedAddress: string) {
  const currentMode = await serverMode("");
  // A Gate deployment always uses its same-origin bridge, regardless of old browser settings.
  if (currentMode === "gate") return { base: "", gate: true };
  const base = savedAddress.trim().replace(/\/$/, "");
  if (base && !/^https?:\/\//i.test(base)) throw new Error("服务地址需要以 http:// 或 https:// 开头。");
  const mode = base ? await serverMode(base) : currentMode;
  return { base, gate: mode === "gate" };
}
