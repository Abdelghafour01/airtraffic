import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runBackground } from "../src/ui/background";
import type { Engine, PreRequestResolver } from "../src/core/engine";
import type { Rule, Settings } from "../src/core/types";

const RULES: Rule[] = [{ id: "r1", pattern: "github.com", matchType: "domain", destinationId: "dest-dev" }];
const SETTINGS: Settings = { mode: "route_matched", defaultDestinationId: "", useSync: false };

interface Timer {
  fn: () => void;
  ms: number;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let timers: Map<number, Timer>;

/** Replaces timers with a manual implementation so READY_TIMEOUT can be driven deterministically. */
function installTimers() {
  timers = new Map();
  let next = 1;
  (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
    const id = next++;
    timers.set(id, { fn, ms });
    return id;
  };
  (globalThis as any).clearTimeout = (id: number) => {
    timers.delete(id);
  };
}

function pendingTimers(ms: number): Timer[] {
  return [...timers.values()].filter((t) => t.ms === ms);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installBrowser(opts: { storageGet?: (key: string) => Promise<Record<string, unknown>> } = {}) {
  const calls = { onUpdated: [] as Function[], badge: [] as string[], storageChanged: [] as Function[] };
  const store: Record<string, unknown> = { settings: SETTINGS, rules: RULES };
  (globalThis as any).browser = {
    storage: {
      local: { get: opts.storageGet ?? (async (key: string) => ({ [key]: store[key] })), async set() {} },
      sync: { async get() { return {}; }, async set() {} },
      onChanged: { addListener: (cb: Function) => calls.storageChanged.push(cb) },
    },
    contextMenus: {
      async removeAll() {},
      create() {},
      onClicked: { addListener() {} },
    },
    action: {
      setBadgeText: (d: { text: string }) => calls.badge.push(d.text),
      setBadgeBackgroundColor() {},
    },
    tabs: { onUpdated: { addListener: (cb: Function) => calls.onUpdated.push(cb) } },
  };
  return calls;
}

function fakeEngine(withPreRequest: boolean) {
  const seen = {
    resolver: undefined as PreRequestResolver | undefined,
    onRouted: undefined as (() => void) | undefined,
    applyRoute: [] as Array<{ tab: any; destinationId: string }>,
    applyResult: true,
  };
  const engine: any = {
    id: "firefox",
    colors: {},
    async listDestinations() {
      return [];
    },
    async currentDestinationId(tab: { cookieStoreId?: string }) {
      return tab.cookieStoreId ?? "";
    },
    async applyRoute(tab: unknown, destinationId: string) {
      seen.applyRoute.push({ tab, destinationId });
      return seen.applyResult;
    },
    onDestinationsChanged() {},
  };
  if (withPreRequest) {
    engine.startPreRequestRouting = (resolver: PreRequestResolver, onRouted: () => void) => {
      seen.resolver = resolver;
      seen.onRouted = onRouted;
    };
  }
  return { engine: engine as Engine, seen };
}

const flush = () => new Promise<void>((r) => realSetTimeout(r, 0));

beforeEach(() => installTimers());
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

describe("runBackground wiring", () => {
  it("positive: engine WITH startPreRequestRouting gets a resolver and tabs.onUpdated is NOT registered", () => {
    const calls = installBrowser();
    const { engine, seen } = fakeEngine(true);
    runBackground(engine);
    assert.equal(typeof seen.resolver, "function");
    assert.equal(typeof seen.onRouted, "function");
    assert.equal(calls.onUpdated.length, 0);
  });

  it("positive: engine WITHOUT it (Chrome-like) registers tabs.onUpdated and never calls a resolver", () => {
    const calls = installBrowser();
    const { engine, seen } = fakeEngine(false);
    runBackground(engine);
    assert.equal(calls.onUpdated.length, 1);
    assert.equal(seen.resolver, undefined);
  });

  it("positive: Chrome-like path still routes via applyRoute and shows the badge", async () => {
    const calls = installBrowser();
    const { engine, seen } = fakeEngine(false);
    runBackground(engine);
    await calls.onUpdated[0]!(1, { url: "https://github.com/x" }, { id: 1, windowId: 2, index: 3, active: true, groupId: 9 });
    assert.equal(seen.applyRoute.length, 1);
    assert.equal(seen.applyRoute[0]!.destinationId, "dest-dev");
    assert.equal(seen.applyRoute[0]!.tab.url, "https://github.com/x");
    assert.equal(seen.applyRoute[0]!.tab.groupId, 9);
    assert.deepEqual(calls.badge, ["1"]);
  });

  it("negative: Chrome-like path ignores updates without a url, unmatched urls and failed routes", async () => {
    const calls = installBrowser();
    const { engine, seen } = fakeEngine(false);
    runBackground(engine);
    const tab = { id: 1, windowId: 2, index: 0, active: false };
    await calls.onUpdated[0]!(1, { status: "loading" }, tab);
    await calls.onUpdated[0]!(1, { url: "https://example.com" }, tab);
    assert.equal(seen.applyRoute.length, 0);
    seen.applyResult = false;
    await calls.onUpdated[0]!(1, { url: "https://github.com" }, tab);
    assert.equal(seen.applyRoute.length, 1);
    assert.deepEqual(calls.badge, []);
  });

  it("positive: onRouted bumps and shows an incrementing badge, cleared by a timer", () => {
    const calls = installBrowser();
    const { engine, seen } = fakeEngine(true);
    runBackground(engine);
    seen.onRouted!();
    seen.onRouted!();
    assert.deepEqual(calls.badge, ["1", "2"]);
    assert.equal(pendingTimers(3000).length, 2);
    pendingTimers(3000).forEach((t) => t.fn());
    assert.deepEqual(calls.badge, ["1", "2", "", ""]);
  });
});

describe("runBackground pre-request resolver", () => {
  function start(opts?: Parameters<typeof installBrowser>[0]) {
    installBrowser(opts);
    const { engine, seen } = fakeEngine(true);
    runBackground(engine);
    return seen.resolver!;
  }

  it("positive: returns the destination when rules are loaded and the route matches", async () => {
    const resolve = start();
    assert.equal(await resolve("https://github.com/foo", ""), "dest-dev");
    assert.equal(await resolve("https://gist.github.com/foo", "dest-other"), "dest-dev");
  });

  it("negative: returns null when no rule matches", async () => {
    const resolve = start();
    assert.equal(await resolve("https://example.com/", ""), null);
  });

  it("negative: returns null when the tab is already in the destination", async () => {
    const resolve = start();
    assert.equal(await resolve("https://github.com/foo", "dest-dev"), null);
  });

  it("negative: returns null for ignored protocols", async () => {
    const resolve = start();
    for (const url of ["about:blank", "about:newtab", "moz-extension://abc/popup.html", "chrome://settings", "data:text/html,x", "blob:https://github.com/x", ""]) {
      assert.equal(await resolve(url, ""), null, url);
    }
  });

  it("positive: the READY timer is cleared when the rules gate wins", async () => {
    const resolve = start();
    assert.equal(await resolve("https://github.com/foo", ""), "dest-dev");
    assert.equal(pendingTimers(2000).length, 0);
  });

  it("negative: if rules never load, the resolver returns null after ~2s (request lets through)", async () => {
    const resolve = start({ storageGet: () => new Promise(() => {}) });
    const pending = resolve("https://github.com/foo", "");
    const t = pendingTimers(2000);
    assert.equal(t.length, 1);
    t[0]!.fn();
    assert.equal(await pending, null);
  });

  it("positive: after a timeout, a later call succeeds once the rules finally load", async () => {
    const gate = deferred<void>();
    const store: Record<string, unknown> = { settings: SETTINGS, rules: RULES };
    const resolve = start({
      storageGet: async (key) => {
        await gate.promise;
        return { [key]: store[key] };
      },
    });
    const first = resolve("https://github.com/foo", "");
    pendingTimers(2000)[0]!.fn();
    assert.equal(await first, null);
    gate.resolve();
    await flush();
    assert.equal(await resolve("https://github.com/foo", ""), "dest-dev");
  });

  it("negative: if loading the rules fails, the resolver rejects", async () => {
    const gate = deferred<Record<string, unknown>>();
    const resolve = start({ storageGet: () => gate.promise });
    const pending = resolve("https://github.com/foo", "");
    gate.reject(new Error("storage unavailable"));
    await assert.rejects(pending, /storage unavailable/);
    assert.equal(pendingTimers(2000).length, 0);
  });
});
