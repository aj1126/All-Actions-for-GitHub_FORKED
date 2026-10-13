// Pure helpers for turning raw workflow runs into rows for the All actions page.
// No browser or network APIs here, so everything is unit-testable in Node.

export const STATES = ["failed", "running", "other", "passed"];

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

/** Sort entries so problems come first, newest first within each state. */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const s = STATES.indexOf(a.state) - STATES.indexOf(b.state);
    if (s !== 0) return s;
    return Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt);
  });
}

/** Count entries per state. */
export function tally(entries) {
  const counts = { failed: 0, running: 0, other: 0, passed: 0, total: entries.length };
  for (const e of entries) counts[e.state] += 1;
  return counts;
}

/** Filter entries by a tab ("attention", "all", or a state) and a free-text query. */
export function filterEntries(entries, tab, query = "") {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (tab === "attention" && e.state !== "failed") return false;
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
