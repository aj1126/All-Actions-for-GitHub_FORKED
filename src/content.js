// Adds an "Actions" entry between Issues and Pull requests in GitHub's header and
// navigation menu. It copies GitHub's own Pull requests element so the new entry picks
// up the site's styling, then swaps the icon, label and link. Only links are added.

(() => {
  const MARK = "data-all-actions";
  const DASHBOARD = chrome.runtime.getURL("src/dashboard.html");
  // GitHub's "play" octicon, used for Actions across the site.
  const ICON_PATH =
    "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z";
  const SCOPES = "header, .AppHeader, dialog, [role='dialog'], nav";
  const PR_LINK = 'a[href="/pulls"], a[href="https://github.com/pulls"]';

  let failedCount = 0;

  function makeIcon(original) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const attr of ["class", "width", "height", "aria-hidden"]) {
      const v = original?.getAttribute(attr);
      if (v) svg.setAttribute(attr, v);
    }
    if (!svg.getAttribute("width")) svg.setAttribute("width", "16");
    if (!svg.getAttribute("height")) svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICON_PATH);
    svg.append(path);
    return svg;
  }

  function relabel(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let hasText = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue.trim();
      if (!t) continue;
      if (/pull requests/i.test(t)) {
        n.nodeValue = n.nodeValue.replace(/your pull requests/i, "All actions").replace(/pull requests/i, "Actions");
        hasText = true;
      } else if (/^\d+$/.test(t)) {
        n.nodeValue = ""; // drop GitHub's own PR counter if one was copied
      }
    }
    return hasText;
  }

  function buildEntry(prLink) {
    const unit = prLink.parentElement?.tagName === "LI" ? prLink.parentElement : prLink;
    const clone = unit.cloneNode(true);
    clone.setAttribute(MARK, "");
    for (const node of [clone, ...clone.querySelectorAll("*")]) {
      node.removeAttribute("id");
      node.removeAttribute("data-hotkey");
      node.removeAttribute("aria-current");
      node.removeAttribute("aria-labelledby");
      node.removeAttribute("aria-describedby");
      node.removeAttribute("data-analytics-event");
      node.removeAttribute("data-hydro-click");
      node.removeAttribute("data-hydro-click-hmac");
      node.classList?.remove("selected", "active");
    }
    clone.querySelectorAll("tool-tip, .Counter, [class*='Counter']").forEach((n) => n.remove());

    const link = clone.tagName === "A" ? clone : clone.querySelector("a");
    link.href = DASHBOARD;
    link.setAttribute("data-turbo", "false");
    link.setAttribute("aria-label", "All actions");
    link.setAttribute("title", "All actions");
    link.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      try {
        chrome.runtime.sendMessage({ type: "open-dashboard" });
      } catch {
        location.href = DASHBOARD; // extension was reloaded; fall back to a plain navigation
      }
    });

    const oldSvg = link.querySelector("svg");
    if (oldSvg) oldSvg.replaceWith(makeIcon(oldSvg));
    const hasLabel = relabel(link);

    const badge = document.createElement("span");
    badge.className = hasLabel ? "all-actions-count" : "all-actions-dot";
    badge.setAttribute("aria-hidden", "true");
    link.append(badge);
    link.classList.add("all-actions-link");

    return { unit, clone };
  }

  function inject() {
    for (const prLink of document.querySelectorAll(PR_LINK)) {
      if (prLink.closest(`[${MARK}]`) || !prLink.closest(SCOPES)) continue;
      const unit = prLink.parentElement?.tagName === "LI" ? prLink.parentElement : prLink;
      if (unit.previousElementSibling?.hasAttribute(MARK)) continue;
      const { clone } = buildEntry(prLink);
      unit.parentNode.insertBefore(clone, unit);
    }
    updateBadges();
  }

  function updateBadges() {
    for (const b of document.querySelectorAll(".all-actions-count, .all-actions-dot")) {
      b.hidden = !failedCount;
      if (b.classList.contains("all-actions-count")) b.textContent = failedCount ? String(failedCount) : "";
    }
    for (const a of document.querySelectorAll(".all-actions-link")) {
      const label = failedCount ? `All actions, ${failedCount} failed` : "All actions";
      a.setAttribute("aria-label", label);
      a.setAttribute("title", label);
    }
  }

  function setFromSnapshot(snapshot) {
    failedCount = snapshot?.entries ? snapshot.entries.filter((e) => e.state === "failed").length : 0;
    updateBadges();
  }

  chrome.storage.local.get("snapshot").then(({ snapshot }) => setFromSnapshot(snapshot));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.snapshot) setFromSnapshot(changes.snapshot.newValue);
  });

  // GitHub renders the header menu lazily and swaps pages without full reloads,
  // so watch for new Pull requests links and add ours next to them.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      inject();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  inject();
})();
