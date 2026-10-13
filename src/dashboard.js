import { loadSnapshot, getUser, TokenError, RateLimitError } from "./lib/github.js";
import {
  sortEntries, tally, filterEntries, formatDuration, formatWhen, formatAgo,
} from "./lib/runs.js";
import {
  getToken, setToken, clearToken, getLogin, setLogin, getSettings, setSettings, getSnapshot, setSnapshot, updateBadge,
} from "./lib/storage.js";

const STALE_MS = 5 * 60 * 1000;
const HISTORY = 10;

const TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?" +
  new URLSearchParams({
    name: "All Actions for GitHub",
    description: "Read-only access to workflow runs for the All Actions for GitHub browser extension.",
    expires_in: "90",
    actions: "read",
  });

const LABELS = {
  failed: "Failed",
  running: "Running",
  passed: "Passed",
  other: "Cancelled or skipped",
};
const GROUP_TITLES = {
  failed: "Needs attention",
  running: "Running",
  other: "Cancelled or skipped",
  passed: "Passed",
};

const ICONS = {
  failed: '<svg class="icon failed" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/></svg>',
  passed: '<svg class="icon passed" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z"/></svg>',
  running: '<svg class="icon running spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5" stroke-linecap="round"/></svg>',
  other: '<svg class="icon other" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm1.5 0a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm3.75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5Z"/></svg>',
};

const $ = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  tab: null,
  query: "",
  refreshing: false,
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v; // only used with the static icon strings above
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ---------------- Setup ---------------- */

async function showSetup({ firstRun }) {
  const [settings, login] = await Promise.all([getSettings(), getLogin()]);
  $("results").hidden = true;
  $("refresh").hidden = true;
  $("settings").hidden = true;
  $("setup").hidden = false;
  $("meta").textContent = "";
  $("token-link").href = TOKEN_URL;
  $("scope-scheduled").checked = settings.scheduledOnly;
  $("scope-all").checked = !settings.scheduledOnly;
  $("disconnect").hidden = firstRun;
  $("setup-cancel").hidden = firstRun;
  $("setup-done").textContent = firstRun ? "Start watching" : "Save";
  setStatus(login ? `Connected as @${login}. Paste a new token to replace it.` : "", login ? "ok" : "");
  $("token-input").value = "";
}

function setStatus(text, kind = "") {
  const s = $("token-status");
  s.textContent = text;
  s.className = `status ${kind}`;
}

async function onTokenSubmit(e) {
  e.preventDefault();
  const token = $("token-input").value.trim();
  if (!token) {
    setStatus("Paste the token GitHub showed you after you generated it.", "err");
    return;
  }
  $("token-save").disabled = true;
  setStatus("Checking the token with GitHub…");
  try {
    const user = await getUser(token);
    await setToken(token);
    await setLogin(user.login);
    $("token-input").value = "";
    setStatus(`Connected as @${user.login}.`, "ok");
  } catch (err) {
    setStatus(
      err instanceof TokenError
        ? "GitHub didn't accept that token. Check you copied all of it, then try again."
        : `Couldn't reach GitHub: ${err.message}`,
      "err",
    );
  } finally {
    $("token-save").disabled = false;
  }
}

async function onSetupDone() {
  if (!(await getToken())) {
    setStatus("Connect a token first (step 2).", "err");
    return;
  }
  const before = await getSettings();
  const scheduledOnly = $("scope-scheduled").checked;
  await setSettings({ ...before, scheduledOnly });
  $("setup").hidden = true;
  const changed = before.scheduledOnly !== scheduledOnly;
  showResults();
  if (changed || !state.snapshot) refresh();
}

async function onDisconnect() {
  await clearToken();
  await updateBadge(null);
  state.snapshot = null;
  showSetup({ firstRun: true });
}

/* ---------------- Results ---------------- */

function showResults() {
  $("setup").hidden = true;
  $("results").hidden = false;
  $("refresh").hidden = false;
  $("settings").hidden = false;
  render();
}

async function refresh() {
  if (state.refreshing) return;
  const token = await getToken();
  if (!token) return showSetup({ firstRun: true });
  const settings = await getSettings();
  state.refreshing = true;
  $("refresh").disabled = true;
  hideBanner();
  $("meta").textContent = "Finding your repositories…";
  try {
    const snapshot = await loadSnapshot(token, {
      scheduledOnly: settings.scheduledOnly,
      onProgress: (done, total) => {
        $("meta").textContent = `Checking ${done} of ${total} repositories…`;
      },
    });
    state.snapshot = snapshot;
    await setSnapshot(snapshot);
  } catch (err) {
    if (err instanceof TokenError) {
      showBanner("GitHub no longer accepts your token. It has probably expired. Open Settings to paste a new one.");
    } else if (err instanceof RateLimitError) {
      const at = err.resetAt ? ` Try again after ${new Date(err.resetAt).toLocaleTimeString()}.` : "";
      showBanner(`GitHub's hourly request limit was reached.${at}`);
    } else {
      showBanner(`Couldn't refresh: ${err.message}`);
    }
  } finally {
    state.refreshing = false;
    $("refresh").disabled = false;
    render();
  }
}

function showBanner(text) {
  const b = $("banner");
  b.textContent = text;
  b.hidden = false;
}
function hideBanner() {
  $("banner").hidden = true;
}

