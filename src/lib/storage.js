// Thin wrappers over chrome.storage. Everything stays in this browser profile.
// storage.local holds the token, settings and caches, and is closed to content scripts
// (lockDownStorage). storage.session holds what the view on github.com needs: the latest
// results, refresh progress and a hasToken flag, never the token itself.

import { scopeOf } from "./runs.js";

const DEFAULT_SETTINGS = { scope: "scheduled", notify: false, notifyPass: false, notifyMine: false, missedAfterHours: 12 };

/** Run from the background worker at every start: content scripts can't read the token. */
export async function lockDownStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
}

/** Copy what the view needs into storage.session (cleared when the browser restarts). */
export async function syncViewState() {
  const { token, snapshot } = await chrome.storage.local.get(["token", "snapshot"]);
  await chrome.storage.session.set({ hasToken: Boolean(token), snapshot: snapshot ?? null });
}

export async function getToken() {
  const { token } = await chrome.storage.local.get("token");
  return token || "";
}

export async function setToken(token) {
  await chrome.storage.local.set({ token });
  await chrome.storage.session.set({ hasToken: Boolean(token) });
}

export async function clearToken() {
  await chrome.storage.local.remove(["token", "login", "snapshot", "scheduleCache", "httpCache"]);
  await chrome.storage.session.remove(["snapshot", "refreshState"]);
  await chrome.storage.session.set({ hasToken: false });
}

export async function getLogin() {
  const { login } = await chrome.storage.local.get("login");
  return login || "";
}

export async function setLogin(login) {
  await chrome.storage.local.set({ login });
}

/** Saved settings over the defaults; settings saved before scopes existed only have `scheduledOnly`. */
export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const saved = settings || {};
  const rest = { ...saved };
  delete rest.scheduledOnly;
  return { ...DEFAULT_SETTINGS, ...rest, scope: scopeOf(saved) };
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export async function getSnapshot() {
  const { snapshot } = await chrome.storage.local.get("snapshot");
  return snapshot || null;
}

/** Save the latest results and update the toolbar badge with the failure count. */
export async function setSnapshot(snapshot) {
  await chrome.storage.local.set({ snapshot });
  await chrome.storage.session.set({ snapshot });
  await updateBadge(snapshot);
}

/** Forget the results, for example after the token or the scope changed. */
export async function clearSnapshot() {
  await chrome.storage.local.remove("snapshot");
  await chrome.storage.session.remove("snapshot");
}

/** Refresh progress and errors, for every open view. */
export async function setRefreshState(refreshState) {
  await chrome.storage.session.set({ refreshState });
}

export async function updateBadge(snapshot) {
  const count = snapshot?.entries ? snapshot.entries.filter((e) => e.state === "failed" || e.state === "missed").length : 0;
  await chrome.action.setBadgeBackgroundColor({ color: "#cf222e" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
}
