import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { firefoxEngine } from "../src/engines/firefox";

interface FakeContainer {
  cookieStoreId: string;
  name: string;
  color: string;
  icon: string;
}

function installFakeBrowser() {
  const containers: FakeContainer[] = [
    { cookieStoreId: "firefox-container-1", name: "Work", color: "blue", icon: "briefcase" },
  ];
  const createdTabs: Array<{
    id: number;
    url?: string;
    cookieStoreId?: string;
    active?: boolean;
    index?: number;
    windowId?: number;
    openerTabId?: number;
  }> = [];
  const existingTabs = new Map<number, any>();
  const listeners: Record<string, Function[]> = {};
  const event = (name: string) => ({
    addListener(cb: Function) {
      (listeners[name] ??= []).push(cb);
    },
  });
  const control = { failCreate: false, failRemove: false };
  const removedTabIds: number[] = [];
  let nextTabId = 100;
  let nextContainerId = 2;

  (globalThis as any).browser = {
    contextualIdentities: {
      async query() {
        return containers;
      },
      async get(cookieStoreId: string) {
        const found = containers.find((c) => c.cookieStoreId === cookieStoreId);
        if (!found) throw new Error("not found");
        return found;
      },
      async create(details: { name: string; color: string; icon: string }) {
        const c = { cookieStoreId: `firefox-container-${nextContainerId++}`, ...details };
        containers.push(c);
        return c;
      },
      async update(cookieStoreId: string, details: Partial<FakeContainer>) {
        const c = containers.find((c) => c.cookieStoreId === cookieStoreId);
        if (c) Object.assign(c, details);
        return c;
      },
      async remove(cookieStoreId: string) {
        const idx = containers.findIndex((c) => c.cookieStoreId === cookieStoreId);
        if (idx >= 0) containers.splice(idx, 1);
      },
      onCreated: { addListener() {} },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    tabs: {
      async create(props: any) {
        if (control.failCreate) throw new Error("create failed");
        const tab = { id: nextTabId++, ...props };
        createdTabs.push(tab);
        return tab;
      },
      async get(tabId: number) {
        const tab = existingTabs.get(tabId);
        if (!tab) throw new Error("no such tab");
        return tab;
      },
      remove(tabId: number) {
        removedTabIds.push(tabId);
        if (control.failRemove) return Promise.reject(new Error("remove failed"));
      },
      onCreated: event("tabs.onCreated"),
      onUpdated: event("tabs.onUpdated"),
      onRemoved: event("tabs.onRemoved"),
    },
    webRequest: {
      onBeforeRequest: event("onBeforeRequest"),
      onCompleted: event("onCompleted"),
      onErrorOccurred: event("onErrorOccurred"),
    },
  };

  return { containers, createdTabs, removedTabIds, existingTabs, listeners, control };
}

describe("firefoxEngine", () => {
  it("id is 'firefox'", () => {
    assert.equal(firefoxEngine.id, "firefox");
  });

  it("listDestinations maps contextualIdentities to Destination[]", async () => {
    installFakeBrowser();
    const destinations = await firefoxEngine.listDestinations();
    assert.deepEqual(destinations, [{ id: "firefox-container-1", name: "Work", color: "blue", icon: "briefcase" }]);
  });

  it("createDestination creates a new container", async () => {
    installFakeBrowser();
    const dest = await firefoxEngine.createDestination({ name: "Social", color: "pink", icon: "gift" });
    assert.equal(dest.name, "Social");
    assert.ok(dest.id.startsWith("firefox-container-"));
  });

  it("currentDestinationId returns the tab's cookieStoreId", async () => {
    installFakeBrowser();
    const id = await firefoxEngine.currentDestinationId({ id: 1, windowId: 1, index: 0, active: true, cookieStoreId: "firefox-container-1" });
    assert.equal(id, "firefox-container-1");
  });

  it("currentDestinationId returns empty string when there's no cookieStoreId", async () => {
    installFakeBrowser();
    const id = await firefoxEngine.currentDestinationId({ id: 1, windowId: 1, index: 0, active: true });
    assert.equal(id, "");
  });

  it("applyRoute opens the tab in the destination container and returns true", async () => {
    const fake = installFakeBrowser();
    const routed = await firefoxEngine.applyRoute(
      { id: 5, url: "https://github.com", windowId: 1, index: 0, active: true },
      "firefox-container-1",
    );
    assert.equal(routed, true);
    assert.equal(fake.createdTabs.length, 1);
    assert.equal(fake.createdTabs[0].cookieStoreId, "firefox-container-1");
    assert.equal(fake.createdTabs[0].url, "https://github.com");
  });

  it("applyRoute skips silently and returns false when the destination container no longer exists", async () => {
    const fake = installFakeBrowser();
    const routed = await firefoxEngine.applyRoute(
      { id: 5, url: "https://github.com", windowId: 1, index: 0, active: true },
      "does-not-exist",
    );
    assert.equal(routed, false);
    assert.equal(fake.createdTabs.length, 0);
    assert.deepEqual(fake.removedTabIds, []);
  });

  it("applyRoute returns false and keeps the tab when opening the new tab fails", async () => {
    const fake = installFakeBrowser();
    fake.control.failCreate = true;
    const routed = await firefoxEngine.applyRoute(
      { id: 5, url: "https://github.com", windowId: 1, index: 0, active: true },
      "firefox-container-1",
    );
    assert.equal(routed, false);
    assert.deepEqual(fake.removedTabIds, []);
  });
});

describe("firefoxEngine pre-request routing", () => {
  const WORK = "firefox-container-1";
  let nextId = 1000;

  function setup() {
    const fake = installFakeBrowser();
    const routedCount = { n: 0 };
    firefoxEngine.startPreRequestRouting!(
      async (url, current) => (url.startsWith("https://work.example") && current !== WORK ? WORK : null),
      () => routedCount.n++,
    );
    const onBeforeRequest = fake.listeners["onBeforeRequest"]![0]!;
    const fire = (name: string, ...args: unknown[]) => fake.listeners[name]!.forEach((cb) => cb(...args));
    const newTab = (tab: Record<string, unknown> = {}) => {
      const id = nextId++;
      const full = { id, url: "about:blank", index: 3, windowId: 1, active: true, cookieStoreId: "firefox-default", ...tab };
      fake.existingTabs.set(id, full);
      return full as any;
    };
    const request = (tabId: number, over: Record<string, unknown> = {}) =>
      onBeforeRequest({
        requestId: `req-${nextId++}`,
        url: "https://work.example/a",
        method: "GET",
        tabId,
        type: "main_frame",
        ...over,
      });
    return { fake, routedCount, fire, newTab, request, onBeforeRequest };
  }

  it("registers a blocking main_frame webRequest listener", () => {
    const fake = installFakeBrowser();
    let args: unknown[] = [];
    (globalThis as any).browser.webRequest.onBeforeRequest.addListener = (...a: unknown[]) => {
      args = a;
    };
    firefoxEngine.startPreRequestRouting!(async () => null, () => {});
    assert.deepEqual(args[1], { urls: ["<all_urls>"], types: ["main_frame"] });
    assert.deepEqual(args[2], ["blocking"]);
    assert.equal(fake.createdTabs.length, 0);
  });

  it("routes the first request: opens in the container and cancels it", async () => {
    const { fake, routedCount, newTab, request } = setup();
    const tab = newTab();
    const res = await request(tab.id);
    assert.deepEqual(res, { cancel: true });
    assert.equal(fake.createdTabs.length, 1);
    assert.equal(fake.createdTabs[0]!.cookieStoreId, WORK);
    assert.equal(fake.createdTabs[0]!.url, "https://work.example/a");
    assert.equal(routedCount.n, 1);
  });

  it("does not cancel when the tab is already in the right container", async () => {
    const { fake, newTab, request } = setup();
    const tab = newTab({ cookieStoreId: WORK });
    assert.deepEqual(await request(tab.id), {});
    assert.equal(fake.createdTabs.length, 0);
  });

  it("does not route when no rule matches", async () => {
    const { fake, newTab, request } = setup();
    const tab = newTab();
    assert.deepEqual(await request(tab.id, { url: "https://other.example/" }), {});
    assert.equal(fake.createdTabs.length, 0);
  });

  it("ignores redirect hops (same requestId) after the first request", async () => {
    const { fake, newTab, request } = setup();
    const tab = newTab();
    assert.deepEqual(await request(tab.id, { requestId: "chain-1", url: "https://other.example/" }), {});
    assert.deepEqual(await request(tab.id, { requestId: "chain-1", url: "https://work.example/sso" }), {});
    assert.equal(fake.createdTabs.length, 0);
  });

  it("routes a new chain once the previous request id was completed or failed", async () => {
    const { fake, fire, newTab, request } = setup();
    const tab = newTab();
    await request(tab.id, { requestId: "reuse-1", url: "https://other.example/" });
    fire("onCompleted", { requestId: "reuse-1" });
    assert.deepEqual(await request(tab.id, { requestId: "reuse-1" }), { cancel: true });
    fire("onErrorOccurred", { requestId: "reuse-1" });
    assert.deepEqual(await request(tab.id, { requestId: "reuse-1" }), { cancel: true });
    assert.equal(fake.createdTabs.length, 2);
  });

  it("ignores non-GET requests", async () => {
    const { fake, newTab, request } = setup();
    const tab = newTab();
    assert.deepEqual(await request(tab.id, { method: "POST" }), {});
    assert.equal(fake.createdTabs.length, 0);
  });

  it("ignores requests without a tab (tabId < 0)", async () => {
    const { fake, request } = setup();
    assert.deepEqual(await request(-1), {});
    assert.equal(fake.createdTabs.length, 0);
  });

  it("does not cancel when the target container does not exist", async () => {
    const { fake, routedCount, newTab, request } = setup();
    fake.containers.length = 0;
    const tab = newTab();
    assert.deepEqual(await request(tab.id), {});
    assert.equal(fake.createdTabs.length, 0);
    assert.deepEqual(fake.removedTabIds, []);
    assert.equal(routedCount.n, 0);
  });

  it("does not cancel when opening the new tab fails", async () => {
    const { fake, newTab, request } = setup();
    fake.control.failCreate = true;
    const tab = newTab();
    assert.deepEqual(await request(tab.id), {});
    assert.deepEqual(fake.removedTabIds, []);
  });

  it("closes the original tab when it is blank and gives the new tab its opener", async () => {
    const { fake, fire, newTab, request } = setup();
    const tab = newTab({ openerTabId: 42 });
    fire("tabs.onCreated", tab);
    assert.deepEqual(await request(tab.id), { cancel: true });
    assert.deepEqual(fake.removedTabIds, [tab.id]);
    assert.equal(fake.createdTabs[0]!.openerTabId, 42);
  });

  it("omits openerTabId when a closed blank tab had none", async () => {
    const { fake, fire, newTab, request } = setup();
    const tab = newTab();
    fire("tabs.onCreated", tab);
    await request(tab.id);
    assert.deepEqual(fake.removedTabIds, [tab.id]);
    assert.equal("openerTabId" in fake.createdTabs[0]!, false);
  });

  it("keeps a tab with history open and makes the new tab its child", async () => {
    const { fake, fire, newTab, request } = setup();
    const tab = newTab({ openerTabId: 42 });
    fire("tabs.onCreated", tab);
    fire("tabs.onUpdated", tab.id, { url: "https://example.com/" });
    assert.deepEqual(await request(tab.id), { cancel: true });
    assert.deepEqual(fake.removedTabIds, []);
    assert.equal(fake.createdTabs[0]!.openerTabId, tab.id);
  });

  it("keeps tabs it never saw being created (e.g. opened before the extension started)", async () => {
    const { fake, newTab, request } = setup();
    const tab = newTab({ url: "https://example.com/" });
    assert.deepEqual(await request(tab.id), { cancel: true });
    assert.deepEqual(fake.removedTabIds, []);
    assert.equal(fake.createdTabs[0]!.openerTabId, tab.id);
  });

  it("does not treat a tab created with a real URL as blank", async () => {
    const { fake, fire, newTab, request } = setup();
    const tab = newTab({ url: "https://example.com/" });
    fire("tabs.onCreated", tab);
    await request(tab.id);
    assert.deepEqual(fake.removedTabIds, []);
  });
});

// Shared harness for the routing suites below. Ids are globally unique because the
// engine keeps module-level state (blank tabs, seen request ids, reverting tabs).
describe("firefoxEngine routing (positive and negative)", () => {
  const WORK = "firefox-container-1";
  const WORK_URL = "https://work.example/a";
  let nextId = 20000;

  function harness(resolve?: (url: string, current: string) => Promise<string | null>) {
    const fake = installFakeBrowser();
    const routed = { n: 0 };
    firefoxEngine.startPreRequestRouting!(
      resolve ?? (async (url, current) => (url.startsWith("https://work.example") && current !== WORK ? WORK : null)),
      () => routed.n++,
    );
    const fire = (name: string, ...args: unknown[]) => fake.listeners[name]!.forEach((cb) => cb(...args));
    const newTab = (tab: Record<string, unknown> = {}) => {
      const id = nextId++;
      const full = { id, url: "https://example.com/", index: 3, windowId: 7, active: false, cookieStoreId: "firefox-default", ...tab };
      fake.existingTabs.set(id, full);
      return full as any;
    };
    const request = (tabId: number, over: Record<string, unknown> = {}) =>
      fake.listeners["onBeforeRequest"]![0]!({
        requestId: `req-${nextId++}`,
        url: WORK_URL,
        method: "GET",
        tabId,
        type: "main_frame",
        ...over,
      });
    return { fake, routed, fire, newTab, request };
  }

  /** Captures console.warn and asserts no logged argument leaks a URL. */
  function captureWarnings() {
    const spy = mock.method(console, "warn", () => {});
    return {
      get calls() {
        return spy.mock.calls;
      },
      assertNoUrls() {
        const text = spy.mock.calls.map((c) => c.arguments.map((a) => String(a)).join(" ")).join("\n");
        assert.doesNotMatch(text, /https?:\/\//);
        assert.doesNotMatch(text, /work\.example/);
      },
      restore: () => spy.mock.restore(),
    };
  }

  describe("A. pre-request routing", () => {
    it("positive: registers the blocking main_frame listener with the exact filter", () => {
      installFakeBrowser();
      const calls: unknown[][] = [];
      (globalThis as any).browser.webRequest.onBeforeRequest.addListener = (...a: unknown[]) => calls.push(a);
      firefoxEngine.startPreRequestRouting!(async () => null, () => {});
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]![1], { urls: ["<all_urls>"], types: ["main_frame"] });
      assert.deepEqual(calls[0]![2], ["blocking"]);
    });

    it("positive: first GET opens the tab with container, url, window, index+1, active; cancels; notifies", async () => {
      const { fake, routed, newTab, request } = harness();
      const tab = newTab({ active: true, index: 4, windowId: 9 });
      assert.deepEqual(await request(tab.id), { cancel: true });
      assert.equal(fake.createdTabs.length, 1);
      assert.deepEqual(
        { ...fake.createdTabs[0]!, id: undefined },
        { id: undefined, url: WORK_URL, cookieStoreId: WORK, active: true, index: 5, windowId: 9, openerTabId: tab.id },
      );
      assert.equal(routed.n, 1);
    });

    it("positive: a background tab stays a background tab (active: false)", async () => {
      const { fake, newTab, request } = harness();
      const tab = newTab({ active: false });
      await request(tab.id);
      assert.equal(fake.createdTabs[0]!.active, false);
    });

    it("positive: the resolver receives the request URL and the tab's current container", async () => {
      const seen: Array<[string, string]> = [];
      const { newTab, request } = harness(async (url, current) => {
        seen.push([url, current]);
        return null;
      });
      const tab = newTab({ cookieStoreId: "firefox-container-9" });
      await request(tab.id);
      assert.deepEqual(seen, [[WORK_URL, "firefox-container-9"]]);
    });

    it("negative: the resolver is not consulted for redirect hops", async () => {
      let calls = 0;
      const { newTab, request } = harness(async () => {
        calls++;
        return null;
      });
      const tab = newTab();
      await request(tab.id, { requestId: "hop-1" });
      await request(tab.id, { requestId: "hop-1" });
      await request(tab.id, { requestId: "hop-1" });
      assert.equal(calls, 1);
    });

    it("negative: a redirect hop is not routed even when the first request was not", async () => {
      const { fake, routed, newTab, request } = harness();
      const tab = newTab();
      await request(tab.id, { requestId: "hop-2", url: "https://idp.example/login" });
      assert.deepEqual(await request(tab.id, { requestId: "hop-2", url: WORK_URL }), {});
      assert.equal(fake.createdTabs.length, 0);
      assert.equal(routed.n, 0);
    });

    it("positive: a requestId is released by onCompleted, and by onErrorOccurred", async () => {
      const { fake, fire, newTab, request } = harness();
      const tab = newTab();
      assert.deepEqual(await request(tab.id, { requestId: "rel-1", url: "https://x.example/" }), {});
      assert.deepEqual(await request(tab.id, { requestId: "rel-1" }), {});
      fire("onCompleted", { requestId: "rel-1" });
      assert.deepEqual(await request(tab.id, { requestId: "rel-1" }), { cancel: true });
      fire("onErrorOccurred", { requestId: "rel-1" });
      assert.deepEqual(await request(tab.id, { requestId: "rel-1" }), { cancel: true });
      assert.equal(fake.createdTabs.length, 2);
    });

    it("positive: onCompleted/onErrorOccurred listeners use the same main_frame filter", () => {
      installFakeBrowser();
      const filters: unknown[] = [];
      const b = (globalThis as any).browser.webRequest;
      b.onCompleted.addListener = (_cb: unknown, f: unknown) => filters.push(f);
      b.onErrorOccurred.addListener = (_cb: unknown, f: unknown) => filters.push(f);
      firefoxEngine.startPreRequestRouting!(async () => null, () => {});
      assert.deepEqual(filters, [
        { urls: ["<all_urls>"], types: ["main_frame"] },
        { urls: ["<all_urls>"], types: ["main_frame"] },
      ]);
    });

    it("negative: the seen-id set is bounded at 1000 (oldest evicted) and never throws", async () => {
      const { fake, newTab, request } = harness();
      const tab = newTab();
      // tabId < 0 keeps these cheap, but their ids are still tracked.
      for (let i = 0; i <= 1000; i++) {
        assert.deepEqual(await request(-1, { requestId: `cap-${i}` }), {});
      }
      // cap-0 was evicted: it can be routed again; cap-1000 is still remembered.
      assert.deepEqual(await request(tab.id, { requestId: "cap-1000" }), {});
      assert.equal(fake.createdTabs.length, 0);
      assert.deepEqual(await request(tab.id, { requestId: "cap-0" }), { cancel: true });
      assert.equal(fake.createdTabs.length, 1);
    });

    it("negative: POST and HEAD (and other non-GET) are ignored", async () => {
      const { fake, newTab, request } = harness();
      const tab = newTab();
      for (const method of ["POST", "HEAD", "PUT", "OPTIONS", "get"]) {
        assert.deepEqual(await request(tab.id, { method }), {}, method);
      }
      assert.equal(fake.createdTabs.length, 0);
    });

    it("negative: tabId < 0 is ignored, without even looking up the tab", async () => {
      const { fake, routed, request } = harness();
      assert.deepEqual(await request(-1), {});
      assert.equal(fake.createdTabs.length, 0);
      assert.equal(routed.n, 0);
    });

    it("negative: tab already in the target container -> {} and nothing opened", async () => {
      const { fake, routed, newTab, request } = harness();
      const tab = newTab({ cookieStoreId: WORK });
      assert.deepEqual(await request(tab.id), {});
      assert.equal(fake.createdTabs.length, 0);
      assert.equal(routed.n, 0);
    });

    it("negative: resolver returns null -> {}", async () => {
      const { fake, newTab, request } = harness(async () => null);
      const tab = newTab();
      assert.deepEqual(await request(tab.id), {});
      assert.equal(fake.createdTabs.length, 0);
    });

    it("negative: container missing -> {} and tabs.create is never called", async () => {
      const w = captureWarnings();
      try {
        const { fake, routed, newTab, request } = harness();
        fake.containers.length = 0;
        const tab = newTab();
        assert.deepEqual(await request(tab.id), {});
        assert.equal(fake.createdTabs.length, 0);
        assert.equal(routed.n, 0);
        w.assertNoUrls();
      } finally {
        w.restore();
      }
    });

    it("negative: tabs.create rejects -> {} (not cancelled), no notification, nothing closed", async () => {
      const w = captureWarnings();
      try {
        const { fake, routed, fire, newTab, request } = harness();
        const tab = newTab();
        fire("tabs.onCreated", { ...tab, url: "about:blank" });
        fake.control.failCreate = true;
        assert.deepEqual(await request(tab.id), {});
        assert.equal(routed.n, 0);
        assert.deepEqual(fake.removedTabIds, []);
        w.assertNoUrls();
      } finally {
        w.restore();
      }
    });

    it("negative: tabs.get rejects -> {} and the warning does not contain the URL", async () => {
      const w = captureWarnings();
      try {
        const { fake, request } = harness();
        assert.deepEqual(await request(987654), {});
        assert.equal(fake.createdTabs.length, 0);
        assert.ok(w.calls.length >= 1);
        w.assertNoUrls();
      } finally {
        w.restore();
      }
    });

    it("negative: resolver throws -> {} and the warning does not contain the URL", async () => {
      const w = captureWarnings();
      try {
        const { fake, newTab, request } = harness(async () => {
          throw new Error("rules not ready");
        });
        const tab = newTab();
        assert.deepEqual(await request(tab.id), {});
        assert.equal(fake.createdTabs.length, 0);
        assert.ok(w.calls.length >= 1);
        w.assertNoUrls();
      } finally {
        w.restore();
      }
    });
  });

  describe("B. blank-tab tracking", () => {
    for (const url of ["about:blank", "about:newtab", "about:home", "", undefined]) {
      it(`positive: a tab created at ${JSON.stringify(url)} is closed after routing; opener is the old tab's opener`, async () => {
        const { fake, fire, newTab, request } = harness();
        const tab = newTab({ url, openerTabId: 77 });
        fire("tabs.onCreated", tab);
        assert.deepEqual(await request(tab.id), { cancel: true });
        assert.deepEqual(fake.removedTabIds, [tab.id]);
        assert.equal(fake.createdTabs[0]!.openerTabId, 77);
      });
    }

    it("positive: openerTabId is omitted (not undefined) when the closed blank tab had no opener", async () => {
      const { fake, fire, newTab, request } = harness();
      const tab = newTab({ url: "about:newtab" });
      fire("tabs.onCreated", tab);
      await request(tab.id);
      assert.equal(Object.prototype.hasOwnProperty.call(fake.createdTabs[0]!, "openerTabId"), false);
    });

    it("negative: a blank tab that loaded a real URL (onUpdated) is kept and becomes the opener", async () => {
      const { fake, fire, newTab, request } = harness();
      const tab = newTab({ url: "about:blank", openerTabId: 77 });
      fire("tabs.onCreated", tab);
      fire("tabs.onUpdated", tab.id, { url: "https://example.com/page" });
      assert.deepEqual(await request(tab.id), { cancel: true });
      assert.deepEqual(fake.removedTabIds, []);
      assert.equal(fake.createdTabs[0]!.openerTabId, tab.id);
    });

    it("positive: onUpdated to another blank URL or without a url keeps the tab blank", async () => {
      const { fake, fire, newTab, request } = harness();
      const tab = newTab({ url: "about:blank" });
      fire("tabs.onCreated", tab);
      fire("tabs.onUpdated", tab.id, { url: "about:newtab" });
      fire("tabs.onUpdated", tab.id, { status: "loading" });
      await request(tab.id);
      assert.deepEqual(fake.removedTabIds, [tab.id]);
    });

    it("negative: a tab never seen being created blank is kept, new tab opens as its child", async () => {
      const { fake, newTab, request } = harness();
      const tab = newTab({ url: "about:blank", openerTabId: 77 });
      assert.deepEqual(await request(tab.id), { cancel: true });
      assert.deepEqual(fake.removedTabIds, []);
      assert.equal(fake.createdTabs[0]!.openerTabId, tab.id);
    });

    it("negative: a tab created with a real URL is not blank", async () => {
      const { fake, fire, newTab, request } = harness();
      const tab = newTab({ url: "https://example.com/" });
      fire("tabs.onCreated", tab);
      await request(tab.id);
      assert.deepEqual(fake.removedTabIds, []);
    });

    it("negative: a tab without an id in onCreated is ignored without throwing", () => {
      const { fire } = harness();
      assert.doesNotThrow(() => fire("tabs.onCreated", { url: "about:blank", index: 0 }));
    });

    it("negative: a removed tab is forgotten (a recycled id is not treated as blank)", async () => {
      const { fake, fire, newTab, request } = harness();
      const tab = newTab({ url: "about:blank" });
      fire("tabs.onCreated", tab);
      fire("tabs.onRemoved", tab.id);
      await request(tab.id);
      assert.deepEqual(fake.removedTabIds, []);
    });

    it("positive: the new tab (created blank by us) is itself tracked as blank", async () => {
      const { fake, fire, newTab, request } = harness();
      const tab = newTab({ url: "about:blank" });
      fire("tabs.onCreated", tab);
      await request(tab.id);
      const created = fake.createdTabs[0]!;
      // the container tab shows up as blank first; once routed to another container it would be closable
      fire("tabs.onCreated", { id: created.id, url: "about:blank" });
      fire("tabs.onUpdated", created.id, { url: WORK_URL });
      fake.existingTabs.set(created.id, { ...created, index: 0, windowId: 7, cookieStoreId: WORK });
      assert.deepEqual(await request(created.id), {});
      assert.deepEqual(fake.removedTabIds, [tab.id]);
    });

    it("negative: tabs.remove failing neither throws nor changes the result", async () => {
      const w = captureWarnings();
      try {
        const { fake, routed, fire, newTab, request } = harness();
        const tab = newTab({ url: "about:blank" });
        fire("tabs.onCreated", tab);
        fake.control.failRemove = true;
        assert.deepEqual(await request(tab.id), { cancel: true });
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(fake.removedTabIds, [tab.id]);
        assert.equal(routed.n, 1);
        assert.ok(w.calls.length >= 1);
        w.assertNoUrls();
      } finally {
        w.restore();
      }
    });

    it("negative: the container-missing case never closes a blank tab", async () => {
      const w = captureWarnings();
      try {
        const { fake, fire, newTab, request } = harness();
        const tab = newTab({ url: "about:blank" });
        fire("tabs.onCreated", tab);
        fake.containers.length = 0;
        assert.deepEqual(await request(tab.id), {});
        assert.deepEqual(fake.removedTabIds, []);
      } finally {
        w.restore();
      }
    });
  });
});
