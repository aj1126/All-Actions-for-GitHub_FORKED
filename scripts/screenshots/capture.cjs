// Renders the All actions page with made-up demo data and saves the README screenshots
// to docs/screenshots/. Needs Playwright with Chromium:
//   npm i -D playwright && npx playwright install chromium
//   node scripts/screenshots/capture.cjs

const { execFileSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const root = path.resolve(__dirname, "../..");
const out = path.join(root, "docs/screenshots");
const snapshot = execFileSync(process.execPath, [path.join(__dirname, "demo-data.mjs")], { encoding: "utf8" });

const harness = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; } }
</style></head><body><div id="host"></div><script type="module">
  const snapshot = ${snapshot};
  window.chrome = {
    runtime: { getURL: (p) => "/" + p, sendMessage: async () => {} },
    storage: { local: { get: async () => ({ snapshot, token: "demo" }) }, onChanged: { addListener() {}, removeListener() {} } },
  };
  const { mountView } = await import("/src/view.js");
  await mountView(document.getElementById("host"));
  document.body.dataset.ready = "1";
</script></body></html>`;

const TYPES = { ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") return res.end(harness);
  const file = path.join(root, url.pathname);
  if (!file.startsWith(path.join(root, "src")) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "text/plain" }).end(fs.readFileSync(file));
});

const SHOTS = [
  { file: "all-actions-light.png", colorScheme: "light", tab: null },
  { file: "all-actions-dark.png", colorScheme: "dark", tab: "All workflows" },
];

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    for (const s of SHOTS) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: s.colorScheme,
        timezoneId: "America/New_York",
        locale: "en-US",
      });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.error("page error:", e.message));
      await page.goto(base);
      await page.waitForSelector("body[data-ready]");
      if (s.tab) await page.locator("#host").locator(`button:has-text("${s.tab}")`).first().click();
      await page.waitForTimeout(300);
      await page.locator("#host").screenshot({ path: path.join(out, s.file) });
      console.log("saved", s.file);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
})();
