// Made-up demo data for the README screenshots: a fictional account and repositories,
// run through the real run logic so the rows look exactly as they would for real.
// Prints a snapshot as JSON. Times are relative to now.
import { summarizeRepoRuns, applySchedules } from "../../src/lib/runs.js";
import { previousFire } from "../../src/lib/cron.js";
const now = new Date();
const H = 3600e3;
let id = 1000;
const repo = (name, priv = false) => ({ full_name: `octo-demo/${name}`, name, html_url: `https://github.com/octo-demo/${name}`, private: priv });
const specs = [
  // repo, workflow, cron, delays(h) newest first, outcomes newest first (null = skipped day)
  { r: repo("nightly-backup", true), wf: "Back up database", cron: "30 6 * * *", delay: 2.1, out: ["failure", "success", "success", "success", "success", "success", "success", "success", "success", "success"], step: { job: "backup", step: "Upload to S3" } },
  { r: repo("weather-bot"), wf: "Post forecast", cron: "0 1 * * *", delay: 1.4, out: [null, "success", "success", "success", "failure", "success", "success", "success", "success", "success"] },
  { r: repo("status-page"), wf: "Uptime check", cron: "15 * * * *", hourly: true, out: ["in_progress", "success", "success", "success", "success", "success", "success", "success", "success", "success"] },
  { r: repo("price-tracker", true), wf: "Scrape prices", cron: "0 9 * * *", delay: 3.2, out: ["success", "success", "success", "success", "success", "success", "success", "failure", "success", "success"] },
  { r: repo("blog"), wf: "Rebuild site", cron: "0 4 * * 1", weekly: true, delay: 0.6, out: ["success", "success", "success", "success", "success", "success", "success"] },
  { r: repo("dotfiles"), wf: "Lint", cron: "0 12 * * *", delay: 0.4, out: ["success", "success", "cancelled", "success", "success", "success", "success", "success", "success", "success"] },
  { r: repo("old-experiment"), wf: "Refresh cache", cron: "0 3 * * 0", weekly: true, delay: 0.5, out: ["success", "success", "success"], ago: 62 * 24, wfState: "disabled_inactivity" },
  { r: repo("profile-readme"), wf: "Refresh profile", cron: "5 8 * * *", delay: 5.5, out: ["success", "success", "success", "success", "success", "success", "success", "success", "success", "success"] },
];
const entries = [];
for (const [i, s] of specs.entries()) {
  const wfId = 500 + i;
  const path = `.github/workflows/${s.wf.toLowerCase().replace(/\s+/g, "-")}.yml`;
  const runs = [];
  let t = now;
  // Walk back through scheduled fire times.
  let fire = previousFire(s.cron, new Date(now.getTime() - (s.ago ?? 0) * H - (s.hourly ? 0 : (s.out[0] === null ? 0 : (s.delay ?? 0) * H + 60e3))));
  for (const o of s.out) {
    if (o !== null) {
      const created = new Date(fire.getTime() + (s.hourly ? 4 * 60e3 : (s.delay ?? 0) * H + (id % 7) * 3 * 60e3));
      const running = o === "in_progress";
      runs.push({
        id: ++id, workflow_id: wfId, name: s.wf, path, event: "schedule", head_branch: "main",
        status: running ? "in_progress" : "completed", conclusion: running ? null : o,
        created_at: created.toISOString(), run_started_at: created.toISOString(),
        updated_at: new Date(created.getTime() + 40e3 + (id * 37 % 300) * 1e3).toISOString(),
        html_url: `${s.r.html_url}/actions/runs/${id}`,
      });
    }
    fire = previousFire(s.cron, new Date(fire.getTime() - 1000));
  }
  const es = applySchedules(summarizeRepoRuns(s.r, runs), s.r, [{ id: wfId, name: s.wf, path, state: s.wfState ?? "active", created_at: "2025-01-01T00:00:00Z" }], { [path]: [s.cron] }, now);
  for (const e of es) if (e.latest?.conclusion === "failure") e.failedStep = s.step ? { ...s.step, url: `${e.latest.url}/job/1` } : null;
  entries.push(...es);
}
const snapshot = { fetchedAt: new Date(now.getTime() - 3 * 60e3).toISOString(), scheduledOnly: true, scheduleAccess: "ok", repoCount: 9, entries, errors: [] };
console.log(JSON.stringify(snapshot));
