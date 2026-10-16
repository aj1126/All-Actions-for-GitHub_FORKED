// Pure helpers for turning raw workflow runs into rows for the All actions page.
// No browser or network APIs here, so everything is unit-testable in Node.

import { previousFire } from "./cron.js";

export { describeCron } from "./cron.js";

export const STATES = ["failed", "missed", "running", "other", "passed"];
export const ATTENTION = new Set(["failed", "missed"]);

// GitHub often starts scheduled runs late, especially at the top of the hour, so a run
// only counts as missed once it's this late. People can pick 1 to 12 hours in Settings.
export const MISSED_AFTER_HOURS = { min: 1, max: 12, default: 12 };
export const MISSED_GRACE_MS = MISSED_AFTER_HOURS.default * 60 * 60 * 1000;

/** The grace period in milliseconds for a saved hours setting, kept within the allowed range. */
export function graceMs(hours) {
  const h = Math.round(Number(hours));
  if (!Number.isFinite(h)) return MISSED_GRACE_MS;
  return Math.min(MISSED_AFTER_HOURS.max, Math.max(MISSED_AFTER_HOURS.min, h)) * 60 * 60 * 1000;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const OTHER = new Set(["cancelled", "skipped", "neutral", "stale"]);

/** Classify one run as failed, running, passed or other. */
export function classify(run) {
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") return "passed";
  if (FAILED.has(run.conclusion)) return "failed";
  if (OTHER.has(run.conclusion)) return "other";
  return "other";
}

/**
 * Group one repo's runs by workflow, newest first.
 * Returns one entry per workflow with the latest run and recent history.
 */
export function summarizeRepoRuns(repo, runs, historySize = 10) {
  const byWorkflow = new Map();
  for (const run of runs) {
    const list = byWorkflow.get(run.workflow_id) ?? [];
    list.push(run);
    byWorkflow.set(run.workflow_id, list);
  }

  const entries = [];
  for (const [workflowId, list] of byWorkflow) {
    list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const latest = list[0];
    const lastScheduled = list.find((r) => r.event === "schedule");
    entries.push({
      key: `${repo.full_name}#${workflowId}`,
      repo: {
        fullName: repo.full_name,
        name: repo.name,
        url: repo.html_url,
        private: Boolean(repo.private),
      },
      workflow: {
        id: workflowId,
        name: latest.name || latest.path || `Workflow ${workflowId}`,
        url: `${repo.html_url}/actions/workflows/${(latest.path || "").split("/").pop()}`,
      },
      state: classify(latest),
      lastScheduledAt: lastScheduled?.created_at ?? null,
      latest: {
        id: latest.id,
        url: latest.html_url,
        event: latest.event,
        branch: latest.head_branch,
        status: latest.status,
        conclusion: latest.conclusion,
        createdAt: latest.created_at,
        startedAt: latest.run_started_at || latest.created_at,
        updatedAt: latest.updated_at,
      },
      // Oldest first so the strip reads left to right like a timeline.
      history: list
        .slice(0, historySize)
        .reverse()
        .map((r) => ({ state: classify(r), url: r.html_url, createdAt: r.created_at })),
    });
  }
  return entries;
}

/** When the schedule last should have fired, allowing for GitHub's delays; null if never. */
export function expectedRunAt(crons, now, grace = MISSED_GRACE_MS) {
  let best = null;
  for (const cron of crons) {
    let t;
    try {
      t = previousFire(cron, new Date(now.getTime() - grace));
    } catch {
      continue; // a cron we can't parse; GitHub would reject it too
    }
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

/**
 * Add schedule information to one repo's entries and flag missed runs.
 *
 * `workflows` comes from the workflows API (id, name, path, state, created_at).
 * `crons` maps a workflow path to its cron strings, or is missing a path when the
 * file couldn't be read. Workflows with a schedule but no recent runs get an entry
 * too, so a job that silently stopped still shows up.
 */
export function applySchedules(entries, repo, workflows, crons, now, grace = MISSED_GRACE_MS) {
  const byId = new Map(entries.map((e) => [e.workflow.id, e]));
  for (const wf of workflows) {
    const list = crons[wf.path];
    if (!list?.length) continue;
    let entry = byId.get(wf.id);
    if (!entry) {
      entry = {
        key: `${repo.full_name}#${wf.id}`,
        repo: { fullName: repo.full_name, name: repo.name, url: repo.html_url, private: Boolean(repo.private) },
        workflow: { id: wf.id, name: wf.name || wf.path, url: `${repo.html_url}/actions/workflows/${wf.path.split("/").pop()}` },
        state: "passed",
        lastScheduledAt: null,
        latest: null,
        history: [],
      };
      byId.set(wf.id, entry);
      entries.push(entry);
    }
    entry.crons = list;
    entry.note = null;
    if (wf.state === "disabled_manually") {
      entry.state = "other";
      entry.note = "disabled";
      continue;
    }
    if (wf.state === "disabled_inactivity") {
      entry.state = "missed";
      entry.note = "inactive";
      continue;
    }
    const expected = expectedRunAt(list, now, grace);
    if (!expected || (wf.created_at && expected < new Date(wf.created_at))) {
      if (!entry.latest) entry.state = "other"; // scheduled, but not due yet
      continue;
    }
    entry.expectedAt = expected.toISOString();
    const last = entry.lastScheduledAt ? new Date(entry.lastScheduledAt) : null;
    // Runs are created at or after their scheduled time, never before.
    if (!last || last < new Date(expected.getTime() - 60 * 1000)) {
      entry.state = "missed";
      entry.note = "missed";
    }
  }
  return entries;
}

function sortTime(e) {
  return Date.parse(e.latest?.createdAt ?? e.expectedAt ?? 0) || 0;
}

/** Sort entries so problems come first, newest first within each state. */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const s = STATES.indexOf(a.state) - STATES.indexOf(b.state);
    if (s !== 0) return s;
    return sortTime(b) - sortTime(a);
  });
}

