import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSnapshot } from "../src/lib/github.js";

// A fake api.github.com: four repos, ETags on every list, 304 when the ETag matches.
const repo = (name) => ({ full_name: `me/${name}`, name, html_url: `https://github.com/me/${name}`, private: false, archived: false });
const yaml = (cron) => Buffer.from(`on:\n  schedule:\n    - cron: "${cron}"\n`).toString("base64");

function fakeGitHub(now) {
  const today = new Date(now.getTime() - 60 * 1000); // ran a minute ago
  const routes = {
    "/user/repos": [repo("scheduled"), repo("empty"), repo("push-only"), repo("no-actions")],
    "/repos/me/scheduled/actions/workflows": {
      workflows: [{ id: 1, name: "Nightly", path: ".github/workflows/nightly.yml", state: "active", created_at: "2026-01-01T00:00:00Z" }],
    },
    "/repos/me/scheduled/contents/.github/workflows/nightly.yml": { content: yaml("0 5 * * *") },
    "/repos/me/scheduled/actions/runs": {
      workflow_runs: [{
        id: 10, workflow_id: 1, name: "Nightly", path: ".github/workflows/nightly.yml", event: "schedule",
        head_branch: "main", status: "completed", conclusion: "success", created_at: today.toISOString(),
        run_started_at: today.toISOString(), updated_at: today.toISOString(), html_url: "https://github.com/me/scheduled/actions/runs/10",
        extra_field_we_drop: "x".repeat(500),
      }],
    },
    "/repos/me/empty/actions/workflows": { workflows: [] },
    "/repos/me/push-only/actions/workflows": {
      workflows: [{ id: 2, name: "CI", path: ".github/workflows/ci.yml", state: "active", created_at: "2026-01-01T00:00:00Z" }],
    },
    "/repos/me/push-only/contents/.github/workflows/ci.yml": { content: Buffer.from("on: push\n").toString("base64") },
  };
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = routes[u.pathname];
    const etag = `"${u.pathname}"`;
    const sentEtag = init.headers["If-None-Match"];
    calls.push({ path: u.pathname, conditional: Boolean(sentEtag) });
    if (!body) return new Response("{}", { status: 404, headers: { "x-ratelimit-remaining": "4000" } });
    if (sentEtag === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag, "content-type": "application/json" } });
  };
  return { fetch, calls };
}

test("loadSnapshot skips repos with nothing scheduled and reuses unchanged lists", async () => {
  const now = new Date();
  const gh = fakeGitHub(now);
  const realFetch = globalThis.fetch;
  globalThis.fetch = gh.fetch;
  try {
    const first = await loadSnapshot("t", { scheduledOnly: true });
    assert.deepEqual(first.snapshot.entries.map((e) => [e.repo.name, e.state]), [["scheduled", "passed"]]);
    // No runs request for the repo without workflows, the push-only repo, or the one without Actions.
    const runCalls = gh.calls.filter((c) => c.path.endsWith("/actions/runs")).map((c) => c.path);
    assert.deepEqual(runCalls, ["/repos/me/scheduled/actions/runs"]);
    // Only the fields the page needs are kept.
    const cachedRuns = Object.entries(first.httpCache).find(([k]) => k.includes("/actions/runs"))[1];
    assert.equal(cachedRuns.data.workflow_runs[0].extra_field_we_drop, undefined);

    gh.calls.length = 0;
    const second = await loadSnapshot("t", {
      scheduledOnly: true,
      previous: first.snapshot,
      scheduleCache: first.scheduleCache,
      httpCache: JSON.parse(JSON.stringify(first.httpCache)),
    });
    assert.deepEqual(second.snapshot.entries.map((e) => [e.repo.name, e.state]), [["scheduled", "passed"]]);
    // Every list was asked for conditionally (answered 304), and workflow files came from the schedule cache.
    const listCalls = gh.calls.filter((c) => !c.path.includes("/no-actions/")); // a 404 has no ETag
    assert.ok(listCalls.every((c) => c.conditional), JSON.stringify(gh.calls));
    assert.equal(gh.calls.filter((c) => c.path.includes("/contents/")).length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
