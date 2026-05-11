const ARGUS_AUTH_TOKEN_KEY = "argus.publicAuthToken";
const ARGUS_AUTH_TOKEN_CHANGED = "argus-auth-token-changed";

export type ArgusAuthSession = {
  authRequired: boolean;
  authenticated: boolean;
};

type RpcEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error?: string;
};

export function getStoredArgusAuthToken(): string {
  try {
    return window.localStorage.getItem(ARGUS_AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredArgusAuthToken(token: string) {
  try {
    if (token) window.localStorage.setItem(ARGUS_AUTH_TOKEN_KEY, token);
    else window.localStorage.removeItem(ARGUS_AUTH_TOKEN_KEY);
  } catch {
    /* ignore private mode / quota */
  }
  window.dispatchEvent(new Event(ARGUS_AUTH_TOKEN_CHANGED));
}

export function onArgusAuthTokenChanged(callback: () => void) {
  window.addEventListener(ARGUS_AUTH_TOKEN_CHANGED, callback);
  return () => window.removeEventListener(ARGUS_AUTH_TOKEN_CHANGED, callback);
}

export function argusAuthHeaders(): HeadersInit {
  const token = getStoredArgusAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readEnvelope<T>(res: Response): Promise<RpcEnvelope<T>> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as RpcEnvelope<T>;
  } catch {
    return { ok: false, error: `后端返回非 JSON（HTTP ${res.status}）` };
  }
}

export async function fetchArgusAuthSession(): Promise<ArgusAuthSession> {
  const res = await fetch("/api/auth/session", {
    headers: argusAuthHeaders(),
  });
  const data = await readEnvelope<ArgusAuthSession>(res);
  if (!res.ok || !data.ok || !data.result) {
    throw new Error(data.error || "无法检查访问会话");
  }
  return data.result;
}

export async function loginArgusPublicPassword(password: string): Promise<ArgusAuthSession> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...argusAuthHeaders(),
    },
    body: JSON.stringify({ password }),
  });
  const data = await readEnvelope<{ token?: string; session?: ArgusAuthSession }>(res);
  if (!res.ok || !data.ok || !data.result) {
    throw new Error(data.error || "访问密码不正确");
  }
  if (data.result.token) {
    setStoredArgusAuthToken(data.result.token);
  }
  return data.result.session ?? { authRequired: true, authenticated: true };
}

export function appendArgusAuthToken(url: string): string {
  const token = getStoredArgusAuthToken();
  if (!token) return url;
  const u = new URL(url, window.location.href);
  u.searchParams.set("argus_token", token);
  return u.toString();
}