/** Count entries per state; `attention` is failed plus missed. */
export function tally(entries) {
  const counts = { failed: 0, missed: 0, running: 0, other: 0, passed: 0, attention: 0, total: entries.length };
  for (const e of entries) {
    counts[e.state] += 1;
    if (ATTENTION.has(e.state)) counts.attention += 1;
  }
  return counts;
}

/** The first failed step of a run, from the run's jobs. */
export function firstFailedStep(jobs) {
  for (const job of jobs) {
    if (job.conclusion !== "failure" && job.conclusion !== "timed_out") continue;
    const step = (job.steps || []).find((s) => s.conclusion === "failure" || s.conclusion === "timed_out");
    return { job: job.name, step: step?.name ?? null, url: job.html_url ?? null };
  }
  return null;
}

/**
 * Entries that newly need attention compared with the previous results, for
 * notifications: a new failed run, or a newly missed schedule.
 */
export function newProblems(previous, current) {
  const before = new Map((previous?.entries ?? []).map((e) => [e.key, e]));
  return current.entries.filter((e) => {
    if (!ATTENTION.has(e.state)) return false;
    const old = before.get(e.key);
    if (!old || old.state !== e.state) return true;
    if (e.state === "failed") return old.latest?.id !== e.latest?.id;
    return old.expectedAt !== e.expectedAt;
  });
}

/**
 * Entries whose latest run newly passed since the previous results, for the optional
 * "workflow passed" notification: a new successful run, or one that was still running.
 */
export function newPasses(previous, current) {
  const before = new Map((previous?.entries ?? []).map((e) => [e.key, e]));
  const since = Date.parse(previous?.fetchedAt ?? 0) || 0;
  return current.entries.filter((e) => {
    if (e.state !== "passed" || !e.latest) return false;
    const old = before.get(e.key);
    if (old) return old.state !== "passed" || old.latest?.id !== e.latest.id;
    return Date.parse(e.latest.updatedAt) > since; // a workflow the last check didn't list
  });
}

/** Filter entries by a tab ("attention", "all", or a state) and a free-text query. */
export function filterEntries(entries, tab, query = "") {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (tab === "attention" && !ATTENTION.has(e.state)) return false;
    if (tab !== "attention" && tab !== "all" && e.state !== tab) return false;
    if (!q) return true;
    return (
      e.repo.fullName.toLowerCase().includes(q) || e.workflow.name.toLowerCase().includes(q)
    );
  });
}

/** "2026-10-13" for a date `days` before `now`, for the API's created filter. */
export function sinceDate(now, days) {
  const d = new Date(now.getTime() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Human duration such as "45s", "3m 41s" or "1h 12m". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "05:14 today", "yesterday 13:31", or "Oct 11 07:02", in the viewer's time zone. */
export function formatWhen(iso, now, locale = undefined, timeZone = undefined) {
  const d = new Date(iso);
  const opts = { timeZone };
  const time = d.toLocaleTimeString(locale, { ...opts, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const dayKey = (x) => x.toLocaleDateString("en-CA", opts);
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86400000));
  if (dayKey(d) === today) return `${time} today`;
  if (dayKey(d) === yesterday) return `yesterday ${time}`;
  const date = d.toLocaleDateString(locale, { ...opts, month: "short", day: "numeric" });
  return `${date} ${time}`;
}

/** "just now", "4 min ago", "2 h ago". */
export function formatAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
