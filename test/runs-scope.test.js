// AJ's version (docs/specs/aj-version.md): pure helpers for scopes, trigger labels, the cap note and notifications.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as runs from "../src/lib/runs.js";

const repo = { full_name: "me/blog", name: "blog", html_url: "https://github.com/me/blog", private: false };
const now = new Date("2026-10-18T12:00:00Z");

test("scopeOf: a known scope wins, else scheduledOnly false means all, else scheduled", () => {
  assert.equal(typeof runs.scopeOf, "function");
  assert.equal(runs.scopeOf({ scope: "mine" }), "mine");
  assert.equal(runs.scopeOf({ scope: "all", scheduledOnly: true }), "all");
  assert.equal(runs.scopeOf({ scheduledOnly: false }), "all");
  assert.equal(runs.scopeOf({ scheduledOnly: true }), "scheduled");
  assert.equal(runs.scopeOf({ scope: "bogus", scheduledOnly: true }), "scheduled");
  assert.equal(runs.scopeOf({}), "scheduled");
  assert.equal(runs.scopeOf(null), "scheduled");
  assert.deepEqual(runs.SCOPES, ["scheduled", "mine", "all"]);
});

test("SCOPE_TEXT: page headline and empty-list text per scope", () => {
  assert.deepEqual(runs.SCOPE_TEXT, {
    scheduled: {
      meta: "Scheduled workflows",
      empty: "No scheduled workflow runs in the last 14 days in the repositories this token can see.",
    },
    mine: {
      meta: "Scheduled workflows and runs you started",
      empty: "No scheduled workflow runs or runs you started in the last 14 days in the repositories this token can see.",
    },
    all: {
      meta: "All workflows",
      empty: "No workflow runs in the last 14 days in the repositories this token can see.",
    },
  });
});

test("triggerLabel names the event, and marks re-runs", () => {
  assert.equal(typeof runs.triggerLabel, "function");
  const t = (event, attempt) => runs.triggerLabel({ event, attempt });
  assert.equal(t("schedule"), "Scheduled");
  assert.equal(t("push"), "Push");
  assert.equal(t("pull_request"), "Pull request");
  assert.equal(t("pull_request_target"), "Pull request");
  assert.equal(t("workflow_dispatch"), "Manual run");
  assert.equal(t("repository_dispatch"), "Repository dispatch");
  assert.equal(t("push", 2), "Push (re-run)");
  assert.equal(t("workflow_dispatch", 1), "Manual run");
  assert.equal(t(""), "Unknown trigger");
});

test("leadParts: schedule text first, the trigger when it isn't the schedule, 'Started by you' on my rows", () => {
  assert.equal(typeof runs.leadParts, "function");
  const cron = "0 5 * * *";
  const desc = runs.describeCron(cron, { now });
  const sched = { crons: [cron], latest: { event: "schedule", attempt: 1 } };
  assert.deepEqual(runs.leadParts(sched, now), [desc]);
  assert.deepEqual(runs.leadParts({ crons: [cron], latest: { event: "push", attempt: 1 } }, now), [desc, "Push"]);
  assert.deepEqual(runs.leadParts({ latest: { event: "schedule", attempt: 1 } }, now), ["Scheduled"]);
  assert.deepEqual(runs.leadParts({ latest: { event: "pull_request", attempt: 1 } }, now), ["Pull request"]);
  assert.deepEqual(runs.leadParts({ crons: [cron], latest: null }, now), [desc]);
  assert.deepEqual(
    runs.leadParts({ origin: "mine", latest: { event: "workflow_dispatch", attempt: 3 } }, now),
    ["Started by you", "Manual run (re-run)"],
  );
});

test("capNote: empty when nothing hit the cap, else names the repositories", () => {
  assert.equal(typeof runs.capNote, "function");
  assert.equal(runs.RUN_PAGE_LIMIT, 5);
  assert.equal(runs.capNote([]), "");
  assert.equal(runs.capNote(undefined), "");
  assert.equal(
    runs.capNote(["me/a"]),
    "Stopped at the newest 500 runs in 1 repository (me/a). Older runs from the last 14 days aren't shown.",
  );
  assert.equal(
    runs.capNote(["me/a", "me/b"]),
    "Stopped at the newest 500 runs in 2 repositories (me/a, me/b). Older runs from the last 14 days aren't shown.",
  );
});

test("pickProblems: my rows follow notifyMine, every other row follows notify", () => {
  assert.equal(typeof runs.pickProblems, "function");
  const sched = { key: "a", origin: undefined };
  const mine = { key: "b", origin: "mine" };
  const keys = (list) => list.map((e) => e.key);
  assert.deepEqual(keys(runs.pickProblems([sched, mine], { notify: true, notifyMine: false })), ["a"]);
  assert.deepEqual(keys(runs.pickProblems([sched, mine], { notify: false, notifyMine: true })), ["b"]);
  assert.deepEqual(keys(runs.pickProblems([sched, mine], { notify: true, notifyMine: true })), ["a", "b"]);
  assert.deepEqual(keys(runs.pickProblems([sched, mine], { notify: false, notifyMine: false })), []);
});

test("summarizeRepoRuns: run attempt on latest, and 'mine' rows get their own key", () => {
  const r = (id, attempt) => ({
    id, workflow_id: 7, name: "CI", path: ".github/workflows/ci.yml", html_url: `https://github.com/me/blog/actions/runs/${id}`,
    event: "push", head_branch: "main", status: "completed", conclusion: "success",
    created_at: `2026-10-1${id}T05:00:00Z`, run_started_at: `2026-10-1${id}T05:00:00Z`, updated_at: `2026-10-1${id}T05:00:00Z`,
    ...(attempt ? { run_attempt: attempt } : {}),
  });
  const [plain] = runs.summarizeRepoRuns(repo, [r(1), r(2)]);
  assert.equal(plain.key, "me/blog#7");
  assert.equal(plain.latest.attempt, 1, "a run without run_attempt counts as attempt 1");
  assert.equal("origin" in plain, false);
  const [mine] = runs.summarizeRepoRuns(repo, [r(3, 2)], 10, { origin: "mine" });
  assert.equal(mine.key, "me/blog#7#mine");
  assert.equal(mine.origin, "mine");
  assert.equal(mine.latest.attempt, 2);
});
