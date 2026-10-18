// A fake api.github.com for loadSnapshot tests: repos, workflows, workflow files and runs,
// with the runs API's event/actor filters, per_page/page paging and Link headers.

export const API = "https://api.github.com";

export const repo = (name) => ({
  full_name: `me/${name}`, name, html_url: `https://github.com/me/${name}`, private: false, archived: false,
});

export const workflow = (id, file, name = file) => ({
  id, name, path: `.github/workflows/${file}`, state: "active", created_at: "2026-01-01T00:00:00Z",
});

/** A run in the API's own shape (actor and triggering_actor are objects). */
export function mkRun({ id, wf, event = "push", at, conclusion = "success", actor = "me", trig = actor, attempt = 1 }) {
  const t = at instanceof Date ? at.toISOString() : at;
  return {
    id, workflow_id: wf, name: `WF ${wf}`, path: `.github/workflows/wf${wf}.yml`, event, head_branch: "main",
    status: "completed", conclusion, created_at: t, run_started_at: t, updated_at: t,
    html_url: `https://github.com/me/x/actions/runs/${id}`, run_attempt: attempt,
    actor: { login: actor }, triggering_actor: { login: trig },
  };
}

const yamlFor = (text) => ({ content: Buffer.from(text).toString("base64") });
export const cronYaml = (cron) => `on:\n  schedule:\n    - cron: "${cron}"\n`;

/**
 * `repos`: list from repo(); `workflows`: { fullName: [workflow()] }; `files`: { "fullName:path": yaml text };
 * `runs`: { fullName: [mkRun()] }. Every request is recorded in `calls`.
 */
export function fakeGitHub({ repos = [], workflows = {}, files = {}, runs = {} } = {}) {
  const calls = [];
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const notFound = () => new Response("{}", { status: 404, headers: { "x-ratelimit-remaining": "4000" } });

  function page(u, list, key) {
    const perPage = Number(u.searchParams.get("per_page") || 30);
    const n = Number(u.searchParams.get("page") || 1);
    const slice = list.slice((n - 1) * perPage, n * perPage);
    const headers = {};
    if (n * perPage < list.length) {
      const next = new URL(u);
      next.searchParams.set("page", String(n + 1));
      headers.link = `<${next}>; rel="next"`;
    }
    return json(key ? { total_count: list.length, [key]: slice } : slice, headers);
  }

  const newestFirst = (list) => [...list].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({
      url: u.toString(), origin: u.origin, path: u.pathname,
      params: Object.fromEntries(u.searchParams), auth: init.headers?.Authorization ?? null,
    });
    const p = u.pathname;
    if (p === "/user/repos") return page(u, repos, null);
    let m = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/workflows$/);
    if (m) return workflows[m[1]] ? json({ workflows: workflows[m[1]] }) : notFound();
    m = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/(\d+)\/runs$/);
    if (m) {
      let list = (runs[m[1]] ?? []).filter((r) => r.workflow_id === Number(m[2]));
      const ev = u.searchParams.get("event");
      if (ev) list = list.filter((r) => r.event === ev);
      return page(u, newestFirst(list), "workflow_runs");
    }
    m = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/);
    if (m) {
      let list = runs[m[1]] ?? [];
      const ev = u.searchParams.get("event");
      const actor = u.searchParams.get("actor");
      if (ev) list = list.filter((r) => r.event === ev);
      if (actor) list = list.filter((r) => r.actor.login === actor);
      return page(u, newestFirst(list), "workflow_runs");
    }
    m = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/jobs$/);
    if (m) return json({ jobs: [] });
    m = p.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
    if (m) {
      const text = files[`${m[1]}:${decodeURIComponent(m[2])}`];
      return text === undefined ? notFound() : json(yamlFor(text));
    }
    return notFound();
  };
  return { fetch, calls };
}

/** Run `fn` with globalThis.fetch replaced, restoring it afterwards. */
export async function withFetch(fakeFetch, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
