// AJ's version (docs/specs/aj-version.md), R2: what the github.com view reads, and when it asks for a refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome, withChrome } from "../test-support/fake-chrome.js";

const load = () => import("../src/lib/viewstate.js").catch(() => ({}));
const snap = (ageMs, now) => ({ fetchedAt: new Date(now - ageMs).toISOString(), entries: [] });

test("readViewState reads storage.session only, never storage.local (R2)", async () => {
  const vs = await load();
  assert.deepEqual(vs.VIEW_KEYS, ["snapshot", "refreshState", "hasToken"]);
  const { chrome, calls } = fakeChrome();
  chrome.storage.local.data = { token: "github_pat_SECRET" };
  const s = { fetchedAt: "2026-10-18T12:00:00.000Z", entries: [] };
  chrome.storage.session.data = { snapshot: s, refreshState: { running: false }, hasToken: true };
  const state = await withChrome(chrome, () => vs.readViewState());
  assert.deepEqual(state, { snapshot: s, refreshState: { running: false }, hasToken: true });
  assert.deepEqual(calls.filter((c) => c.area === "local"), []);
});

test("readViewState before the worker filled session: nothing known yet, no error (R2)", async () => {
  const vs = await load();
  assert.equal(typeof vs.readViewState, "function");
  const empty = fakeChrome().chrome;
  assert.deepEqual(await withChrome(empty, () => vs.readViewState()), { snapshot: null, refreshState: null, hasToken: null });
  const closed = fakeChrome().chrome;
  closed.storage.session.failGets = true; // session still closed to content scripts after a browser restart
  assert.deepEqual(await withChrome(closed, () => vs.readViewState()), { snapshot: null, refreshState: null, hasToken: null });
  const noFetch = fakeChrome().chrome;
  noFetch.storage.session.data = { snapshot: { entries: [] } }; // a snapshot without fetchedAt isn't a result
  assert.equal((await withChrome(noFetch, () => vs.readViewState())).snapshot, null);
});

test("isViewChange: only session changes to the view's keys", async () => {
  const vs = await load();
  assert.equal(typeof vs.isViewChange, "function");
  assert.equal(vs.isViewChange("local", { snapshot: {} }), false);
  assert.equal(vs.isViewChange("local", { token: {} }), false);
  assert.equal(vs.isViewChange("session", { hasToken: {} }), true);
  assert.equal(vs.isViewChange("session", { snapshot: {} }), true);
  assert.equal(vs.isViewChange("session", { refreshState: {} }), true);
  assert.equal(vs.isViewChange("session", { other: {} }), false);
});

test("shouldRefresh: connected, not already running, and no result or one older than 5 minutes", async () => {
  const vs = await load();
  assert.equal(typeof vs.shouldRefresh, "function");
  const now = Date.parse("2026-10-18T12:00:00Z");
  const min = 60 * 1000;
  assert.equal(vs.shouldRefresh({ hasToken: true, snapshot: null, refreshState: null }, now), true);
  assert.equal(vs.shouldRefresh({ hasToken: true, snapshot: snap(10 * min, now), refreshState: null }, now), true);
  assert.equal(vs.shouldRefresh({ hasToken: true, snapshot: snap(1 * min, now), refreshState: null }, now), false);
  assert.equal(vs.shouldRefresh({ hasToken: false, snapshot: null, refreshState: null }, now), false);
  assert.equal(vs.shouldRefresh({ hasToken: null, snapshot: null, refreshState: null }, now), false);
  const running = { running: true, at: now - 30 * 1000 };
  assert.equal(vs.shouldRefresh({ hasToken: true, snapshot: null, refreshState: running }, now), false);
  const stuck = { running: true, at: now - 3 * min }; // no progress for over 2 minutes: interrupted
  assert.equal(vs.shouldRefresh({ hasToken: true, snapshot: null, refreshState: stuck }, now), true);
  assert.equal(vs.isRunning(running, now), true);
  assert.equal(vs.isRunning(stuck, now), false);
});
