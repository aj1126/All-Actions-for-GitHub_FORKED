import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, summarizeRepoRuns, sortEntries, tally, filterEntries, sinceDate, formatDuration, formatWhen, formatAgo,
} from "../src/lib/runs.js";

const repo = { full_name: "me/blog", name: "blog", html_url: "https://github.com/me/blog", private: false };

function run(id, workflowId, createdAt, status, conclusion, extra = {}) {
  return {
    id, workflow_id: workflowId, name: `WF ${workflowId}`, path: `.github/workflows/wf${workflowId}.yml`,
    html_url: `https://github.com/me/blog/actions/runs/${id}`, event: "schedule", head_branch: "main",
    status, conclusion, created_at: createdAt, run_started_at: createdAt, updated_at: createdAt, ...extra,
  };
}

test("classify maps GitHub statuses to page states", () => {
  assert.equal(classify({ status: "completed", conclusion: "success" }), "passed");
  assert.equal(classify({ status: "completed", conclusion: "failure" }), "failed");
  assert.equal(classify({ status: "completed", conclusion: "timed_out" }), "failed");
  assert.equal(classify({ status: "completed", conclusion: "startup_failure" }), "failed");
  assert.equal(classify({ status: "completed", conclusion: "cancelled" }), "other");
  assert.equal(classify({ status: "completed", conclusion: "skipped" }), "other");
  assert.equal(classify({ status: "in_progress", conclusion: null }), "running");
  assert.equal(classify({ status: "queued", conclusion: null }), "running");
});

test("summarizeRepoRuns keeps the latest run per workflow and history oldest first", () => {
  const runs = [
    run(1, 10, "2026-10-11T05:00:00Z", "completed", "success"),
    run(3, 10, "2026-10-13T05:00:00Z", "completed", "failure"),
    run(2, 10, "2026-10-12T05:00:00Z", "completed", "success"),
    run(4, 20, "2026-10-13T06:00:00Z", "in_progress", null),
  ];
  const entries = summarizeRepoRuns(repo, runs);
  assert.equal(entries.length, 2);
  const wf10 = entries.find((e) => e.workflow.id === 10);
  assert.equal(wf10.state, "failed");
  assert.equal(wf10.latest.id, 3);
  assert.deepEqual(wf10.history.map((h) => h.state), ["passed", "passed", "failed"]);
  assert.equal(wf10.workflow.url, "https://github.com/me/blog/actions/workflows/wf10.yml");
  assert.equal(entries.find((e) => e.workflow.id === 20).state, "running");
});

test("summarizeRepoRuns caps history", () => {
  const runs = Array.from({ length: 15 }, (_, i) =>
    run(i, 1, new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), "completed", "success"));
  const [entry] = summarizeRepoRuns(repo, runs, 10);
  assert.equal(entry.history.length, 10);
  assert.equal(entry.latest.id, 14);
});

test("sortEntries puts failures first, then running, other, passed", () => {
  const mk = (state, t) => ({ state, latest: { createdAt: t } });
  const sorted = sortEntries([
    mk("passed", "2026-10-13T09:00:00Z"),
    mk("failed", "2026-10-12T09:00:00Z"),
    mk("other", "2026-10-13T09:00:00Z"),
    mk("running", "2026-10-13T09:00:00Z"),
    mk("failed", "2026-10-13T09:00:00Z"),
  ]);
  assert.deepEqual(sorted.map((e) => e.state), ["failed", "failed", "running", "other", "passed"]);
  assert.equal(sorted[0].latest.createdAt, "2026-10-13T09:00:00Z");
});

test("tally and filterEntries", () => {
  const entries = [
    { state: "failed", repo: { fullName: "me/a" }, workflow: { name: "Nightly" } },
    { state: "passed", repo: { fullName: "me/b" }, workflow: { name: "Backup" } },
    { state: "running", repo: { fullName: "me/c" }, workflow: { name: "Sync" } },
  ];
  assert.deepEqual(tally(entries), { failed: 1, running: 1, other: 0, passed: 1, total: 3 });
  assert.equal(filterEntries(entries, "attention").length, 1);
  assert.equal(filterEntries(entries, "all").length, 3);
  assert.equal(filterEntries(entries, "passed").length, 1);
  assert.equal(filterEntries(entries, "all", "BACK").length, 1);
  assert.equal(filterEntries(entries, "all", "me/c").length, 1);
});

test("date and duration formatting", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  assert.equal(sinceDate(now, 14), "2026-09-29");
  assert.equal(formatDuration(41000), "41s");
  assert.equal(formatDuration(221000), "3m 41s");
  assert.equal(formatDuration(4320000), "1h 12m");
  assert.equal(formatDuration(-1), "");
  assert.equal(formatWhen("2026-10-13T05:14:00Z", now, "en-US", "UTC"), "05:14 today");
  assert.equal(formatWhen("2026-10-12T13:31:00Z", now, "en-US", "UTC"), "yesterday 13:31");
  assert.equal(formatWhen("2026-10-11T07:02:00Z", now, "en-US", "UTC"), "Oct 11 07:02");
  assert.equal(formatAgo(20000), "just now");
  assert.equal(formatAgo(4 * 60000), "4 min ago");
  assert.equal(formatAgo(3 * 3600000), "3 h ago");
});
