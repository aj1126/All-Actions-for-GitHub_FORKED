// Runs before GitHub's page renders so the normal page content is hidden straight away
// on https://github.com/?all-actions, instead of flashing before the list appears.
if (location.pathname === "/" && new URLSearchParams(location.search).has("all-actions")) {
  document.documentElement.setAttribute("data-all-actions-view", "");
}
