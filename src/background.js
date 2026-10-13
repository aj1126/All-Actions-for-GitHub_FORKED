import { getSnapshot, updateBadge } from "./lib/storage.js";

const DASHBOARD = chrome.runtime.getURL("src/dashboard.html");

// Toolbar icon opens the All actions page.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: DASHBOARD });
});

// The injected links on github.com ask us to open the page in the same tab.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "open-dashboard") return;
  if (message.newTab || !sender.tab?.id) chrome.tabs.create({ url: DASHBOARD });
  else chrome.tabs.update(sender.tab.id, { url: DASHBOARD });
});

// Restore the badge after the browser restarts.
chrome.runtime.onStartup.addListener(async () => updateBadge(await getSnapshot()));
chrome.runtime.onInstalled.addListener(async (details) => {
  await updateBadge(await getSnapshot());
  if (details.reason === "install") chrome.tabs.create({ url: DASHBOARD });
});
