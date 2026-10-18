// AJ's version (docs/specs/aj-version.md): scopes, the R10 "missed" fix, the run-page cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as gh from "../src/lib/github.js";
import { expectedRunAt, MISSED_GRACE_MS } from "../src/lib/runs.js";
import { fakeGitHub, withFetch, repo, workflow, mkRun, cronYaml } from "../test-support/fake-github.js";

const minAgo = (now, m) => new Date(now.getTime() - m * 60 * 1000);
const runsCalls = (calls, name) => calls.filter((c) => c.path === `/repos/me/${name}/actions/runs`);

test("All workflows: 100 newer push runs don't hide a scheduled run that ran (R10)", async () => {
  const now = new Date();
  const runs = [mkRun({ id: 1000, wf: 1, event: "schedule", at: minAgo(now, 200) })];
  for (let i = 1; i <= 100; i++) runs.push(mkRun({ id: i, wf: 2, event: "push", at: minAgo(now, i) }));
  const fake = fakeGitHub({
    repos: [repo("busy")],
    workflows: { "me/busy": [workflow(1, "nightly.yml", "Nightly"), workflow(2, "ci.yml", "CI")] },
    files: { "me/busy:.github/workflows/nightly.yml": cronYaml("0 5 * * *"), "me/busy:.github/workflows/ci.yml": "on: push\n" },
    runs: { "me/busy": runs },
  });
  const { snapshot } = await withFetch(fake.fetch, () =>
    gh.loadSnapshot("t", { scope: "all", scheduledOnly: false, login: "me" }));
  const nightly = snapshot.entries.find((e) => e.workflow.id === 1);
  assert.equal(nightly.state, "passed");
  assert.notEqual(nightly.note, "missed");
  assert.equal(nightly.history.length, 1, "the scheduled run is counted once, though both queries return it");
  assert.equal(snapshot.entries.find((e) => e.workflow.id === 2).state, "passed");
  assert.ok(runsCalls(fake.calls, "busy").some((c) => c.params.event === "schedule"), "scheduled runs have their own query");
  assert.equal(snapshot.scope, "all");
});

test("Scheduled only: a full page of frequent runs triggers a look-back for the other schedules (R10)", async () => {
  const now = new Date();
  const weeklyDue = expectedRunAt(["0 6 * * 1"], now, MISSED_GRACE_MS);
  const weeklyRun = mkRun({ id: 5000, wf: 3, event: "schedule", at: new Date(weeklyDue.getTime() + 30 * 60 * 1000) });
  const runs = [weeklyRun];
  for (let i = 1; i <= 110; i++) runs.push(mkRun({ id: i, wf: 1, event: "schedule", at: minAgo(now, 5 * i) }));
  const fake = fakeGitHub({
    repos: [repo("cron")],
    workflows: { "me/cron": [workflow(1, "often.yml", "Often"), workflow(3, "weekly.yml", "Weekly")] },
    files: { "me/cron:.github/workflows/often.yml": cronYaml("*/5 * * * *"), "me/cron:.github/workflows/weekly.yml": cronYaml("0 6 * * 1") },
    runs: { "me/cron": runs },
  });
  const { snapshot } = await withFetch(fake.fetch, () => gh.loadSnapshot("t", { scope: "scheduled" }));
  const weekly = snapshot.entries.find((e) => e.workflow.id === 3);
  assert.equal(weekly.state, "passed");
  assert.equal(weekly.lastScheduledAt, weeklyRun.created_at);
  assert.equal(snapshot.entries.find((e) => e.workflow.id === 1).state, "passed");
  assert.ok(fake.calls.some((c) => c.path === "/repos/me/cron/actions/workflows/3/runs"), "looked back for the weekly run");
  assert.ok(!fake.calls.some((c) => c.path === "/repos/me/cron/actions/workflows/1/runs"), "no look-back for a schedule already seen");
});

test("Runs I started: own rows, by triggering actor, never a bot's (issue #1)", async () => {
  const now = new Date();
  const fake = fakeGitHub({
    repos: [repo("app")],
    workflows: { "me/app": [workflow(1, "nightly.yml", "Nightly"), workflow(2, "ci.yml", "CI")] },
    files: { "me/app:.github/workflows/nightly.yml": cronYaml("0 5 * * *"), "me/app:.github/workflows/ci.yml": "on: push\n" },
    runs: {
      "me/app": [
        mkRun({ id: 50, wf: 1, event: "schedule", at: minAgo(now, 1) }),
        mkRun({ id: 51, wf: 2, event: "push", at: minAgo(now, 10) }),
        mkRun({ id: 52, wf: 2, event: "push", at: minAgo(now, 5), conclusion: "failure", trig: "dependabot[bot]", attempt: 2 }),
        mkRun({ id: 53, wf: 2, event: "push", at: minAgo(now, 3), conclusion: "failure", actor: "dependabot[bot]" }),
      ],
    },
  });
  const { snapshot } = await withFetch(fake.fetch, () => gh.loadSnapshot("t", { scope: "mine", login: "me" }));
  assert.deepEqual(snapshot.entries.map((e) => e.key).sort(), ["me/app#1", "me/app#2#mine"]);
  const mine = snapshot.entries.find((e) => e.key === "me/app#2#mine");
  assert.equal(mine.origin, "mine");
  assert.equal(mine.latest.id, 51);
  assert.equal(mine.latest.attempt, 1);
  assert.equal(mine.state, "passed");
  assert.equal(mine.history.length, 1);
  assert.equal(snapshot.entries.find((e) => e.key === "me/app#1").state, "passed");
  const calls = runsCalls(fake.calls, "app");
  assert.ok(calls.some((c) => c.params.event === "schedule" && !c.params.actor), "scheduled query");
  assert.ok(calls.some((c) => c.params.actor === "me" && !c.params.event), "runs-I-started query filters by actor on the server");
  assert.equal(snapshot.scope, "mine");
});

test("A run list that hits the 5-page cap is reported, not read as missed", async () => {
  const now = new Date();
  const runs = Array.from({ length: 600 }, (_, i) => mkRun({ id: i + 1, wf: 2, event: "push", at: minAgo(now, i + 1) }));
  const fake = fakeGitHub({
    repos: [repo("flood")],
    workflows: { "me/flood": [workflow(2, "ci.yml", "CI")] },
    files: { "me/flood:.github/workflows/ci.yml": "on: push\n" },
    runs: { "me/flood": runs },
  });
  const { snapshot } = await withFetch(fake.fetch, () =>
    gh.loadSnapshot("t", { scope: "all", scheduledOnly: false, login: "me" }));
  assert.deepEqual(snapshot.capped, ["me/flood"]);
  assert.equal(runsCalls(fake.calls, "flood").filter((c) => !c.params.event).length, 5);
  assert.equal(snapshot.entries.length, 1);
  assert.notEqual(snapshot.entries[0].state, "missed");
});

test("Scope comes from scheduledOnly when no scope is given", async () => {
  const fake = fakeGitHub({ repos: [] });
  const all = await withFetch(fake.fetch, () => gh.loadSnapshot("t", { scheduledOnly: false, login: "me" }));
  const dflt = await withFetch(fake.fetch, () => gh.loadSnapshot("t", {}));
  assert.equal(all.snapshot.scope, "all");
  assert.equal(dflt.snapshot.scope, "scheduled");
  assert.deepEqual(dflt.snapshot.capped, []);
});
