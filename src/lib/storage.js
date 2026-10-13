// Thin wrappers over chrome.storage.local. Everything stays in this browser profile.

const DEFAULT_SETTINGS = { scheduledOnly: true, notify: false };

export async function getToken() {
  const { token } = await chrome.storage.local.get("token");
  return token || "";
}

export async function setToken(token) {
  await chrome.storage.local.set({ token });
}

export async function clearToken() {
  await chrome.storage.local.remove(["token", "login", "snapshot", "scheduleCache", "httpCache"]);
}

export async function getLogin() {
  const { login } = await chrome.storage.local.get("login");
  return login || "";
}

export async function setLogin(login) {
  await chrome.storage.local.set({ login });
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
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
  await updateBadge(snapshot);
}

export async function updateBadge(snapshot) {
  const count = snapshot?.entries ? snapshot.entries.filter((e) => e.state === "failed" || e.state === "missed").length : 0;
  await chrome.action.setBadgeBackgroundColor({ color: "#cf222e" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
}
