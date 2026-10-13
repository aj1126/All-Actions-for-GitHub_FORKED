# All Actions for GitHub

A browser extension that adds an account-wide **All actions** view to GitHub, next to "All issues" and "All pull requests". One page shows whether each of your repositories' scheduled workflows ran and passed, so you don't have to click into every repo each morning.

- **Actions** appears between Issues and Pull requests in GitHub's header and in the left-hand menu. The header icon gets a red dot when something needs attention.
- The page opens at `https://github.com/?all-actions`, inside GitHub's own top bar, with a sidebar of filters like the All issues page.
- Problems sort to the top: runs that **failed** (with the step that failed) and scheduled workflows that **didn't run** when they were due, including ones GitHub switched off after 60 days without activity.
- Each row shows the schedule in plain words ("Daily at 05:00 UTC"), the latest run, and a strip of the last 10 runs. Click anything to open it on GitHub.
- It checks again in the background every 30 minutes, and the toolbar icon shows how many workflows need attention.
- Optional desktop notifications when a workflow fails or doesn't run (off by default).
- It runs entirely in your browser. There's no server: it talks to GitHub's API directly with your own read-only token.

> Status: early version (0.3.1). Works in Chrome, Edge, Brave and other Chromium browsers. Firefox support comes later.

## Install

1. Download this repository: **Code → Download ZIP**, then unzip it. (Or `git clone` it.)
2. Open your browser's extensions page:
   - Chrome / Brave: `chrome://extensions`
   - Edge: `edge://extensions`
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
5. The setup page opens automatically. After setup, open the list from the new Actions icon on GitHub or the extension's toolbar icon.

### Updating

Your token and settings are kept when you update, so setup is a one-time step.

1. Get the new files **into the same folder** (`git pull`, or unzip the new download over the old folder).
2. On the extensions page, click the reload icon on the extension's card.
3. Refresh any open GitHub tabs.

Loading a copy from a *different* folder counts as a new extension, and removing the extension deletes its storage. Either one means pasting your token again.

## Connect your GitHub account

The setup page walks you through this:

1. **Open GitHub's token page.** The link pre-fills a fine-grained token named "All Actions for GitHub" with a 90-day expiry and two read-only permissions:
   - **Actions: Read** to see workflow runs.
   - **Contents: Read** to read each workflow file's `schedule:` so the extension can tell when a run is missing. Without it everything else still works; you just won't see "didn't run" warnings.
2. Under **Repository access**, choose **All repositories**, or only the repos you want watched. Then click **Generate token**.
3. Copy the token and paste it into the setup page, then click **Connect**.
4. Choose whether to watch **scheduled workflows only** (the default) or **every workflow run**, optionally turn on desktop notifications, and click **Open All actions**.

Upgrading from 0.2 or earlier? Your token keeps working. To get "didn't run" warnings, [edit the token on GitHub](https://github.com/settings/personal-access-tokens), add **Contents: Read** under Repository permissions and save; the token value doesn't change.

When the token expires, the page tells you, and you can paste a new one under **Settings** (also available by right-clicking the toolbar icon and choosing **Options**).

### What the token can do

It can only *read*: workflow runs, repository details (name, visibility) and file contents (used only for workflow files under `.github/workflows/`). It can't change code, settings or workflows. The token is stored in your browser's extension storage and is sent only to `api.github.com`.

## How it works

| Piece | File | What it does |
|---|---|---|
| All actions page | `src/view.*` | The list itself, rendered in a shadow root so GitHub's styles and ours don't collide. It uses GitHub's own color variables, so it follows your GitHub theme. |
| Settings | `src/settings.*` | Token setup and the scheduled-only option. |
| GitHub client | `src/lib/github.js` | Lists your repos (`GET /user/repos`), then recent runs per repo (`GET /repos/{owner}/{repo}/actions/runs`). GitHub has no account-wide runs endpoint, so it's one request per repo, six at a time. |
| Run logic | `src/lib/runs.js`, `src/lib/cron.js` | Groups runs by workflow, classifies them (failed, didn't run, running, passed, cancelled/skipped), works out when each schedule last should have fired, sorts and formats. No browser APIs, so it's unit-tested in Node. |
| GitHub integration | `src/content.js`, `src/early.js` | Copies GitHub's own Pull requests link, turns it into an Actions link, and inserts it just before Pull requests. On `github.com/?all-actions` it hides the page body and shows the list in its place, under GitHub's real top bar. |
| Background | `src/background.js` | Does the fetching (on request and every 30 minutes), saves results to extension storage, and keeps the toolbar badge current. |

Results are cached, so the page opens instantly and refreshes when the last check is more than 5 minutes old (or when you click **Refresh**). Each refresh makes about two requests per repo (recent runs and the workflow list), plus one per newly failed run to find the failing step. Workflow files are re-read at most every 12 hours. With 20 repos that's around 40 requests per refresh, well under GitHub's 5,000 per hour.

### How "didn't run" works

GitHub runs schedules in UTC and often starts them hours late at busy times, so a scheduled run counts as missed only when nothing has started **12 hours** after it was due. Late runs inside that window aren't flagged. Workflows created after the due time are ignored, and a schedule you turned off yourself shows as "Turned off" rather than as a problem.

## Development

No build step. Edit the files, then click the reload icon on the extension's card in `chrome://extensions`.

```sh
npm test   # unit tests for src/lib/runs.js (Node 20+)
```

## Roadmap

- **Next:** release zips built automatically, README screenshots, Firefox support.
- **Later:** store listings (Chrome Web Store, Edge Add-ons, Firefox Add-ons), "Sign in with GitHub" instead of a token, organization repos, a Re-run button.

## License

[MIT](LICENSE)
