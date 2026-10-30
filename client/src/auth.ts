// Public transport selector, not a credential. The bridge resolves the HttpOnly cookie.
export const DISCORD_SESSION_ACCESS_TOKEN = '__discord_session__';

const LOGIN_ERRORS: Record<string, string> = {
  not_registered: '尚未注册，请先在 Discord 使用 /register。',
  key_reclaimed: 'Key 已回收，请先在 Discord 使用 /find。',
  key_disabled: 'Key 已停用，请联系管理员。',
  key_expired: 'Key 已过期，请联系管理员。',
  auth_failed: 'Discord 登录失败，请重试。',
  state_invalid: '登录验证已失效，请重新登录。',
  service_unavailable: 'Discord 登录服务暂时不可用，请稍后重试或使用 API Key。',
};

export function loginErrorMessage(code: string | null): string {
  if (code === null) return '';
  return Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code] : LOGIN_ERRORS.auth_failed;
}

export function consumeLoginError(url: URL, history: Pick<History, 'state' | 'replaceState'>): string {
  const message = loginErrorMessage(url.searchParams.get('login_error'));
  if (url.searchParams.has('login_error')) {
    url.searchParams.delete('login_error');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return message;
}

// Only the public authenticated flag is consumed. Keys/session tokens never enter JS.
export async function restoreWorkbenchAccess(storedAccess: string, fetcher: typeof fetch = fetch): Promise<string> {
  const access = storedAccess.trim();
  if (access && access !== DISCORD_SESSION_ACCESS_TOKEN) return access;
  try {
    const response = await fetcher('/workbench-auth/session', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    if ([401, 403, 404].includes(response.status)) return '';
    if (!response.ok) throw new Error('session unavailable');
    const session = await response.json();
    return session?.authenticated === true ? DISCORD_SESSION_ACCESS_TOKEN : '';
  } catch {
    throw new Error(LOGIN_ERRORS.service_unavailable);
  }
}

// False means a legacy Key-only deployment has no OAuth service, not "cookie revoked".
export async function logoutWorkbenchSession(access: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher('/workbench-auth/logout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'X-Workbench-CSRF': '1' }, signal: AbortSignal.timeout(12000),
    });
    if ([404, 405].includes(response.status) && access.trim() !== DISCORD_SESSION_ACCESS_TOKEN) return false;
    if (!response.ok) throw new Error('logout unavailable');
    return true;
  } catch {
    throw new Error('未能确认登录会话已撤销，尚未退出，请稍后重试。');
  }
}
