import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, summarizeRepoRuns, sortEntries, tally, filterEntries, sinceDate, formatDuration, formatWhen, formatAgo,
  applySchedules, expectedRunAt, firstFailedStep, newProblems, newPasses, graceMs,
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
  assert.deepEqual(tally(entries), { failed: 1, missed: 0, running: 1, other: 0, passed: 1, attention: 1, total: 3 });
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

const wf = (id, extra = {}) => ({ id, name: `WF ${id}`, path: `.github/workflows/wf${id}.yml`, state: "active", created_at: "2026-01-01T00:00:00Z", ...extra });

test("expectedRunAt allows a 12-hour grace period", () => {
  const crons = ["0 5 * * *"];
  assert.equal(expectedRunAt(crons, new Date("2026-10-13T16:59:00Z")).toISOString(), "2026-10-12T05:00:00.000Z");
  assert.equal(expectedRunAt(crons, new Date("2026-10-13T17:01:00Z")).toISOString(), "2026-10-13T05:00:00.000Z");
  assert.equal(expectedRunAt(["not a cron"], new Date()), null);
});

test("expectedRunAt uses a shorter grace period when one is set", () => {
  const crons = ["0 5 * * *"];
  const oneHour = graceMs(1);
  assert.equal(expectedRunAt(crons, new Date("2026-10-13T05:59:00Z"), oneHour).toISOString(), "2026-10-12T05:00:00.000Z");
  assert.equal(expectedRunAt(crons, new Date("2026-10-13T06:01:00Z"), oneHour).toISOString(), "2026-10-13T05:00:00.000Z");
});

test("graceMs keeps the setting between 1 and 12 hours", () => {
  const h = 3600000;
  assert.equal(graceMs(3), 3 * h);
  assert.equal(graceMs("6"), 6 * h);
  assert.equal(graceMs(0), 1 * h);
  assert.equal(graceMs(48), 12 * h);
  assert.equal(graceMs(undefined), 12 * h);
});

test("applySchedules flags a late run as missed only after the chosen delay", () => {
  const now = new Date("2026-10-13T08:00:00Z");
  const runs = [run(1, 10, "2026-10-12T05:20:00Z", "completed", "success")];
  const crons = { ".github/workflows/wf10.yml": ["0 5 * * *"] };
  const [twelve] = applySchedules(summarizeRepoRuns(repo, runs), repo, [wf(10)], crons, now);
  assert.equal(twelve.state, "passed");
  const [two] = applySchedules(summarizeRepoRuns(repo, runs), repo, [wf(10)], crons, now, graceMs(2));
  assert.equal(two.state, "missed");
  assert.equal(two.expectedAt, "2026-10-13T05:00:00.000Z");
});

test("applySchedules flags a daily job with no run today as missed", () => {
  const now = new Date("2026-10-13T18:00:00Z");
  const runs = [run(1, 10, "2026-10-12T05:20:00Z", "completed", "success")];
  const entries = applySchedules(summarizeRepoRuns(repo, runs), repo, [wf(10)], { ".github/workflows/wf10.yml": ["0 5 * * *"] }, now);
  assert.equal(entries[0].state, "missed");
  assert.equal(entries[0].note, "missed");
  assert.equal(entries[0].expectedAt, "2026-10-13T05:00:00.000Z");
});

test("applySchedules leaves an on-time (even late-starting) run alone", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const runs = [run(1, 10, "2026-10-13T06:12:00Z", "completed", "failure")];
  const [e] = applySchedules(summarizeRepoRuns(repo, runs), repo, [wf(10)], { ".github/workflows/wf10.yml": ["0 5 * * *"] }, now);
  assert.equal(e.state, "failed");
});

test("applySchedules adds scheduled workflows with no recent runs", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const crons = { ".github/workflows/wf10.yml": ["0 5 * * *"], ".github/workflows/wf11.yml": ["0 5 * * *"], ".github/workflows/wf12.yml": ["0 5 * * *"] };
  const workflows = [wf(10, { state: "disabled_inactivity" }), wf(11, { state: "disabled_manually" }), wf(12)];
  const entries = applySchedules([], repo, workflows, crons, now);
  assert.deepEqual(entries.map((e) => [e.workflow.id, e.state, e.note]), [[10, "missed", "inactive"], [11, "other", "disabled"], [12, "missed", "missed"]]);
});

test("applySchedules ignores workflows without a schedule and ones created after the due time", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const entries = applySchedules([], repo, [wf(10), wf(11, { created_at: "2026-10-13T09:00:00Z" })], { ".github/workflows/wf11.yml": ["0 5 * * *"] }, now);
  assert.deepEqual(entries.map((e) => [e.workflow.id, e.state]), [[11, "other"]]);
});

test("attention filter includes missed", () => {
  const entries = [
    { state: "missed", repo: { fullName: "me/a" }, workflow: { name: "x" } },
    { state: "failed", repo: { fullName: "me/b" }, workflow: { name: "y" } },
    { state: "passed", repo: { fullName: "me/c" }, workflow: { name: "z" } },
  ];
  assert.equal(filterEntries(entries, "attention").length, 2);
  assert.equal(sortEntries(entries.map((e) => ({ ...e, latest: null })))[1].state, "missed");
});

test("firstFailedStep finds the failing job and step", () => {
  const jobs = [
    { name: "lint", conclusion: "success", steps: [] },
    { name: "build", conclusion: "failure", html_url: "u", steps: [{ name: "Checkout", conclusion: "success" }, { name: "Upload", conclusion: "failure" }] },
  ];
  assert.deepEqual(firstFailedStep(jobs), { job: "build", step: "Upload", url: "u" });
  assert.equal(firstFailedStep([{ name: "a", conclusion: "success" }]), null);
});

test("newProblems only reports new failures and new misses", () => {
  const mk = (key, state, id, expectedAt) => ({ key, state, latest: { id }, expectedAt });
  const prev = { entries: [mk("a", "failed", 1), mk("b", "missed", 2, "t1"), mk("c", "passed", 3)] };
  const cur = { entries: [mk("a", "failed", 1), mk("b", "missed", 2, "t2"), mk("c", "failed", 4), mk("d", "passed", 5)] };
  assert.deepEqual(newProblems(prev, cur).map((e) => e.key), ["b", "c"]);
});

test("newPasses reports new successful runs and runs that finished passing", () => {
  const mk = (key, state, id, updatedAt = "2026-10-16T10:00:00Z") => ({ key, state, latest: { id, updatedAt } });
  const prev = {
    fetchedAt: "2026-10-16T09:00:00Z",
    entries: [
      mk("a", "passed", 1), mk("b", "passed", 2), mk("c", "running", 3), mk("d", "missed", 4), mk("e", "passed", 5),
      mk("i", "missed", 11),
    ],
  };
  const cur = {
    entries: [
      mk("a", "passed", 1), // same run as before
      mk("b", "passed", 6), // a new successful run
      mk("c", "passed", 3), // was running, now passed
      mk("d", "passed", 7), // the late run finally came and passed
      mk("e", "failed", 8),
      mk("f", "passed", 9), // new to the list, finished after the last check
      mk("g", "passed", 10, "2026-10-16T08:00:00Z"), // new to the list, but old news
      { key: "h", state: "passed", latest: null },
      mk("i", "passed", 11), // no longer flagged as missed after the delay changed, but no new run
    ],
  };
  assert.deepEqual(newPasses(prev, cur).map((e) => e.key), ["b", "c", "d", "f"]);
});
