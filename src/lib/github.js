// Minimal GitHub REST client for the extension. The token is only ever sent to api.github.com.

import {
  sinceDate, summarizeRepoRuns, applySchedules, expectedRunAt, firstFailedStep, MISSED_GRACE_MS, RUN_PAGE_LIMIT, scopeOf,
} from "./runs.js";
import { extractCrons } from "./cron.js";

const API = "https://api.github.com";

export class TokenError extends Error {}
/** A URL (for example a Link header's next page) that isn't on api.github.com: the token isn't sent. */
export class OriginError extends Error {}
export class RateLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.resetAt = resetAt;
  }
}

/**
 * Remembers ETags from the last refresh so unchanged lists can be asked for with
 * If-None-Match. GitHub answers those with 304 Not Modified, which doesn't count against
 * the hourly request limit. `prev` is what was saved last time; `next` collects what this
 * refresh used, so entries for deleted repos fall away.
 */
export class HttpCache {
  constructor(saved = {}) {
    this.prev = saved;
    this.next = {};
  }
  toJSON() {
    return this.next;
  }
}

async function request(token, path, params = {}, { http = null, keep = (d) => d } = {}) {
  const url = new URL(path.startsWith("http") ? path : API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  if (url.origin !== API) throw new OriginError(`Refused to send the token to ${url.origin}: only ${API} is allowed.`);
  const key = url.toString();
  const hit = http?.prev[key];
  const res = await fetch(url, {
    cache: "no-store", // the HttpCache does the caching, so 304s reach us rather than the browser
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(hit?.etag ? { "If-None-Match": hit.etag } : {}),
    },
  });
  if (res.status === 304 && hit) {
    http.next[key] = hit;
    return { data: hit.data, next: hit.next };
  }
  if (res.status === 401) throw new TokenError("GitHub didn't accept the token. It may have expired or been revoked.");
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    throw new RateLimitError("GitHub's hourly request limit was reached.", reset || undefined);
  }
  if (!res.ok) {
    const err = new Error(`GitHub returned ${res.status} for ${url.pathname}`);
    err.status = res.status;
    throw err;
  }
  const data = keep(await res.json());
  const next = nextLink(res.headers.get("link"));
  const etag = res.headers.get("etag");
  if (http && etag) http.next[key] = { etag, data, next };
  return { data, next };
}

function nextLink(header) {
  if (!header) return null;
  const m = header.split(",").find((p) => p.includes('rel="next"'));
  return m ? m.slice(m.indexOf("<") + 1, m.indexOf(">")) : null;
}

export async function getUser(token) {
  return (await request(token, "/user")).data;
}

/** Repositories the token can see that you own, skipping archived ones (they can't run workflows). */
export async function listRepos(token, http = null) {
  const keep = (list) =>
    list.map((r) => ({ full_name: r.full_name, name: r.name, html_url: r.html_url, private: r.private, archived: r.archived }));
  const repos = [];
  let page = await request(token, "/user/repos", { per_page: 100, affiliation: "owner", sort: "pushed" }, { http, keep });
  repos.push(...page.data);
  while (page.next) {
    page = await request(token, page.next, {}, { http, keep });
    repos.push(...page.data);
  }
  return repos.filter((r) => !r.archived);
}

// Only the run fields the page uses, so the saved ETag cache stays small.
const RUN_FIELDS = ["id", "workflow_id", "name", "path", "event", "head_branch", "status", "conclusion",
  "created_at", "run_started_at", "updated_at", "html_url", "run_attempt"];
const keepRuns = (data) => ({
  workflow_runs: (data.workflow_runs ?? []).map((r) => ({
    ...Object.fromEntries(RUN_FIELDS.map((f) => [f, r[f]])),
    actor_login: r.actor?.login ?? null,
    triggering_login: r.triggering_actor?.login ?? null,
  })),
});

/**
 * One call per repo: recent scheduled runs. `full` means GitHub had more than this page, so a
 * schedule missing from it may still have run.
 */
