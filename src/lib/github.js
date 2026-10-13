// Minimal GitHub REST client for the extension. The token is only ever sent to api.github.com.

import { sinceDate, summarizeRepoRuns, applySchedules, expectedRunAt, firstFailedStep } from "./runs.js";
import { extractCrons } from "./cron.js";

const API = "https://api.github.com";

export class TokenError extends Error {}
export class RateLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.resetAt = resetAt;
  }
}

async function request(token, path, params = {}) {
  const url = new URL(path.startsWith("http") ? path : API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
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
  return { data: await res.json(), next: nextLink(res.headers.get("link")) };
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
export async function listRepos(token) {
  const repos = [];
  let page = await request(token, "/user/repos", { per_page: 100, affiliation: "owner", sort: "pushed" });
  repos.push(...page.data);
  while (page.next) {
    page = await request(token, page.next);
    repos.push(...page.data);
  }
  return repos.filter((r) => !r.archived);
}

/** One call per repo: recent runs, optionally scheduled ones only. */
export async function listRecentRuns(token, repo, { scheduledOnly, days, now = new Date() }) {
  const { data } = await request(token, `/repos/${repo.full_name}/actions/runs`, {
    per_page: 100,
    created: `>=${sinceDate(now, days)}`,
    event: scheduledOnly ? "schedule" : undefined,
    exclude_pull_requests: true,
  });
  return data.workflow_runs ?? [];
}

/** Workflows defined in a repo, with their enabled/disabled state. */
export async function listWorkflows(token, repo) {
  const { data } = await request(token, `/repos/${repo.full_name}/actions/workflows`, { per_page: 100 });
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
export async function lastScheduledRun(token, repo, workflowId) {
  const { data } = await request(token, `/repos/${repo.full_name}/actions/workflows/${workflowId}/runs`, {
    event: "schedule",
    per_page: 1,
    exclude_pull_requests: true,
  });
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
 * Returns the snapshot plus the updated cache.
 */
export async function loadSnapshot(
  token,
  { scheduledOnly = true, days = 14, onProgress, previous = null, scheduleCache = {} } = {},
) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 86400000);
  const repos = await listRepos(token);
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
      let runs;
      let workflows;
      try {
        [runs, workflows] = await Promise.all([
          listRecentRuns(token, repo, { scheduledOnly, days, now }),
          listWorkflows(token, repo),
        ]);
      } catch (e) {
        if (e.status === 404) return []; // Actions is turned off for this repo
        throw e;
      }
      const crons = await readCrons(repo, workflows);

      // A schedule that fires less often than the window covers: look further back.
      const seen = new Set(runs.filter((r) => r.event === "schedule").map((r) => r.workflow_id));
      for (const wf of workflows) {
        const expected = crons[wf.path]?.length ? expectedRunAt(crons[wf.path], now) : null;
        if (!expected || expected >= windowStart || seen.has(wf.id) || wf.state !== "active") continue;
        const older = await lastScheduledRun(token, repo, wf.id);
        if (older) runs.push(older);
      }

      const entries = applySchedules(summarizeRepoRuns(repo, runs), repo, workflows, crons, now);

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
      scheduledOnly,
      scheduleAccess,
      repoCount: repos.length,
      entries: results.flat(),
      errors,
    },
    scheduleCache: cache,
  };
}
