import type { Route } from 'next';

/**
 * Where a successful sign-in sends the user: the page `?next=` names, when it
 * is a page of this site, and `/` otherwise.
 *
 * Decided by resolving `next` against the page's own origin, the way the
 * browser will, never by its leading characters. `searchParams.get` hands over
 * the value already decoded, and the URL parser reads `\` as `/` in an
 * `http(s):` URL and drops tabs and newlines. So `/\elsewhere.example`,
 * `/<tab>/elsewhere.example` and `/<newline>/elsewhere.example` all start
 * with a single `/` and still resolve to another host.
 *
 * What comes back is the resolved path, query and fragment, not the raw value,
 * and it is kept only when pushing it lands on exactly the URL that was
 * checked. Resolving can itself produce a path that starts with `//`
 * (`/.//elsewhere.example` resolves to the path `//elsewhere.example`), and
 * pushed on its own that is a protocol-relative URL to another host.
 *
 * `origin` is the page's own, as `window.location.origin` gives it.
 */
export function returnPath(next: string | null, origin: string): Route {
  if (next !== null) {
    try {
      const checked = new URL(next, origin);
      const path = `${checked.pathname}${checked.search}${checked.hash}` as Route;
      if (checked.origin === origin && new URL(path, origin).href === checked.href) return path;
    } catch {
      // A value `URL` refuses names no page of this site.
    }
  }
  return '/';
}