export async function listScheduledRuns(token, repo, { days, now = new Date(), http = null }) {
  const { data, next } = await request(
    token,
    `/repos/${repo.full_name}/actions/runs`,
    { per_page: 100, created: `>=${sinceDate(now, days)}`, event: "schedule", exclude_pull_requests: true },
    { http, keep: keepRuns },
  );
  return { runs: data.workflow_runs ?? [], full: Boolean(next) };
}

/**
 * Recent runs of any event, optionally only those of `actor`, up to RUN_PAGE_LIMIT pages.
 * `capped` means there were more pages than were read.
 */
export async function listRunPages(token, repo, { days, now = new Date(), http = null, actor }) {
  const runs = [];
  let page = await request(
    token,
    `/repos/${repo.full_name}/actions/runs`,
    { per_page: 100, created: `>=${sinceDate(now, days)}`, actor, exclude_pull_requests: true },
    { http, keep: keepRuns },
  );
  runs.push(...(page.data.workflow_runs ?? []));
  for (let n = 1; page.next && n < RUN_PAGE_LIMIT; n++) {
    page = await request(token, page.next, {}, { http, keep: keepRuns });
    runs.push(...(page.data.workflow_runs ?? []));
  }
  return { runs, capped: Boolean(page.next) };
}

/** Workflows defined in a repo, with their enabled/disabled state. */
export async function listWorkflows(token, repo, http = null) {
  const keep = (data) => ({
    workflows: (data.workflows ?? []).map(({ id, name, path, state, created_at }) => ({ id, name, path, state, created_at })),
  });
  const { data } = await request(token, `/repos/${repo.full_name}/actions/workflows`, { per_page: 100 }, { http, keep });
  return data.workflows ?? [];
}

