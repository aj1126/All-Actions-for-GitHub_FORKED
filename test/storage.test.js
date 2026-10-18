// AJ's version (docs/specs/aj-version.md), R2: the token stays in storage.local, closed to content scripts;
// what the github.com view needs lives in storage.session, opened to them. Plus the settings migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as storage from "../src/lib/storage.js";
import { fakeChrome, withChrome } from "../test-support/fake-chrome.js";

const snap = { fetchedAt: "2026-10-18T12:00:00.000Z", scope: "scheduled", repoCount: 1, entries: [], errors: [], capped: [] };

test("lockDownStorage closes storage.local to content scripts and opens storage.session (R2)", async () => {
  assert.equal(typeof storage.lockDownStorage, "function");
  const { chrome } = fakeChrome();
  await withChrome(chrome, () => storage.lockDownStorage());
  assert.equal(chrome.storage.local.accessLevel, "TRUSTED_CONTEXTS");
  assert.equal(chrome.storage.session.accessLevel, "TRUSTED_AND_UNTRUSTED_CONTEXTS");
});

test("setToken and clearToken keep the token in local and only a hasToken flag in session (R2)", async () => {
  const { chrome } = fakeChrome();
  await withChrome(chrome, async () => {
    await storage.setToken("github_pat_SECRET");
    assert.equal(chrome.storage.local.data.token, "github_pat_SECRET");
    assert.equal(chrome.storage.session.data.hasToken, true);
    assert.equal("token" in chrome.storage.session.data, false);
    chrome.storage.session.data.snapshot = snap;
    chrome.storage.session.data.refreshState = { running: false };
    await storage.clearToken();
    assert.equal("token" in chrome.storage.local.data, false);
    assert.equal(chrome.storage.session.data.hasToken, false);
    assert.equal("snapshot" in chrome.storage.session.data, false);
    assert.equal("refreshState" in chrome.storage.session.data, false);
  });
});

test("setSnapshot writes both areas; clearSnapshot removes both; setRefreshState writes session only (R2)", async () => {
  assert.equal(typeof storage.clearSnapshot, "function");
  assert.equal(typeof storage.setRefreshState, "function");
  const { chrome } = fakeChrome();
  await withChrome(chrome, async () => {
    await storage.setSnapshot(snap);
    assert.deepEqual(chrome.storage.local.data.snapshot, snap);
    assert.deepEqual(chrome.storage.session.data.snapshot, snap);
    await storage.clearSnapshot();
    assert.equal("snapshot" in chrome.storage.local.data, false);
    assert.equal("snapshot" in chrome.storage.session.data, false);
    await storage.setRefreshState({ running: true, done: 1, total: 4, at: 5 });
    assert.deepEqual(chrome.storage.session.data.refreshState, { running: true, done: 1, total: 4, at: 5 });
    assert.equal("refreshState" in chrome.storage.local.data, false);
  });
});

test("syncViewState copies the snapshot and a hasToken flag to session, never the token (R2)", async () => {
  assert.equal(typeof storage.syncViewState, "function");
  const { chrome } = fakeChrome();
  chrome.storage.local.data = { token: "github_pat_SECRET", snapshot: snap };
  await withChrome(chrome, () => storage.syncViewState());
  assert.deepEqual(chrome.storage.session.data, { hasToken: true, snapshot: snap });

  const empty = fakeChrome().chrome;
  await withChrome(empty, () => storage.syncViewState());
  assert.deepEqual(empty.storage.session.data, { hasToken: false, snapshot: null });
});

test("getSettings migrates scheduledOnly to scope and adds notifyMine (off)", async () => {
  const cases = [
    [undefined, "scheduled"],
    [{}, "scheduled"],
    [{ scheduledOnly: true }, "scheduled"],
    [{ scheduledOnly: false, notify: true }, "all"],
    [{ scope: "mine" }, "mine"],
    [{ scope: "bogus", scheduledOnly: false }, "all"],
  ];
  for (const [saved, scope] of cases) {
    const { chrome } = fakeChrome();
    if (saved) chrome.storage.local.data.settings = saved;
    const s = await withChrome(chrome, () => storage.getSettings());
    assert.equal(s.scope, scope, JSON.stringify(saved));
    assert.equal("scheduledOnly" in s, false, JSON.stringify(saved));
    assert.equal(s.notifyMine, false);
    assert.equal(s.notify, Boolean(saved?.notify));
    assert.equal(s.notifyPass, false);
    assert.equal(s.missedAfterHours, 12);
  }
});
