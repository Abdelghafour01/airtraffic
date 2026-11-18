import type { Engine, EngineTab, PreRequestResolver } from "../../core/engine";
import type { NewDestination } from "../../core/types";
import { CONTAINER_COLORS, CONTAINER_ICONS } from "./colors";

const MAX_TRACKED_REQUESTS = 1000;
// Tabs that have never loaded a real page (new tab, window.open, ...): safe to close when routed.
const blankTabs = new Set<number>();
// Request ids of main_frame navigations already seen. Firefox keeps the id across a redirect chain.
const seenRequests = new Set<string>();

function isBlankUrl(url: string | undefined): boolean {
  return !url || url === "about:blank" || url === "about:newtab" || url === "about:home";
}

async function containerExists(cookieStoreId: string): Promise<boolean> {
  try {
    await browser.contextualIdentities.get(cookieStoreId);
    return true;
  } catch {
    return false;
  }
}

async function listDestinations() {
  const containers = await browser.contextualIdentities.query({});
  return containers.map((c) => ({ id: c.cookieStoreId, name: c.name, color: c.color, icon: c.icon }));
}

async function createDestination(input: NewDestination) {
  const c = await browser.contextualIdentities.create({
    name: input.name,
    color: input.color,
    icon: input.icon || "circle",
  });
  return { id: c.cookieStoreId, name: c.name, color: c.color, icon: c.icon };
}

async function updateDestination(id: string, patch: Partial<NewDestination>): Promise<void> {
  await browser.contextualIdentities.update(id, patch);
}

async function deleteDestination(id: string): Promise<void> {
  await browser.contextualIdentities.remove(id);
}

async function currentDestinationId(tab: EngineTab): Promise<string> {
  return tab.cookieStoreId ?? "";
}

/**
 * Opens `tab.url` in the destination container. Called before the request is
 * sent, so the caller cancels the original request when this returns true.
 * The original tab is closed only when it never loaded a page; otherwise it
 * stays on its previous page (Back keeps working) and the new tab becomes its child.
 */
async function applyRoute(tab: EngineTab, destinationId: string): Promise<boolean> {
  const exists = await containerExists(destinationId);
  if (!exists) {
    console.warn(`[Air Traffic] Container ${destinationId} not found, skipping redirect`);
    return false;
  }

  const closeOld = blankTabs.has(tab.id);
  const openerTabId = closeOld ? tab.openerTabId : tab.id;

  try {
    await browser.tabs.create({
      url: tab.url,
      cookieStoreId: destinationId,
      active: tab.active,
      index: tab.index + 1,
      windowId: tab.windowId,
      ...(openerTabId !== undefined ? { openerTabId } : {}),
    });
  } catch (err) {
    console.warn(`[Air Traffic] Failed to reopen tab ${tab.id} in ${destinationId}`, err);
    return false;
  }

  if (closeOld) {
    Promise.resolve(browser.tabs.remove(tab.id)).catch((err) => {
      console.warn(`[Air Traffic] Failed to close original tab ${tab.id}`, err);
    });
  }
  return true;
}

function startPreRequestRouting(resolve: PreRequestResolver, onRouted: () => void): void {
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id != null && isBlankUrl(tab.url)) blankTabs.add(tab.id);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url && !isBlankUrl(changeInfo.url)) blankTabs.delete(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    blankTabs.delete(tabId);
  });

  const forget = (details: browser.webRequest.RequestDetails) => {
    seenRequests.delete(details.requestId);
  };
  const filter = { urls: ["<all_urls>"], types: ["main_frame"] };
  browser.webRequest.onCompleted.addListener(forget, filter);
  browser.webRequest.onErrorOccurred.addListener(forget, filter);

  browser.webRequest.onBeforeRequest.addListener(
    async (details) => {
      // Only the first request of a redirect chain may be routed.
      if (seenRequests.has(details.requestId)) return {};
      seenRequests.add(details.requestId);
      if (seenRequests.size > MAX_TRACKED_REQUESTS) {
        seenRequests.delete(seenRequests.values().next().value as string);
      }

      if (details.tabId < 0 || details.method !== "GET") return {};

      try {
        const tab = await browser.tabs.get(details.tabId);
        const current = await currentDestinationId({
          id: details.tabId,
          windowId: tab.windowId ?? -1,
          index: tab.index,
          active: tab.active ?? false,
          cookieStoreId: tab.cookieStoreId,
        });
        const destinationId = await resolve(details.url, current);
        if (!destinationId) return {};

        const routed = await applyRoute(
          {
            id: details.tabId,
            url: details.url,
            windowId: tab.windowId ?? -1,
            index: tab.index,
            active: tab.active ?? false,
            cookieStoreId: tab.cookieStoreId,
            openerTabId: tab.openerTabId,
          },
          destinationId,
        );
        if (!routed) return {};
        onRouted();
        return { cancel: true };
      } catch (err) {
        console.warn(`[Air Traffic] Failed to route request in tab ${details.tabId}`, err);
        return {};
      }
    },
    filter,
    ["blocking"],
  );
}

async function openInDestination(url: string, destinationId: string, refTab: EngineTab): Promise<void> {
  const exists = await containerExists(destinationId);
  if (!exists) return;
  await browser.tabs.create({
    url,
    cookieStoreId: destinationId,
    active: true,
    index: refTab.index + 1,
    windowId: refTab.windowId,
  });
}

function onDestinationsChanged(cb: () => void): void {
  browser.contextualIdentities.onCreated.addListener(cb);
  browser.contextualIdentities.onRemoved.addListener(cb);
  browser.contextualIdentities.onUpdated.addListener(cb);
}

export const firefoxEngine: Engine = {
  id: "firefox",
  colors: CONTAINER_COLORS,
  icons: CONTAINER_ICONS,
  listDestinations,
  createDestination,
  updateDestination,
  deleteDestination,
  currentDestinationId,
  applyRoute,
  startPreRequestRouting,
  openInDestination,
  onDestinationsChanged,
};
