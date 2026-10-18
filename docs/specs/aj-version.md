Project: Workstation / GitHub tooling (All Actions fork, AJ's version)

# SPEC -- All Actions for GitHub, AJ build 1: runs I started, the "missed" fix, token hardening (AR-5..AR-7; fork issue #1, R1, R2, R10)

**Implementer:** Claude Sonnet in a sub1 cloud session (`claude --cloud`, model pinned by `.claude/settings.json` on this branch),
Sonnet / medium. **Transcription only:** every line of code is in `docs/specs/aj-version.patch`; the tests were written first.
**Repo:** `aj1126/All-Actions-for-GitHub_FORKED` (fork of `amorphose/All-Actions-for-GitHub`). Flow: branch -> PR to `main` -> AJ merges.
**Base commit:** `88890e1e9fbd2bd3282e6274f12d80a0c5a816a8` on `main` (identical to upstream on 2026-10-18 09:14). If `origin/main` has moved, stop and say so.
**Spec branch:** `spec/aj-version` (this file, the patch, the tests, the model pin). It leaves `manifest.json` and `src/` exactly as at the base.
**Work branch:** `build/aj-version`, created from `origin/spec/aj-version`. Never commit to `main` or `spec/aj-version`.
**Shell:** POSIX `sh`/`bash` (the cloud session is Linux). Every command runs from the repository root.
**Written:** 2026-10-18 09:13-09:45, Opus 5.5 (sub1). The patch was built and run by Opus first in a scratch worktree on Windows
(node 22.16.0, Git Bash): `npm test` 54/54; the same tests on the base code 27 pass / 27 fail. Executed in Edge 155.0.4283.60 too (results
in "Evidence" below). This spec's T, V and Commit text was then rehearsed verbatim in Git Bash on a fresh shallow, single-branch clone of a scratch
bare copy of the repo (path with a space, LF checkout). The first rehearsal found 2 wrong EXPECTs (staged-status order, a possible
tracking line); fixed, then re-rehearsed clean.
**Reuse:** the repo's own `node --test` suite and its fake-`fetch` style (`test/github.test.js`), extended with two shared fakes in
`test-support/` (outside `test/`, because `node --test` runs every file under a `test/` folder). No new scripts, dependencies or build steps.
**Gate-check pins** (copied into the B2 queue entry; run on AJ's machine):
`(git -C B:/Repos/All-Actions-for-GitHub_FORKED cat-file -t 88890e1e9fbd2bd3282e6274f12d80a0c5a816a8) -eq 'commit'` and
`(git -C B:/Repos/All-Actions-for-GitHub_FORKED rev-parse origin/spec/aj-version:docs/specs/aj-version.patch) -eq '92d10f746b9ad11db77031cd8a1827cdfd221809'`
(the patch's blob; SHA-256 prefix `027fa581d17a8c76`), plus the branch-tip pin in the entry itself (`git ls-remote` of `spec/aj-version` =
the pushed tip).
**Merge order:** none. No other open spec touches this repo (`rg -l "All-Actions|aj-version" B:/_handoff/specs` = no hits, 2026-10-18).
**Resume rule:** if `build/aj-version` already exists from a stopped run, do not re-create it: check `git rev-parse --abbrev-ref HEAD`
= `build/aj-version`, `git status --porcelain` against the T2 EXPECT, and `git log --oneline origin/spec/aj-version..HEAD` (empty before
the commit, one line after), then continue from the first step whose EXPECT is not yet met.

## Why

AJ wants his own runs (pushes, PRs, manual runs, re-runs) tracked next to his schedules (fork issue #1). The review found that scope
"All workflows" can call a cron that ran "missed" when 100 newer runs fill the one page read (R10). It also found that the token can be sent to
any absolute URL a `Link` header names (R1), and that the token sits in `storage.local`, which content scripts on github.com can read (R2).
AR-6 (AJ, 2026-10-18 09:10) fixes all four in one build. AR-7: the browser trial runs after it, on the built commit.

## The rule (decided by Opus; do not change)

**Scopes.** The setting `scope` is one of `scheduled` (default), `mine`, `all` (`SCOPES` in `runs.js`). `scopeOf(x)` returns `x.scope`
when it's one of those; otherwise `x.scheduledOnly === false` -> `all`; otherwise `scheduled`. It is used for saved settings (`getSettings`
drops `scheduledOnly` and returns `scope`), for snapshots (old ones have only `scheduledOnly`) and for `loadSnapshot` options.
Scheduled-only users see no change.

| Scope | Settings radio (`id`, label) | Page headline (`SCOPE_TEXT.meta`) |
|---|---|---|
| `scheduled` | `scope-scheduled`, "Scheduled workflows only (recommended)" | "Scheduled workflows" |
| `mine` | `scope-mine`, "Scheduled workflows and runs I started" | "Scheduled workflows and runs you started" |
| `all` | `scope-all`, "Every workflow run" | "All workflows" |

**Queries per repo** (`loadSnapshot`):
- Scheduled runs **always** come from their own query (`listScheduledRuns`: `event=schedule`, one page of 100, `full` = GitHub sent a
  next link). It runs when any workflow file has a cron (or a file couldn't be read). The scope `scheduled` skips a repo with no crons, as before.
- A cron workflow missing from that page gets the existing per-workflow look-back (`lastScheduledRun`). That happens when its due time is
  older than the 14-day window (as before), **or when the page was `full`** (new, R10).
- `all`: plus `listRunPages` (any event, up to `RUN_PAGE_LIMIT` = 5 pages of 100), merged with the scheduled runs, deduplicated by run id.
- `mine`: plus `listRunPages` with `actor=<login>` (server-side filter). Rows are kept only when the event isn't `schedule` and
  `triggering_actor.login` (falling back to `actor.login`) equals the login. A bot's re-run of your push is not yours. They become
  **separate rows**: key `<repo>#<workflow id>#mine`, `origin: "mine"`, next to the unchanged scheduled rows. `login` comes from
  storage (`getLogin`); when it is empty, `loadSnapshot` asks `/user` once.
- A `listRunPages` that still has a next page after 5 pages puts the repo in `snapshot.capped` (sorted). The page then shows
  `capNote`: "Stopped at the newest 500 runs in 1 repository (me/a). Older runs from the last 14 days aren't shown." (plural:
  "in 2 repositories (me/a, me/b)"). A cap hit is never read as "missed".
- Kept run fields add `run_attempt`, `actor_login`, `triggering_login`. `entry.latest.attempt` = `run_attempt ?? 1`.
- The snapshot carries `scope` and `capped` instead of `scheduledOnly`.

**Row text.** `leadParts(entry, now)` gives the start of a row's second line:
- My rows: "Started by you", then the trigger.
- Other rows: the cron description (if any), then the trigger when there's no cron or the latest run isn't the schedule.
- `triggerLabel`: `schedule` "Scheduled", `push` "Push", `pull_request`/`pull_request_target` "Pull request", `workflow_dispatch` "Manual
  run". Anything else is the event with `_` -> space and a capital first letter. Empty is "Unknown trigger". Attempt > 1 adds " (re-run)".
  This replaces 0.8.0's "On push" wording.

**Notifications.** A new setting `notifyMine` (default off; checkbox `notify-mine`, "Show a desktop notification when a run you started
fails") governs problems on my rows. `notify` governs every other row (`pickProblems`). `notifyPass` is unchanged and covers all rows.
The settings note reads "All three are off by default."

**R1.** `request()` throws `OriginError("Refused to send the token to <origin>: only https://api.github.com is allowed.")` **before**
`fetch` for any URL whose `origin` isn't `https://api.github.com` (that includes `http://api.github.com`). Redirect handling is unchanged.

**R2.**
- **Locking storage:** `lockDownStorage()` sets `storage.local` to `TRUSTED_CONTEXTS` and `storage.session` to
  `TRUSTED_AND_UNTRUSTED_CONTEXTS`. The service worker calls it at every start, then `syncViewState()`, which copies `snapshot` and a
  `hasToken` boolean into `storage.session` (never the token).
- **What lives where:** `setToken` and `clearToken` keep the `hasToken` flag in session. `setSnapshot` writes both areas;
  `clearSnapshot` clears both. `refreshState` lives in session only, and the 0.8.0 copy in `local` is removed at `setUp`.
- **Content scripts read session only:** `view.js` reads through `src/lib/viewstate.js` (`readViewState`, `isViewChange`,
  `shouldRefresh`, `isRunning`; it is listed in `web_accessible_resources`), and `content.js` reads `storage.session` too.
- **Before the worker has filled session:** `hasToken` is `null`. The view shows "Loading…" and sends `{type: "sync-view"}`; the worker
  answers by re-running `syncViewState`. The view refreshes once `hasToken` turns true and the results are missing or older than 5 minutes.
- **Settings page:** `settings.js` reaches storage only through `storage.js`.

**Version.** `manifest.json` `version` "0.8.0.1", `version_name` "0.8.0 (AJ build 1)". No new permissions or hosts. `package.json` unchanged.

**Not in this build:** R6 wording (a note for Shane), README/PRIVACY text, redirect policy, the upstream "Report a problem" link.

## HARD RULES -- violating any of these fails the task

1. Apply `docs/specs/aj-version.patch` exactly with `git apply`. Do not hand-edit any file in `src/`, `manifest.json` or `test/`. If
   `git apply --check` fails, stop and report the error; do not "fix" the patch.
2. Do not edit, add or delete tests. If a test fails, stop and report its full output.
3. Stage explicit paths only (the list in "Commit"). Never `git add -A`, `git add .` or `git commit -a`.
4. Push only `build/aj-version`, once, at the end; AJ's launch of this session is the go for that one push. Never push `main` or
   `spec/aj-version`, never force-push, and open no PR. If the push is refused, stop and paste the exact error.
5. No `npm install`; the project has no dependencies. Run only the commands in this spec.
6. Leave `.claude/settings.json`, `docs/specs/aj-version.md` and `.github/` untouched.

## T1 -- check the base and the patch

```sh
cd "$(git rev-parse --show-toplevel)"
git status --porcelain
# EXPECT: no output. If not, stop and report.
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --unshallow origin; echo "history complete"
# EXPECT: history complete
git fetch -q origin +main:refs/remotes/origin/main +spec/aj-version:refs/remotes/origin/spec/aj-version && echo "fetched"
# EXPECT: fetched
git rev-parse origin/main
# EXPECT: 88890e1e9fbd2bd3282e6274f12d80a0c5a816a8
git diff --quiet 88890e1e9fbd2bd3282e6274f12d80a0c5a816a8 origin/spec/aj-version -- manifest.json src && echo "src unchanged on spec branch"
# EXPECT: src unchanged on spec branch
git show origin/spec/aj-version:docs/specs/aj-version.patch | sha256sum | cut -c1-16
# EXPECT: 027fa581d17a8c76
node --version | cut -d. -f1
# EXPECT: v20 or higher (v20, v22, v24 ...). If lower, stop and report.
```

## T2 -- branch and apply

```sh
git switch --no-track -c build/aj-version origin/spec/aj-version
# EXPECT: Switched to a new branch 'build/aj-version'
git rev-parse --abbrev-ref '@{u}' 2>&1 | head -1
# EXPECT: fatal: no upstream configured for branch 'build/aj-version'
npm test 2>&1 | grep -E '^# (tests|pass|fail) '
# EXPECT (the new tests fail before the patch):
# # tests 54
# # pass 27
# # fail 27
git apply --check docs/specs/aj-version.patch && echo "apply check ok"
# EXPECT: apply check ok
git apply docs/specs/aj-version.patch
git status --porcelain
# EXPECT exactly:
#  M manifest.json
#  M src/background.js
#  M src/content.js
#  M src/lib/github.js
#  M src/lib/runs.js
#  M src/lib/storage.js
#  M src/settings.html
#  M src/settings.js
#  M src/view.css
#  M src/view.js
# ?? src/lib/viewstate.js
```

The patch (795 lines) changes 10 files and adds `src/lib/viewstate.js` (36 lines): 297 insertions, 88 deletions.

## Verification -- run these, paste real output

```sh
# V1 - every source file parses
for f in src/*.js src/lib/*.js; do node --check "$f" || echo "FAIL $f"; done; echo "V1 done"
# EXPECT: V1 done   (and no FAIL line)

# V2 - manifest is valid JSON with the build version
node -e 'const m = JSON.parse(require("fs").readFileSync("manifest.json", "utf8")); console.log(m.version, "|", m.version_name)'
# EXPECT: 0.8.0.1 | 0.8.0 (AJ build 1)

# V3 - the new tests
node --test test/github-scope.test.js test/github-origin.test.js test/runs-scope.test.js test/storage.test.js test/viewstate.test.js test/source-guards.test.js 2>&1 | grep -E '^# (tests|pass|fail) '
# EXPECT:
# # tests 28
# # pass 28
# # fail 0

# V4 - full suite (26 existing + 28 new)
npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped) '
# EXPECT:
# # tests 54
# # pass 54
# # fail 0
# # skipped 0

# V5 - negative control: the same tests against the base code, in a throwaway worktree
rm -rf /tmp/aa-base && git worktree add --detach /tmp/aa-base 88890e1e9fbd2bd3282e6274f12d80a0c5a816a8 >/dev/null 2>&1
cp -r test test-support /tmp/aa-base/
(cd /tmp/aa-base && npm test 2>&1 | grep -E '^# (tests|pass|fail) ')
# EXPECT:
# # tests 54
# # pass 27
# # fail 27
git worktree remove --force /tmp/aa-base && echo "base worktree removed"
# EXPECT: base worktree removed
```

## Commit

```sh
git add manifest.json src/background.js src/content.js src/lib/github.js src/lib/runs.js src/lib/storage.js src/lib/viewstate.js
git add src/settings.html src/settings.js src/view.css src/view.js
git rm -q docs/specs/aj-version.patch
git status --porcelain
# EXPECT exactly (all staged):
# D  docs/specs/aj-version.patch
# M  manifest.json
# M  src/background.js
# M  src/content.js
# M  src/lib/github.js
# M  src/lib/runs.js
# M  src/lib/storage.js
# A  src/lib/viewstate.js
# M  src/settings.html
# M  src/settings.js
# M  src/view.css
# M  src/view.js
git commit -q -s -m "feat: AJ build 1 - runs I started, scheduled runs never missed by a full page, token only to api.github.com and out of content scripts" -m "Spec: docs/specs/aj-version.md (patch sha256 027fa581d17a8c76). Fork issue #1, review R1 R2 R10."
git status --porcelain
# EXPECT: no output
git log --oneline origin/spec/aj-version..HEAD | wc -l
# EXPECT: 1
npm test 2>&1 | grep -E '^# (pass|fail) '
# EXPECT:
# # pass 54
# # fail 0
git push -u origin build/aj-version 2>&1 | tail -1
# EXPECT: a line naming build/aj-version (e.g. "branch 'build/aj-version' set up to track 'origin/build/aj-version'."). If refused, stop and paste the error.
```

**Report:** the branch, the commit hash (`git rev-parse HEAD`), the push line, and T1, T2, V1-V5 and the Commit block's output, pasted in full.

## Pre-existing noise -- NOT yours, do not fix, do not stage

- `PRIVACY.md` and `README.md` still describe 0.8.0 (R6 is a note for Shane, not this build).
- `src/settings.js` "Report a problem" points at upstream (`amorphose/All-Actions-for-GitHub`); leave it.
- `.github/workflows/*.yml` use tag-pinned actions; Actions is turned off on the fork (AR-3). No CI runs on the push.
- `package.json` stays at `0.8.0` (npm doesn't accept a 4-part version).

## Evidence from the pre-run (Opus, 2026-10-18, Windows, Edge 155.0.4283.60)

- **The view in a real browser engine:** the patched `src/view.js` ran in headless Edge with a fake `chrome` whose `storage.local` throws.
  Before the worker answered, it showed "Loading…" and sent `sync-view`. A `local` token change was ignored. After `hasToken: true` and
  a 10-minute-old snapshot, it sent `refresh` and drew "Started by you · Manual run (re-run) · on main" and the cap note (12px, muted).
  It made **0** `storage.local` calls and raised no page error. The base `view.js` in the same harness: page error "storage.local is closed".
- **The built extension, loaded unpacked (temp profile):** the worker's session held `{"hasToken":false,"refreshState":{"running":false},"snapshot":null}`.
  The settings page showed three radios (`scope-scheduled=true`) and `notify-mine`, and clicking "mine" saved
  `{"missedAfterHours":12,"notify":false,"notifyMine":false,"notifyPass":false,"scope":"mine"}`, with no page errors. On
  `https://github.com/?all-actions` (no token) the content script drew "Connect your GitHub account to see your workflow runs here."
- **R2 by execution:** a probe content script on github.com, after a dummy token was set from the worker:

| Build | `storage.local.get("token")` from a content script | `storage.session.get("hasToken")` |
|---|---|---|
| AJ build 1 | REFUSED "Access to storage is not allowed from this context." | READ |
| AJ build 1, after a browser restart (same profile) | REFUSED | READ `{"hasToken":true}` |
| base `88890e1` (control) | READ `{"token":"PROBE_DUMMY_NOT_A_TOKEN"}` | REFUSED |

- **Not documented, observed once:** whether an access level survives a browser restart (Chrome storage API reference, StorageArea
  `setAccessLevel`, read 2026-10-18, doesn't say). After one restart the probe was refused, but that may be the worker re-setting it before
  the page loaded. AA-TRIAL (B4) repeats the probe in AJ's Edge.

## Opus review after `/clear` (not Sonnet's job)

1. Fetch `build/aj-version` into a local worktree (`git worktree add --no-track -b review/aj-version <path> origin/build/aj-version`).
   Re-run T1's base and patch checks, V1-V5 and `git diff origin/spec/aj-version --stat | tail -1`. EXPECT: `12 files changed, 297
   insertions(+), 883 deletions(-)` (the 11 patch paths, 297+/88-, plus the deleted 795-line patch). Also check the commit message
   carries a `Signed-off-by:` line.
2. Byte-compare: `git diff origin/spec/aj-version origin/build/aj-version -- manifest.json src` equals the patch's content (apply the patch
   to a scratch tree of the spec tip and `git diff --no-index` it against the build tree).
3. Re-run the review's own probes on the build:
   - The F9 probe (`~/.claude/tools-wt-aa-review/tests/manual/aa-trial/f9-probe.mjs <build>/src/lib/github.js`) must now **reject** with
     OriginError and make one request.
   - Run the step 3 sink scans again on the diff, and `gitleaks detect --redact`.
   - Load the build unpacked in Edge (scratch profile) and repeat the R2 probe table above.
4. Export the load folder for AA-TRIAL from the build commit (`Export-PinnedExtension.ps1`). Re-sign the hashes, and re-take
   AA-TRIAL's expected values (AR-7).
5. Remove `.claude/settings.json` (the cloud model pin) in a review commit before the PR.
6. AJ's go: PR `build/aj-version` -> `main` on the fork (`/pr-body`), AJ merges. Then B4: AA-TRIAL on the merged commit, steps 7-9.
