// Renders the All actions page with made-up demo data and saves the README screenshots
// (docs/screenshots/) and the extension store images (docs/store/): screenshots, the
// 300x300 logo and the 440x280 promo tile. Needs Playwright with Chromium:
//   npm i -D playwright && npx playwright install chromium
//   node scripts/screenshots/capture.cjs

const { execFileSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const root = path.resolve(__dirname, "../..");
const icon = fs.readFileSync(path.join(root, "icons/icon.svg"), "utf8");
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
  // README: the page itself, at 2x
  { file: "docs/screenshots/all-actions-light.png", colorScheme: "light", tab: null },
  { file: "docs/screenshots/all-actions-dark.png", colorScheme: "dark", tab: "All workflows" },
  // Stores: exactly 1280x800
  { file: "docs/store/screenshot-1-needs-attention.png", colorScheme: "light", tab: null, store: true },
  { file: "docs/store/screenshot-2-all-workflows-dark.png", colorScheme: "dark", tab: "All workflows", store: true },
];

const logo = `<body style="margin:0">${icon.replace("<svg ", '<svg width="300" height="300" ')}</body>`;
const promo = `<body style="margin:0;width:440px;height:280px;display:flex;align-items:center;gap:22px;padding:0 30px;
  box-sizing:border-box;background:#f6f8fa;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif">
  ${icon.replace("<svg ", '<svg width="104" height="104" style="flex:none" ')}
  <div><div style="font-size:27px;font-weight:600;line-height:1.15">All Actions for GitHub</div>
  <div style="margin-top:10px;font-size:16px;line-height:1.35;color:#59636e">Did every scheduled workflow run and pass? One page tells you.</div></div>
</body>`;
const IMAGES = [
  { file: "docs/store/logo-300.png", html: logo, width: 300, height: 300, transparent: true },
  { file: "docs/store/promo-tile-440x280.png", html: promo, width: 440, height: 280 },
];

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    for (const s of SHOTS) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: s.store ? 800 : 900 },
        deviceScaleFactor: s.store ? 1 : 2,
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
      if (s.store) await page.screenshot({ path: path.join(root, s.file) });
      else await page.locator("#host").screenshot({ path: path.join(root, s.file) });
      console.log("saved", s.file);
      await ctx.close();
    }
    for (const img of IMAGES) {
      const page = await browser.newPage({ viewport: { width: img.width, height: img.height } });
      await page.setContent(img.html);
      await page.screenshot({ path: path.join(root, img.file), omitBackground: Boolean(img.transparent) });
      console.log("saved", img.file);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
})();
