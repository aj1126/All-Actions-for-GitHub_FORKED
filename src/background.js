import { loadSnapshot, TokenError, RateLimitError } from "./lib/github.js";
import {
  getToken, getLogin, getSettings, getSnapshot, setSnapshot, updateBadge, lockDownStorage, syncViewState, setRefreshState,
} from "./lib/storage.js";
import { newProblems, newPasses, graceMs, pickProblems } from "./lib/runs.js";

export const VIEW_URL = "https://github.com/?all-actions";
const REFRESH_MINUTES = 30;

// Every time the worker starts: close storage.local (the token) to content scripts, then give
// the github.com view its copy of the results in storage.session.
const ready = (async () => {
  await lockDownStorage();
  await syncViewState();
})();

let running = null;

/** Fetch fresh results. Progress and errors go to storage so every open view can show them. */
function refresh() {
  if (running) return running;
  running = (async () => {
    const token = await getToken();
    if (!token) return;
    const { scope, notify, notifyPass, notifyMine, missedAfterHours } = await getSettings();
    const login = await getLogin();
    const previous = await getSnapshot();
    const { scheduleCache = {}, httpCache = {} } = await chrome.storage.local.get(["scheduleCache", "httpCache"]);
    await setRefreshState({ running: true, done: 0, total: 0, at: Date.now() });
    try {
      const result = await loadSnapshot(token, {
        scope,
        login,
        grace: graceMs(missedAfterHours),
        previous,
        scheduleCache,
        httpCache,
        onProgress: (done, total) => setRefreshState({ running: true, done, total, at: Date.now() }),
      });
      await chrome.storage.local.set({ scheduleCache: result.scheduleCache, httpCache: result.httpCache });
      await setSnapshot(result.snapshot);
      if (previous?.fetchedAt) {
        if (notify || notifyMine) await notifyProblems(pickProblems(newProblems(previous, result.snapshot), { notify, notifyMine }));
        if (notifyPass) await notifyPasses(newPasses(previous, result.snapshot));
      }
      await setRefreshState({ running: false });
    } catch (e) {
      const kind = e instanceof TokenError ? "token" : e instanceof RateLimitError ? "rate" : "other";
      await setRefreshState({ running: false, error: { kind, message: e.message, resetAt: e.resetAt ?? null } });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Desktop notification for newly failed or missed workflows (opt-in from Settings). */
async function notifyProblems(problems) {
  const title = problems.length === 1 ? "A workflow needs attention" : `${problems.length} workflows need attention`;
  await showNotification(problems, title, (e) => (e.state === "failed" ? "failed" : "didn't run"), "problem");
}

/** Desktop notification for workflows whose latest run just passed (separate opt-in). */
async function notifyPasses(passes) {
  const title = passes.length === 1 ? "A workflow passed" : `${passes.length} workflows passed`;
  await showNotification(passes, title, () => "passed", "pass");
}

async function showNotification(entries, title, outcome, kind) {
  if (!entries.length) return;
  if (!(await chrome.permissions.contains({ permissions: ["notifications"] }))) return;
  const lines = entries.slice(0, 4).map((e) => `${e.repo.name} / ${e.workflow.name}: ${outcome(e)}`);
  if (entries.length > 4) lines.push(`and ${entries.length - 4} more`);
  await chrome.notifications.create(`all-actions-${kind}-${Date.now()}`, {
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
  // A view that found storage.session empty (after a browser restart) asks for its copy.
  if (message?.type === "sync-view") ready.then(syncViewState);
});

// Check in the background so the badge stays current.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh") refresh();
});

async function setUp() {
  await chrome.alarms.create("refresh", { periodInMinutes: REFRESH_MINUTES });
  // A refresh interrupted by a browser restart would otherwise look stuck.
  await setRefreshState({ running: false });
  await chrome.storage.local.remove("refreshState"); // where 0.8.0 kept it; it lives in storage.session now
  await updateBadge(await getSnapshot());
}

chrome.runtime.onStartup.addListener(setUp);
chrome.runtime.onInstalled.addListener(async (details) => {
  await setUp();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