function renderMeta() {
  if (state.refreshing) return;
  const s = state.snapshot;
  if (!s?.fetchedAt) {
    $("meta").textContent = "";
    return;
  }
  const what = s.scheduledOnly ? "Scheduled workflows" : "All workflows";
  const ago = formatAgo(Date.now() - Date.parse(s.fetchedAt));
  $("meta").textContent = `${what} in ${s.repoCount} repositories · checked ${ago}`;
}

function render() {
  renderMeta();
  const s = state.snapshot;
  const entries = sortEntries(s?.entries ?? []);
  const counts = tally(entries);
  if (!state.tab) state.tab = counts.failed ? "attention" : "all";

  // Tabs
  const tabs = [
    ["attention", "Needs attention", counts.failed, null],
    ["all", "All", counts.total, null],
    ["failed", "Failed", counts.failed, "failed"],
    ["running", "Running", counts.running, "running"],
    ["passed", "Passed", counts.passed, "passed"],
  ];
  if (counts.other) tabs.push(["other", "Cancelled or skipped", counts.other, "other"]);
  $("tabs").replaceChildren(
    ...tabs.map(([key, label, n, dot]) =>
      el(
        "button",
        {
          class: "tab",
          type: "button",
          role: "tab",
          "aria-selected": String(state.tab === key),
          onclick: () => {
            state.tab = key;
            render();
          },
        },
        dot ? el("span", { class: "dot", style: `background: var(--${dot})` }) : null,
        label,
        " ",
        el("b", {}, n),
      ),
    ),
  );

  // Rows
  const shown = filterEntries(entries, state.tab, state.query);
  $("count").textContent = `${shown.length} ${shown.length === 1 ? "workflow" : "workflows"}`;
  const rows = [];
  if (!s) {
    rows.push(el("div", { class: "empty-state" }, "Checking your repositories for the first time…"));
  } else if (!entries.length) {
    rows.push(
      el(
        "div",
        { class: "empty-state" },
        s.scheduledOnly
          ? "No scheduled workflow runs in the last 14 days in the repositories this token can see."
          : "No workflow runs in the last 14 days in the repositories this token can see.",
      ),
    );
  } else if (!shown.length) {
    rows.push(
      el("div", { class: "empty-state" }, state.tab === "attention" && !state.query ? "Nothing needs attention. Every latest run passed or is still going." : "No workflows match."),
    );
  } else {
    let lastState = null;
    for (const e of shown) {
      if (state.tab === "all" && e.state !== lastState) {
        rows.push(el("div", { class: "group" }, GROUP_TITLES[e.state]));
        lastState = e.state;
      }
      rows.push(renderRow(e));
    }
  }
  $("rows").replaceChildren(...rows);

  // Per-repo errors
  const errs = s?.errors ?? [];
  const box = $("errors");
  box.hidden = !errs.length;
  if (errs.length) {
    box.querySelector("summary").textContent = `Couldn't read ${errs.length} ${errs.length === 1 ? "repository" : "repositories"}`;
    box.querySelector("ul").replaceChildren(...errs.map((x) => el("li", {}, `${x.repo}: ${x.message}`)));
  }
}

function renderRow(e) {
  const now = new Date();
  const l = e.latest;
  const parts = [];
  parts.push(l.event === "schedule" ? "Scheduled" : `On ${l.event.replace(/_/g, " ")}`);
  if (l.branch) parts.push(`on ${l.branch}`);
  if (e.state === "running") parts.push(`started ${formatAgo(now - Date.parse(l.startedAt))}`);
  else {
    const d = formatDuration(Date.parse(l.updatedAt) - Date.parse(l.startedAt));
    if (d) parts.push(`took ${d}`);
  }

  const hist = e.history.map((h) =>
    el("a", { class: h.state, href: h.url, target: "_blank", rel: "noopener", title: `${LABELS[h.state]} · ${formatWhen(h.createdAt, now)}` }),
  );
  while (hist.length < HISTORY) hist.unshift(el("span", { class: "empty" }));

  return el(
    "div",
    { class: "row" },
    el("span", { html: ICONS[e.state], title: LABELS[e.state] }),
    el(
      "div",
      {},
      el(
        "div",
        { class: "title" },
        el("a", { href: `${e.repo.url}/actions`, target: "_blank", rel: "noopener" }, e.repo.name),
        el("span", { class: "wf" }, " / ", el("a", { href: e.workflow.url, target: "_blank", rel: "noopener" }, e.workflow.name)),
      ),
      el("div", { class: "sub" }, parts.join(" · ")),
    ),
    el(
      "div",
      { class: "when" },
      el("a", { href: l.url, target: "_blank", rel: "noopener" }, el("b", {}, LABELS[e.state])),
      ` · ${formatWhen(l.createdAt, now)}`,
    ),
    el("div", { class: "hist", "aria-label": "Last 10 runs, oldest first" }, hist),
  );
}

/* ---------------- Boot ---------------- */

async function init() {
  $("token-form").addEventListener("submit", onTokenSubmit);
  $("setup-done").addEventListener("click", onSetupDone);
  $("setup-cancel").addEventListener("click", showResults);
  $("disconnect").addEventListener("click", onDisconnect);
  $("settings").addEventListener("click", () => showSetup({ firstRun: false }));
  $("refresh").addEventListener("click", refresh);
  $("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });
  setInterval(renderMeta, 30000);

  const [token, snapshot] = await Promise.all([getToken(), getSnapshot()]);
  if (!token) return showSetup({ firstRun: true });
  state.snapshot = snapshot?.fetchedAt ? snapshot : null;
  showResults();
  if (!state.snapshot || Date.now() - Date.parse(state.snapshot.fetchedAt) > STALE_MS) refresh();
}

init();
