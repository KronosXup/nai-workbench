import { ApiError } from "./api";

export async function verifyGateHealth() {
  // Confirm the same-origin service before the Gate Key is sent.
  const response = await fetch("/api/health", {
    cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new ApiError("暂时无法确认服务状态，请稍后重试。", response.status);
  const health = await response.json();
  if (health?.mode !== "gate") throw new Error("服务类型无效，连接已取消。");
}
