# All Actions for GitHub

A browser extension that adds an account-wide **All actions** view to GitHub, next to "Issues" and "Pull requests". One page shows whether each of your repositories' scheduled workflows ran and passed, so you don't have to click into every repo each morning.

- **Actions** appears between Issues and Pull requests in GitHub's header and in the left-hand menu, with a red marker when something failed.
- The toolbar icon opens the same page and shows the number of failed workflows.
- Failures sort to the top. Each row shows the latest run, how long it took, and a strip of the last 10 runs. Click anything to open that run on GitHub.
- It runs entirely in your browser. There's no server: it talks to GitHub's API directly with your own read-only token.

> Status: early version (0.1). Works in Chrome, Edge, Brave and other Chromium browsers. Firefox support comes later.

## Install

1. Download this repository: **Code → Download ZIP**, then unzip it. (Or `git clone` it.)
2. Open your browser's extensions page:
   - Chrome / Brave: `chrome://extensions`
   - Edge: `edge://extensions`
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
5. The setup page opens automatically. You can also click the extension's toolbar icon.

To update later, replace the folder with a newer download and click the reload icon on the extension's card.

## Connect your GitHub account

The setup page walks you through this:

1. **Open GitHub's token page.** The link pre-fills a fine-grained token named "All Actions for GitHub" with **Actions: Read** permission and a 90-day expiry.
2. Under **Repository access**, choose **All repositories**, or only the repos you want watched. Then click **Generate token**.
3. Copy the token and paste it into the setup page, then click **Connect**.
4. Choose whether to watch **scheduled workflows only** (the default) or **every workflow run**, and click **Start watching**.

When the token expires, the page tells you, and you can paste a new one under **Settings**.

### What the token can do

It can only *read* workflow runs and basic repository details (name, visibility). It can't change code, settings or workflows. The token is stored in your browser's extension storage and is sent only to `api.github.com`.

## How it works

| Piece | File | What it does |
|---|---|---|
| All actions page | `src/dashboard.*` | Setup, then lists the latest run per workflow across your repos. |
| GitHub client | `src/lib/github.js` | Lists your repos (`GET /user/repos`), then recent runs per repo (`GET /repos/{owner}/{repo}/actions/runs`). GitHub has no account-wide runs endpoint, so it's one request per repo, six at a time. |
| Run logic | `src/lib/runs.js` | Groups runs by workflow, classifies them (failed, running, passed, cancelled/skipped), sorts and formats. No browser APIs, so it's unit-tested in Node. |
| Header links | `src/content.js` | On github.com, copies GitHub's own Pull requests link, turns it into an Actions link, and inserts it just before Pull requests. It only adds links. |
| Background | `src/background.js` | Opens the page from the toolbar icon and the injected links, and restores the badge after a restart. |

Results are cached, so the page opens instantly and refreshes when the last check is more than 5 minutes old (or when you click **Refresh**). With 20 repos that's about 21 requests per refresh, well under GitHub's 5,000 per hour.

## Development

No build step. Edit the files, then click the reload icon on the extension's card in `chrome://extensions`.

```sh
npm test   # unit tests for src/lib/runs.js (Node 20+)
```

## Roadmap

- **Next:** flag scheduled workflows that should have run but didn't (missed runs), name the failing step, refresh in the background on a timer, and add a toolbar popup.
- **Later:** release zips built automatically, Firefox support, store listings (Chrome Web Store, Edge Add-ons, Firefox Add-ons), "Sign in with GitHub" instead of a token, organization repos.

## License

[MIT](LICENSE)
