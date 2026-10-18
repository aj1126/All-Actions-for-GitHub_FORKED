// A fake `chrome` global with storage.local / storage.session (get, set, remove, setAccessLevel)
// and the two chrome.action calls storage.js makes. Every storage call is recorded in `calls`.

export function fakeChrome() {
  const calls = [];
  const area = (name) => ({
    data: {},
    accessLevel: null,
    failGets: false,
    async get(keys) {
      calls.push({ area: name, op: "get", keys });
      if (this.failGets) throw new Error(`Access to storage.${name} is not allowed from this context.`);
      const list = keys == null ? Object.keys(this.data) : [].concat(keys);
      return Object.fromEntries(list.filter((k) => k in this.data).map((k) => [k, structuredClone(this.data[k])]));
    },
    async set(items) {
      calls.push({ area: name, op: "set", keys: Object.keys(items) });
      for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
    },
    async remove(keys) {
      calls.push({ area: name, op: "remove", keys });
      for (const k of [].concat(keys)) delete this.data[k];
    },
    async setAccessLevel(options) {
      calls.push({ area: name, op: "setAccessLevel", options });
      this.accessLevel = options.accessLevel;
    },
  });
  const chrome = {
    storage: { local: area("local"), session: area("session") },
    action: { async setBadgeBackgroundColor() {}, async setBadgeText() {} },
  };
  return { chrome, calls };
}

/** Run `fn` with globalThis.chrome set to `chrome`, removing it afterwards. */
export async function withChrome(chrome, fn) {
  const had = "chrome" in globalThis;
  const old = globalThis.chrome;
  globalThis.chrome = chrome;
  try {
    return await fn();
  } finally {
    if (had) globalThis.chrome = old;
    else delete globalThis.chrome;
  }
}
