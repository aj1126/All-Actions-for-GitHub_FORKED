// Minimal GitHub REST client for the extension. The token is only ever sent to api.github.com.

import { sinceDate, summarizeRepoRuns } from "./runs.js";

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

/**
 * Fetch everything the page needs. Per-repo failures are collected rather than
 * failing the whole refresh; token and rate-limit errors stop it.
 */
export async function loadSnapshot(token, { scheduledOnly = true, days = 14, onProgress } = {}) {
  const now = new Date();
  const repos = await listRepos(token);
  let done = 0;
  const errors = [];
  const results = await pool(repos, 6, async (repo) => {
    try {
      const runs = await listRecentRuns(token, repo, { scheduledOnly, days, now });
      return summarizeRepoRuns(repo, runs);
    } catch (e) {
      if (e instanceof TokenError || e instanceof RateLimitError) throw e;
      // 404 usually means Actions is turned off for that repo; nothing to show.
      if (e.status !== 404) errors.push({ repo: repo.full_name, message: e.message });
      return [];
    } finally {
      done += 1;
      onProgress?.(done, repos.length);
    }
  });
  return {
    fetchedAt: now.toISOString(),
    scheduledOnly,
    repoCount: repos.length,
    entries: results.flat(),
    errors,
  };
}
