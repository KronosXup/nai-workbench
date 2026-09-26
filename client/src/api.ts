// Preserve HTTP status so invalid settings are not presented as retryable outages.
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export class Api {
  constructor(
    public base: string,
    protected accessToken: string,
  ) {}
  async request<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.base.replace(/\/$/, "")}/api${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
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
    return response.json() as Promise<T>;
  }
}
