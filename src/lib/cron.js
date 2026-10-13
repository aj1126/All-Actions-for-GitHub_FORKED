// Cron helpers for GitHub Actions schedules. GitHub evaluates `on.schedule` crons in UTC
// using standard five-field POSIX syntax: minute hour day-of-month month day-of-week.

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS, offset: 1 },
  { min: 0, max: 7, names: DAYS, offset: 0 },
];

function value(token, field) {
  const upper = token.toUpperCase();
  if (field.names?.includes(upper)) return field.names.indexOf(upper) + field.offset;
  if (!/^\d+$/.test(token)) throw new Error(`Bad cron value "${token}"`);
  return Number(token);
}

function parseField(text, field, isDow) {
  const set = new Set();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad cron step "${part}"`);
    let lo;
    let hi;
    if (range === "*") {
      lo = field.min;
      hi = field.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = value(a, field);
      hi = value(b, field);
    } else {
      lo = value(range, field);
      hi = stepText === undefined ? lo : field.max;
    }
    if (isDow && hi === 7) {
      // 7 is also Sunday
      set.add(0);
      hi = 6;
      if (lo === 7) continue;
    }
    if (lo < field.min || hi > field.max || lo > hi) throw new Error(`Cron value out of range "${part}"`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

/** Parse a five-field cron string. Throws on anything it doesn't understand. */
export function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron needs 5 fields: "${expr}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i], i === 4));
  return {
    minute: [...minute].sort((a, b) => b - a), // descending for the backwards search
    hour: [...hour].sort((a, b) => b - a),
    dom,
    month,
    dow,
    domAny: parts[2] === "*",
    dowAny: parts[4] === "*",
  };
}

function dayMatches(c, d) {
  if (!c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either one matching is enough.
  if (!c.domAny && !c.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * The most recent time at or before `before` that the cron fires, or null if it hasn't
 * fired in the past `maxDays` days.
 */
export function previousFire(cron, before, maxDays = 400) {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  const start = new Date(before);
  start.setUTCSeconds(0, 0);
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let i = 0; i <= maxDays; i++) {
    if (dayMatches(c, day)) {
      for (const h of c.hour) {
        for (const m of c.minute) {
          const t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
          if (t <= start.getTime()) return new Date(t);
        }
      }
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return null;
}

/** Pull the cron strings out of a workflow file's YAML. */
export function extractCrons(yaml) {
  const crons = [];
  const re = /^\s*-?\s*cron\s*:\s*(['"]?)([^'"#\n]+?)\1\s*(?:#.*)?$/gm;
  for (const m of yaml.matchAll(re)) crons.push(m[2].trim());
  return crons;
}

const pad = (n) => String(n).padStart(2, "0");

const PLURAL_DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/**
 * Where a UTC hour:minute lands in `timeZone` (the viewer's own when undefined), using the
 * most recent such moment so daylight saving time is right for today.
 * Returns the local "HH:MM" and how many days it shifts (-1, 0 or 1).
 */
function toLocal(h, m, now, timeZone) {
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m);
  if (t > now.getTime()) t -= 86400000;
  const d = new Date(t);
  const time = d.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = (zone) => Date.parse(d.toLocaleDateString("en-CA", { timeZone: zone }));
  return { time, shift: Math.round((day(timeZone) - day("UTC")) / 86400000) };
}

/**
 * Plain-English summary of common schedules in the viewer's time zone, with the UTC time
 * GitHub uses alongside, e.g. "Daily at 04:05 (08:05 UTC)". Viewers in UTC just see
 * "Daily at 08:05 UTC". A weekday or day-of-month schedule that falls on a different day
 * locally stays in UTC rather than get confusing.
 */
export function describeCron(expr, { now = new Date(), timeZone } = {}) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `cron “${expr}”`;
  const [m, h, dom, mon, dow] = parts;
  const num = (x) => /^\d+$/.test(x);
  const any = (x) => x === "*";
  if (num(m) && any(h) && any(dom) && any(mon) && any(dow)) return `Hourly at :${pad(m)}`;
  if (!num(m) || !num(h) || !any(mon)) return `cron “${expr}”`;

  const utc = `${pad(h)}:${pad(m)}`;
  const local = toLocal(Number(h), Number(m), now, timeZone);
  const inUtc = local.time === utc && local.shift === 0;
  const at = inUtc ? `${utc} UTC` : `${local.time} (${utc} UTC)`;
  const atUtc = `${utc} UTC`;

  if (any(dom)) {
    if (any(dow)) return `Daily at ${at}`;
    const weekdays = dow === "1-5" || dow.toUpperCase() === "MON-FRI";
    if (weekdays) return `Weekdays at ${local.shift ? atUtc : at}`;
    if (num(dow)) {
      const utcDay = Number(dow) % 7;
      if (!local.shift) return `${PLURAL_DAYS[utcDay]} at ${at}`;
      return `${PLURAL_DAYS[(utcDay + local.shift + 7) % 7]} at ${local.time} (${PLURAL_DAYS[utcDay]} ${atUtc})`;
    }
  } else if (num(dom) && any(dow)) {
    return `Monthly on day ${dom} at ${local.shift ? atUtc : at}`;
  }
  return `cron “${expr}”`;
}
