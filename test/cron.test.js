import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, previousFire, extractCrons, describeCron } from "../src/lib/cron.js";

const at = (iso) => new Date(iso);
const prev = (cron, iso) => previousFire(cron, at(iso))?.toISOString();

test("previousFire handles daily, hourly and stepped schedules", () => {
  assert.equal(prev("0 5 * * *", "2026-10-13T12:00:00Z"), "2026-10-13T05:00:00.000Z");
  assert.equal(prev("0 5 * * *", "2026-10-13T04:59:00Z"), "2026-10-12T05:00:00.000Z");
  assert.equal(prev("30 * * * *", "2026-10-13T12:10:00Z"), "2026-10-13T11:30:00.000Z");
  assert.equal(prev("*/15 * * * *", "2026-10-13T12:44:00Z"), "2026-10-13T12:30:00.000Z");
  assert.equal(prev("0 0 1 * *", "2026-10-13T12:00:00Z"), "2026-10-01T00:00:00.000Z");
});

test("previousFire handles days of the week, names and Sunday as 7", () => {
  // 2026-10-13 is a Tuesday.
  assert.equal(prev("0 9 * * 1-5", "2026-10-13T08:00:00Z"), "2026-10-12T09:00:00.000Z");
  assert.equal(prev("0 9 * * 1-5", "2026-10-11T12:00:00Z"), "2026-10-09T09:00:00.000Z");
  assert.equal(prev("0 9 * * MON", "2026-10-13T12:00:00Z"), "2026-10-12T09:00:00.000Z");
  assert.equal(prev("0 9 * * 7", "2026-10-13T12:00:00Z"), "2026-10-11T09:00:00.000Z");
  assert.equal(prev("0 9 * * 0", "2026-10-13T12:00:00Z"), "2026-10-11T09:00:00.000Z");
  assert.equal(prev("0 0 1 JAN *", "2026-10-13T12:00:00Z"), "2026-01-01T00:00:00.000Z");
});

test("when both day fields are set, either one matches", () => {
  // the 13th, or any Friday
  assert.equal(prev("0 0 13 * 5", "2026-10-12T12:00:00Z"), "2026-10-09T00:00:00.000Z");
  assert.equal(prev("0 0 13 * 5", "2026-10-13T12:00:00Z"), "2026-10-13T00:00:00.000Z");
});

test("parseCron rejects bad input", () => {
  assert.throws(() => parseCron("0 5 * *"));
  assert.throws(() => parseCron("61 5 * * *"));
  assert.throws(() => parseCron("x 5 * * *"));
});

test("extractCrons reads quoted, unquoted and commented lines", () => {
  const yaml = `
on:
  schedule:
    - cron: '0 5 * * *'
    - cron: "30 6 * * 1-5"  # weekdays
    -   cron:  15 * * * *
  workflow_dispatch:
`;
  assert.deepEqual(extractCrons(yaml), ["0 5 * * *", "30 6 * * 1-5", "15 * * * *"]);
});

test("describeCron in UTC", () => {
  const utc = { timeZone: "UTC" };
  assert.equal(describeCron("0 5 * * *", utc), "Daily at 05:00 UTC");
  assert.equal(describeCron("30 6 * * 1-5", utc), "Weekdays at 06:30 UTC");
  assert.equal(describeCron("0 9 * * 1", utc), "Mondays at 09:00 UTC");
  assert.equal(describeCron("15 * * * *", utc), "Hourly at :15");
  assert.equal(describeCron("0 0 1 * *", utc), "Monthly on day 1 at 00:00 UTC");
  assert.equal(describeCron("*/10 * * * *", utc), "cron “*/10 * * * *”");
});

test("describeCron in the viewer's time zone", () => {
  const ny = { timeZone: "America/New_York", now: new Date("2026-10-13T15:00:00Z") }; // EDT, UTC-4
  assert.equal(describeCron("5 8 * * *", ny), "Daily at 04:05 (08:05 UTC)");
  assert.equal(describeCron("30 6 * * 1-5", ny), "Weekdays at 02:30 (06:30 UTC)");
  assert.equal(describeCron("0 2 * * 1", ny), "Sundays at 22:00 (Mondays 02:00 UTC)");
  assert.equal(describeCron("0 2 * * 1-5", ny), "Weekdays at 02:00 UTC");
  assert.equal(describeCron("0 12 1 * *", ny), "Monthly on day 1 at 08:00 (12:00 UTC)");
  const winter = { timeZone: "America/New_York", now: new Date("2026-12-01T15:00:00Z") }; // EST, UTC-5
  assert.equal(describeCron("5 8 * * *", winter), "Daily at 03:05 (08:05 UTC)");
  const tokyo = { timeZone: "Asia/Tokyo", now: new Date("2026-10-13T15:00:00Z") };
  assert.equal(describeCron("0 20 * * 5", tokyo), "Saturdays at 05:00 (Fridays 20:00 UTC)");
});
