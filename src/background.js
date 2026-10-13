import { loadSnapshot, TokenError, RateLimitError } from "./lib/github.js";
import { getToken, getSettings, getSnapshot, setSnapshot, updateBadge } from "./lib/storage.js";

export const VIEW_URL = "https://github.com/?all-actions";
const REFRESH_MINUTES = 30;

let running = null;

/** Fetch fresh results. Progress and errors go to storage so every open view can show them. */
function refresh() {
  if (running) return running;
  running = (async () => {
    const token = await getToken();
    if (!token) return;
    const { scheduledOnly } = await getSettings();
    await chrome.storage.local.set({ refreshState: { running: true, done: 0, total: 0, at: Date.now() } });
    try {
      const snapshot = await loadSnapshot(token, {
        scheduledOnly,
        onProgress: (done, total) => chrome.storage.local.set({ refreshState: { running: true, done, total, at: Date.now() } }),
      });
      await setSnapshot(snapshot);
      await chrome.storage.local.set({ refreshState: { running: false } });
    } catch (e) {
      const kind = e instanceof TokenError ? "token" : e instanceof RateLimitError ? "rate" : "other";
      await chrome.storage.local.set({
        refreshState: { running: false, error: { kind, message: e.message, resetAt: e.resetAt ?? null } },
      });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

// Toolbar icon opens the All actions page on github.com.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: VIEW_URL });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "refresh") refresh();
  if (message?.type === "open-settings") chrome.runtime.openOptionsPage();
});

// Check in the background so the badge stays current.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh") refresh();
});

async function setUp() {
  await chrome.alarms.create("refresh", { periodInMinutes: REFRESH_MINUTES });
  // A refresh interrupted by a browser restart would otherwise look stuck.
  await chrome.storage.local.set({ refreshState: { running: false } });
  await updateBadge(await getSnapshot());
}

chrome.runtime.onStartup.addListener(setUp);
chrome.runtime.onInstalled.addListener(async (details) => {
  await setUp();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
