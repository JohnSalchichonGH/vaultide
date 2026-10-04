import type { Page, Request, Response } from '@playwright/test';

/**
 * `page.goto`, once the page's own router has nothing left on the network.
 *
 * The app's forms show their success message and call `router.refresh()` in
 * the same breath, so a test that waits for the message and then navigates
 * can start its navigation while that refresh is still in flight. Chromium
 * lets the refresh finish. WebKit cancels the page's in-flight requests as
 * soon as a new navigation starts, before the page unloads, so Next.js sees
 * the refresh fail, logs "Failed to fetch RSC payload … Falling back to
 * browser navigation", and navigates to the page the save was on. That
 * navigation replaces the test's, and `page.goto` fails with "Navigation to
 * <target> is interrupted by another navigation to <the page the save was
 * on>".
 *
 * So this first waits until every router request the page has made has
 * ended. A router request is a GET carrying `RSC: 1` that is not a prefetch.
 * It is what a refresh or a client navigation fetches. Prefetches are left
 * out: when one fails, Next.js discards it and does not navigate. Server
 * actions are POSTs, and a save's action has answered before its message is
 * shown.
 *
 * Why the wait is reliable:
 *
 *  - The refresh is already listed when this runs. The form calls
 *    `router.refresh()` in the same block that sets the message, and the
 *    router starts the fetch before React renders that message. The test
 *    calls this only after it has seen the message.
 *  - "Ended" is decided by Playwright's server, which records each
 *    response as finished when it completes or fails. `response.body()`
 *    resolves only after that, whether or not the body can still be read.
 *    `response.finished()` cannot be used: it hangs for a request that ended
 *    before the test asked about it, and for one that fails after its
 *    response, as Chromium reports for these refreshes.
 *  - A request that ended can no longer be cancelled, so nothing is left for
 *    a navigation to interrupt. The list is read again until it shows no new
 *    router request, in case one router request queues another.
 */
export async function gotoAfterRefresh(page: Page, url: string): Promise<Response | null> {
  const seen = new Set<Request>();
  for (;;) {
    const fresh = (await page.requests()).filter((request) => isRouterFetch(request) && !seen.has(request));
    if (fresh.length === 0) break;
    for (const request of fresh) seen.add(request);
    await Promise.all(fresh.map(ended));
  }
  return page.goto(url);
}

function isRouterFetch(request: Request): boolean {
  const headers = request.headers();
  return request.method() === 'GET' && headers.rsc === '1' && headers['next-router-prefetch'] === undefined;
}

async function ended(request: Request): Promise<void> {
  // Null when the request failed before any response came back.
  const response = await request.response();
  // Whether a request that failed, or belongs to a page already left, still
  // has a readable body does not matter here. Only that it has ended does.
  await response?.body().catch(() => undefined);
}
