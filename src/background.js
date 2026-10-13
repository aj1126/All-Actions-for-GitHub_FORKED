import { loadSnapshot, TokenError, RateLimitError } from "./lib/github.js";
import { getToken, getSettings, getSnapshot, setSnapshot, updateBadge } from "./lib/storage.js";
import { newProblems } from "./lib/runs.js";

export const VIEW_URL = "https://github.com/?all-actions";
const REFRESH_MINUTES = 30;

let running = null;

/** Fetch fresh results. Progress and errors go to storage so every open view can show them. */
function refresh() {
  if (running) return running;
  running = (async () => {
    const token = await getToken();
    if (!token) return;
    const { scheduledOnly, notify } = await getSettings();
    const previous = await getSnapshot();
    const { scheduleCache = {}, httpCache = {} } = await chrome.storage.local.get(["scheduleCache", "httpCache"]);
    await chrome.storage.local.set({ refreshState: { running: true, done: 0, total: 0, at: Date.now() } });
    try {
      const result = await loadSnapshot(token, {
        scheduledOnly,
        previous,
        scheduleCache,
        httpCache,
        onProgress: (done, total) => chrome.storage.local.set({ refreshState: { running: true, done, total, at: Date.now() } }),
      });
      await chrome.storage.local.set({ scheduleCache: result.scheduleCache, httpCache: result.httpCache });
      await setSnapshot(result.snapshot);
      if (notify && previous?.fetchedAt) await notifyProblems(newProblems(previous, result.snapshot));
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

/** Desktop notification for newly failed or missed workflows (opt-in from Settings). */
async function notifyProblems(problems) {
  if (!problems.length) return;
  if (!(await chrome.permissions.contains({ permissions: ["notifications"] }))) return;
  const describe = (e) => `${e.repo.name} / ${e.workflow.name}: ${e.state === "failed" ? "failed" : "didn't run"}`;
  const title = problems.length === 1 ? "A workflow needs attention" : `${problems.length} workflows need attention`;
  const lines = problems.slice(0, 4).map(describe);
  if (problems.length > 4) lines.push(`and ${problems.length - 4} more`);
  await chrome.notifications.create(`all-actions-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title,
    message: lines.join("\n"),
  });
}

// Clicking a notification opens the All actions page.
function onNotificationClick(id) {
  if (!id.startsWith("all-actions-")) return;
  chrome.tabs.create({ url: VIEW_URL });
  chrome.notifications.clear(id);
}
function listenForNotificationClicks() {
  // The notifications API only exists once the optional permission has been granted.
  if (chrome.notifications && !chrome.notifications.onClicked.hasListener(onNotificationClick)) {
    chrome.notifications.onClicked.addListener(onNotificationClick);
  }
}
listenForNotificationClicks();
chrome.permissions.onAdded.addListener(listenForNotificationClicks);

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