/** A file's text from the default branch. Needs the token's Contents: Read permission. */
export async function getFileText(token, repo, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const { data } = await request(token, `/repos/${repo.full_name}/contents/${encoded}`);
  const bin = atob((data.content || "").replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** The most recent scheduled run of one workflow, however old. */
export async function lastScheduledRun(token, repo, workflowId, http = null) {
  const { data } = await request(
    token,
    `/repos/${repo.full_name}/actions/workflows/${workflowId}/runs`,
    { event: "schedule", per_page: 1, exclude_pull_requests: true },
    { http, keep: keepRuns },
  );
  return data.workflow_runs?.[0] ?? null;
}

/** Jobs of a run, for finding the step that failed. */
export async function listJobs(token, repo, runId) {
  const { data } = await request(token, `/repos/${repo.full_name}/actions/runs/${runId}/jobs`, {
    filter: "latest",
    per_page: 100,
  });
  return data.jobs ?? [];
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const SCHEDULE_TTL_MS = 12 * 60 * 60 * 1000;
const isFatal = (e) => e instanceof TokenError || e instanceof RateLimitError;

/**
 * Fetch everything the page needs. Per-repo failures are collected rather than
 * failing the whole refresh; token and rate-limit errors stop it.
 *
 * `scheduleCache` holds cron lines read from workflow files (they rarely change), and
 * `previous` is the last snapshot, reused for failing-step names of runs already seen.
 * `scope` is "scheduled", "mine" (needs `login`, the token's user) or "all"; older callers
 * pass `scheduledOnly` instead. Returns the snapshot plus the updated cache.
 */
export async function loadSnapshot(
  token,
  {
    scope, scheduledOnly, login = "", days = 14, grace = MISSED_GRACE_MS, onProgress, previous = null, scheduleCache = {},
    httpCache = {},
  } = {},
) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 86400000);
  const watch = scopeOf({ scope, scheduledOnly });
  const http = new HttpCache(httpCache);
  if (watch === "mine" && !login) login = (await getUser(token)).login;
  const repos = await listRepos(token, http);
  const capped = [];
  const cache = {};
  const knownSteps = new Map(
    (previous?.entries ?? []).filter((e) => e.latest && "failedStep" in e).map((e) => [e.latest.id, e.failedStep]),
  );
  let scheduleAccess = "ok";
  let done = 0;
  const errors = [];

  async function readCrons(repo, workflows) {
    const crons = {};
    for (const wf of workflows) {
      if (!wf.path?.startsWith(".github/workflows/")) continue; // e.g. Dependabot's built-in workflows
      const key = `${repo.full_name}:${wf.path}`;
      const hit = scheduleCache[key];
      if (hit && now.getTime() - hit.at < SCHEDULE_TTL_MS) {
        cache[key] = hit;
        crons[wf.path] = hit.crons;
        continue;
      }
      if (scheduleAccess === "denied") continue;
      try {
        const list = extractCrons(await getFileText(token, repo, wf.path));
        cache[key] = { crons: list, at: now.getTime() };
        crons[wf.path] = list;
      } catch (e) {
        if (isFatal(e)) throw e;
        if (e.status === 403) scheduleAccess = "denied"; // token lacks Contents: Read
        else if (e.status !== 404) throw e;
      }
    }
    return crons;
  }

  const results = await pool(repos, 6, async (repo) => {
    try {
      let workflows;
      try {
        workflows = await listWorkflows(token, repo, http);
      } catch (e) {
        if (e.status === 404) return []; // Actions is turned off for this repo
        throw e;
      }
      if (!workflows.length) return []; // nothing to run, so no need to ask for runs
      const crons = await readCrons(repo, workflows);
      // We could read every workflow file and none has a schedule: no scheduled runs to ask for,
      // and when watching scheduled workflows only, nothing to show for this repo.
      const unscheduled = (wf) => !wf.path?.startsWith(".github/workflows/") || crons[wf.path]?.length === 0;
      const hasSchedules = !workflows.every(unscheduled);
      if (watch === "scheduled" && !hasSchedules) return [];

      // Scheduled runs always come from their own query, so other runs can't push them out.
      const runs = [];
      let full = false;
      if (hasSchedules) {
        const scheduled = await listScheduledRuns(token, repo, { days, now, http });
        runs.push(...scheduled.runs);
        full = scheduled.full;
      }
      let mine = [];
      if (watch !== "scheduled") {
        const other = await listRunPages(token, repo, { days, now, http, actor: watch === "mine" ? login : undefined });
        if (other.capped) capped.push(repo.full_name);
        if (watch === "all") {
          const ids = new Set(runs.map((r) => r.id));
          runs.push(...other.runs.filter((r) => !ids.has(r.id)));
        } else {
          mine = other.runs.filter((r) => r.event !== "schedule" && (r.triggering_login ?? r.actor_login) === login);
        }
      }

      // A schedule missing from the scheduled runs: look further back when it fires less often
      // than the window covers, or when the page was full and its run may be on a later page.
      const seen = new Set(runs.filter((r) => r.event === "schedule").map((r) => r.workflow_id));
      for (const wf of workflows) {
        const expected = crons[wf.path]?.length ? expectedRunAt(crons[wf.path], now, grace) : null;
        if (!expected || seen.has(wf.id) || wf.state !== "active") continue;
        if (expected >= windowStart && !full) continue;
        const older = await lastScheduledRun(token, repo, wf.id, http);
        if (older) runs.push(older);
      }

      const entries = applySchedules(summarizeRepoRuns(repo, runs), repo, workflows, crons, now, grace);
      entries.push(...summarizeRepoRuns(repo, mine, 10, { origin: "mine" }));

      for (const e of entries) {
        if (e.latest?.conclusion !== "failure") continue;
        if (knownSteps.has(e.latest.id)) e.failedStep = knownSteps.get(e.latest.id);
        else e.failedStep = firstFailedStep(await listJobs(token, repo, e.latest.id));
      }
      return entries;
    } catch (e) {
      if (isFatal(e)) throw e;
      errors.push({ repo: repo.full_name, message: e.message });
      return [];
    } finally {
      done += 1;
      onProgress?.(done, repos.length);
    }
  });
  return {
    snapshot: {
      fetchedAt: now.toISOString(),
      scope: watch,
      scheduleAccess,
      repoCount: repos.length,
      entries: results.flat(),
      errors,
      capped: capped.sort(),
    },
    scheduleCache: cache,
    httpCache: http.toJSON(),
  };
}
