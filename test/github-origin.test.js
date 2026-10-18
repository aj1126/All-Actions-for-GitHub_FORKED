// AJ's version (docs/specs/aj-version.md), R1: the token is only ever sent to https://api.github.com.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as gh from "../src/lib/github.js";
import { withFetch } from "../test-support/fake-github.js";

/** /user/repos answers page 1 with one repo and a Link to `nextUrl`, any later page with another repo. */
function linkFake(nextUrl) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ origin: new URL(url).origin, auth: init.headers?.Authorization ?? null });
    const first = calls.length === 1;
    const body = [{ full_name: first ? "me/one" : "me/two", name: first ? "one" : "two", html_url: "", private: false, archived: false }];
    const headers = first ? { link: `<${nextUrl}>; rel="next"` } : {};
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  return { fetch, calls };
}

const isOriginError = (re) => (e) => typeof gh.OriginError === "function" && e instanceof gh.OriginError && re.test(e.message);

test("An off-origin next link is refused and gets no request (R1)", async () => {
  const fake = linkFake("https://attacker.example/collect");
  await assert.rejects(
    withFetch(fake.fetch, () => gh.listRepos("TOKEN")),
    isOriginError(/^Refused to send the token to https:\/\/attacker\.example: only https:\/\/api\.github\.com is allowed\.$/),
  );
  assert.deepEqual(fake.calls.map((c) => c.origin), ["https://api.github.com"]);
});

test("Plain http on the API host is refused too (R1)", async () => {
  const fake = linkFake("http://api.github.com/user/repos?page=2");
  await assert.rejects(
    withFetch(fake.fetch, () => gh.listRepos("TOKEN")),
    isOriginError(/^Refused to send the token to http:\/\/api\.github\.com: /),
  );
  assert.equal(fake.calls.length, 1);
});

test("Control: a next link on api.github.com is followed with the token", async () => {
  const fake = linkFake("https://api.github.com/user/repos?page=2");
  const repos = await withFetch(fake.fetch, () => gh.listRepos("TOKEN"));
  assert.deepEqual(repos.map((r) => r.full_name), ["me/one", "me/two"]);
  assert.deepEqual(fake.calls.map((c) => c.auth), ["Bearer TOKEN", "Bearer TOKEN"]);
});
