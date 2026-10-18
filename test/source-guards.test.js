// AJ's version (docs/specs/aj-version.md): checks on files that need a browser to run (the view, the content
// script, the service worker, the settings page, the manifest), read as text so a regression fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("The github.com view never touches storage.local or the token (R2)", () => {
  // Calls only: a comment may name storage.local, and err.kind === "token" is an error kind, not the key.
  const localCall = /chrome\.storage\.local\.\w+\(/;
  const view = read("src/view.js");
  assert.equal(localCall.test(view), false, "view.js calls storage.local");
  assert.equal(/\.get\([^)]*["']token["']/.test(view), false, "view.js reads the token key");
  assert.equal(/changes\.token\b/.test(view), false, "view.js reads token changes");
  assert.ok(view.includes('from "./lib/viewstate.js"'), "view.js imports viewstate.js");
  const content = read("src/content.js");
  assert.equal(localCall.test(content), false, "content.js calls storage.local");
  assert.ok(content.includes('chrome.storage.session.get("snapshot")'), "content.js reads the snapshot from session");
  assert.ok(content.includes('area === "session"'), "content.js listens to session changes");
});

test("The worker locks storage down at start and keeps refreshState out of storage.local (R2)", () => {
  const bg = read("src/background.js");
  assert.ok(bg.includes("lockDownStorage()"), "background.js calls lockDownStorage()");
  assert.ok(bg.includes('message?.type === "sync-view"'), "background.js answers sync-view");
  assert.equal(/storage\.local\.set\(\{\s*refreshState/.test(bg), false, "background.js writes refreshState to storage.local");
  assert.ok(bg.includes("setRefreshState("), "background.js uses setRefreshState");
  assert.ok(bg.includes("pickProblems("), "background.js filters problems with pickProblems");
  assert.ok(bg.includes("getLogin()"), "background.js passes the login for runs-I-started");
});

test("The manifest serves viewstate.js to github.com and carries AJ's build version", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(manifest.web_accessible_resources[0].resources.includes("src/lib/viewstate.js"));
  assert.equal(manifest.version, "0.8.0.1");
  assert.equal(manifest.version_name, "0.8.0 (AJ build 1)");
  assert.deepEqual(manifest.host_permissions, ["https://api.github.com/*"], "no new hosts");
  assert.deepEqual(manifest.permissions, ["storage", "alarms"], "no new permissions");
});

test("Settings offer the three scopes and the runs-I-started notification", () => {
  const html = read("src/settings.html");
  for (const line of [
    '<label><input type="radio" name="scope" value="scheduled" id="scope-scheduled" checked> Scheduled workflows only (recommended)</label>',
    '<label><input type="radio" name="scope" value="mine" id="scope-mine"> Scheduled workflows and runs I started</label>',
    '<label><input type="radio" name="scope" value="all" id="scope-all"> Every workflow run</label>',
    '<label class="check"><input type="checkbox" id="notify-mine"> Show a desktop notification when a run you started fails</label>',
  ]) assert.ok(html.includes(line), `settings.html lacks: ${line}`);
  const js = read("src/settings.js");
  assert.ok(js.includes('"notify-mine": "notifyMine"'), "settings.js maps notify-mine to notifyMine");
  assert.ok(js.includes("clearSnapshot()"), "settings.js clears the snapshot through storage.js");
  assert.equal(js.includes("chrome.storage.local"), false, "settings.js goes through storage.js only");
});
