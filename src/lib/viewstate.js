// What the All actions view reads, and when it asks for a refresh. The view runs as a content
// script on github.com, so it reads storage.session (which the background worker opens to
// content scripts) and never storage.local, where the token is.

export const VIEW_KEYS = ["snapshot", "refreshState", "hasToken"];

const STALE_MS = 5 * 60 * 1000;
// A refresh that hasn't reported progress for this long was interrupted (for example the
// background worker was stopped), so the view stops treating it as running.
const STUCK_MS = 2 * 60 * 1000;

export const isRunning = (r, now = Date.now()) => Boolean(r?.running && now - (r.at || 0) < STUCK_MS);

/**
 * The view's state. `hasToken` is null until the background worker has filled storage.session
 * (it's empty after a browser restart, and may still be closed to content scripts).
 */
export async function readViewState() {
  const stored = await chrome.storage.session.get(VIEW_KEYS).catch(() => ({}));
  return {
    snapshot: stored.snapshot?.fetchedAt ? stored.snapshot : null,
    refreshState: stored.refreshState || null,
    hasToken: typeof stored.hasToken === "boolean" ? stored.hasToken : null,
  };
}

/** True for a storage change the view shows. */
export function isViewChange(area, changes) {
  return area === "session" && VIEW_KEYS.some((k) => k in changes);
}

/** Ask for fresh results: connected, no refresh going, and no results or old ones. */
export function shouldRefresh(state, now = Date.now()) {
  if (state.hasToken !== true || isRunning(state.refreshState, now)) return false;
  return !state.snapshot || now - Date.parse(state.snapshot.fetchedAt) > STALE_MS;
}
