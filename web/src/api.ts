// Browser-side helpers for talking to the radio plugin's HTTP surface.
// Under the bot proxy: window.location.origin is the bot, __PLUGIN_BASE__
// is "/plugin/karyl-radio", so requests hit the bot reverse-proxy which
// forwards to the plugin. In direct-access mode __PLUGIN_BASE__ is "" so
// API resolves to same-origin.
//
// Two auth modes:
//  - "session": the bot's plugin-session JWT, sent verbatim as Bearer for
//    every /api/session/* call. Stored in sessionStorage under
//    SESSION_TOKEN_KEY.
//  - "manage": the SPA exchanges the bot's manage JWT (15 min) for a
//    plugin-issued access+refresh pair on first load. Access (5 min) is
//    used as Bearer; on 401 the wrapper transparently tries one /refresh
//    and retries the request. The pair lives in sessionStorage under
//    MANAGE_TOKENS_KEY so a tab reload survives without re-running the
//    Discord command.

const API_BASE = window.location.origin + (window.__PLUGIN_BASE__ || "");

const SESSION_TOKEN_KEY = "radio_token";
const MANAGE_TOKENS_KEY = "radio_manage_tokens";

export interface ManageTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

type Mode = "none" | "session" | "manage";

let _mode: Mode = "none";
let _sessionToken: string | null = null;
let _manage: ManageTokens | null = null;
let _onDenied: ((msg: string) => void) | null = null;

export function onAccessDenied(handler: (msg: string) => void): void {
  _onDenied = handler;
}

// ── Token state ────────────────────────────────────────────────────────

function bearerToken(): string | null {
  if (_mode === "session") return _sessionToken;
  if (_mode === "manage") return _manage?.accessToken ?? null;
  return null;
}

export function setSessionToken(token: string | null): void {
  _sessionToken = token;
  _mode = token ? "session" : "none";
  if (token) sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  else sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

export function setManageTokens(t: ManageTokens): void {
  _manage = t;
  _mode = "manage";
  sessionStorage.setItem(MANAGE_TOKENS_KEY, JSON.stringify(t));
  // Drop the bot JWT if it was previously stored — manage mode lives
  // entirely on plugin tokens past the exchange.
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

function clearAll(): void {
  _mode = "none";
  _sessionToken = null;
  _manage = null;
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem(MANAGE_TOKENS_KEY);
}

/** The cached session JWT (or null), for callers that need to read its
 *  claims (e.g. to recover the guildId after a tab reload). */
export function getStoredSessionToken(): string | null {
  return _mode === "session" ? _sessionToken : null;
}

/** Read whichever token storage has a usable entry, restore in-memory
 *  state, and report which mode is active. Called once at SPA boot for
 *  tab-reload cases. */
export function loadStoredAuth(): Mode {
  const m = sessionStorage.getItem(MANAGE_TOKENS_KEY);
  if (m) {
    try {
      const parsed: ManageTokens = JSON.parse(m);
      if (
        typeof parsed.refreshToken === "string" &&
        typeof parsed.refreshExpiresAt === "number" &&
        parsed.refreshExpiresAt > Date.now()
      ) {
        _manage = parsed;
        _mode = "manage";
        return "manage";
      }
    } catch {
      // fall through
    }
    sessionStorage.removeItem(MANAGE_TOKENS_KEY);
  }
  const s = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (s) {
    _sessionToken = s;
    _mode = "session";
    return "session";
  }
  return "none";
}

// ── JWT decode (for the URL bot-JWT only) ─────────────────────────────

function b64urlDecode(s: string): string {
  let r = s.replace(/-/g, "+").replace(/_/g, "/");
  while (r.length % 4) r += "=";
  return decodeURIComponent(
    atob(r)
      .split("")
      .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join(""),
  );
}

export interface JwtClaims {
  guildId?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

export function decodeJwt(token: string): JwtClaims | null {
  try {
    const payload = JSON.parse(b64urlDecode(token.split(".")[1]));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** Pull `?token=<jwt>` off the URL (and strip the param from history),
 *  so the bot JWT only lives in memory after first read. */
export function readTokenFromUrl(): string | null {
  const u = new URL(window.location.href);
  const fromUrl = u.searchParams.get("token");
  if (!fromUrl) return null;
  u.searchParams.delete("token");
  history.replaceState(
    null,
    "",
    u.pathname + (u.search || "") + (u.hash || ""),
  );
  return fromUrl;
}

// ── Manage exchange / refresh ─────────────────────────────────────────

/** POST the bot manage JWT to /exchange to get a plugin access+refresh
 *  pair. Returns null on failure (caller routes to DeniedView). */
export async function exchangeManageJwt(
  botJwt: string,
): Promise<ManageTokens | null> {
  try {
    const res = await fetch(API_BASE + "/api/manage/exchange", {
      method: "POST",
      headers: { Authorization: "Bearer " + botJwt },
    });
    if (!res.ok) return null;
    return (await res.json()) as ManageTokens;
  } catch {
    return null;
  }
}

async function tryRefresh(): Promise<boolean> {
  if (_mode !== "manage" || !_manage) return false;
  if (_manage.refreshExpiresAt <= Date.now()) return false;
  try {
    const res = await fetch(API_BASE + "/api/manage/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: _manage.refreshToken }),
    });
    if (!res.ok) return false;
    const next = (await res.json()) as ManageTokens;
    setManageTokens(next);
    return true;
  } catch {
    return false;
  }
}

// ── HTTP wrapper ──────────────────────────────────────────────────────

async function handleRes(res: Response): Promise<any> {
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({ error: "Access denied" }));
    const msg = body?.error || "Access denied";
    clearAll();
    _onDenied?.(msg);
    throw new Error(msg);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body?.error || "Request failed");
  }
  if (res.status === 204) return {};
  return res.json().catch(() => ({}));
}

function buildInit(method: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + (bearerToken() ?? ""),
  };
  const opts: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  return opts;
}

export async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res = await fetch(API_BASE + path, buildInit(method, body));
  // Manage mode: if the access token has expired, refresh once and retry
  // before surfacing a 401 as access-denied.
  if (res.status === 401 && _mode === "manage" && (await tryRefresh())) {
    res = await fetch(API_BASE + path, buildInit(method, body));
  }
  return handleRes(res);
}

/** multipart/form-data upload — the browser sets the boundary. Same
 *  refresh-on-401 behaviour as `api()`. */
export async function apiUpload<T = any>(
  path: string,
  file: File,
): Promise<T> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const send = (): Promise<Response> =>
    fetch(API_BASE + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + (bearerToken() ?? "") },
      body: fd,
    });
  let res = await send();
  if (res.status === 401 && _mode === "manage" && (await tryRefresh())) {
    res = await send();
  }
  return handleRes(res);
}
