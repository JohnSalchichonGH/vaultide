import type { Auth } from '../../src/auth/config';

/**
 * A minimal HTTP client for the auth endpoints (blueprint 21.4).
 *
 * The suites drive Better Auth through `auth.handler(Request)` rather than
 * through `auth.api.*`, because the controls being tested live in the request
 * path: rate limiting, the `Origin` check, and the cookies a browser would
 * carry. Calling the API functions directly would skip all three and prove
 * nothing about them.
 */

export interface AuthResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export interface AuthClient {
  post<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<AuthResponse<T>>;
  get<T = unknown>(path: string, init?: RequestInit): Promise<AuthResponse<T>>;
  /** The cookie jar, so a test can assert a session was or was not issued. */
  readonly cookies: Map<string, string>;
  cookieHeader(): string;
  clearCookies(): void;
}

export function createAuthClient(
  auth: Auth,
  baseUrl: string,
  options: { origin?: string } = {},
): AuthClient {
  const cookies = new Map<string, string>();
  const origin = options.origin ?? baseUrl;

  function cookieHeader(): string {
    return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ''] = raw.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      // An expiry in the past is a deletion, which is how sign-out and
      // deletion clear the session.
      if (value === '' || /expires=Thu, 01 Jan 1970/iu.test(raw)) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function send<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    init: RequestInit = {},
  ): Promise<AuthResponse<T>> {
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    if (cookies.size > 0) headers.set('Cookie', cookieHeader());
    if (method === 'POST') headers.set('Content-Type', 'application/json');

    const request = new Request(`${baseUrl}/api/auth${path}`, {
      ...init,
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });

    const response = await auth.handler(request);
    absorb(response);

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      /* A redirect or an empty body; the raw text is what the caller gets. */
    }

    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  return {
    cookies,
    cookieHeader,
    clearCookies: () => cookies.clear(),
    post: (path, body, init) => send('POST', path, body, init),
    get: (path, init) => send('GET', path, undefined, init),
  };
}

/**
 * Pull the single-use token out of a captured verification or reset message.
 *
 * Better Auth puts it in the query string for verification
 * (`/verify-email?token=...`) and in the path for a reset
 * (`/reset-password/<token>?callbackURL=...`), so both shapes are read here.
 */
export function tokenFromUrl(text: string): string {
  const query = /[?&]token=([^&\s]+)/u.exec(text);
  if (query !== null) return decodeURIComponent(query[1] as string);

  const path = /\/reset-password\/([^/?\s]+)/u.exec(text);
  if (path !== null) return decodeURIComponent(path[1] as string);

  throw new Error('No token in the message.');
}

/** Pull the first link out of a captured message's plain-text part. */
export function urlFromMessage(text: string): string {
  const match = /https?:\/\/\S+/u.exec(text);
  if (match === null) throw new Error('No link in the message.');
  return match[0];
}
