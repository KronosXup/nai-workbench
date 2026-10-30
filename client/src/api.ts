import { DISCORD_SESSION_ACCESS_TOKEN } from './auth';

// Preserve HTTP status so invalid settings are not presented as retryable outages.
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export class Api {
  private workbenchIdentity?: string;
  protected authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      ...(this.accessToken === DISCORD_SESSION_ACCESS_TOKEN && this.workbenchIdentity
        ? { 'X-Workbench-Identity': this.workbenchIdentity } : {}),
    };
  }
  constructor(
    public base: string,
    protected accessToken: string,
  ) {}
  async request<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.base.replace(/\/$/, "")}/api${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...this.authHeaders(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) {
      let message = `请求失败 (${response.status})`;
      try {
        const data = await response.json();
        message =
          typeof data.detail === "string"
            ? data.detail
            : JSON.stringify(data.detail ?? data);
      } catch {
        /* keep status */
      }
      throw new ApiError(message, response.status);
    }
    const data = await response.json();
    if (path === '/me' && this.accessToken === DISCORD_SESSION_ACCESS_TOKEN) {
      if (typeof data?.id !== 'string' || !data.id || (this.workbenchIdentity && this.workbenchIdentity !== data.id))
        throw new ApiError('Discord 登录身份已改变，请重新登录。', 401);
      this.workbenchIdentity = data.id;
    }
    return data as T;
  }
}
