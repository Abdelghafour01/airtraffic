// Minimal cross-browser WebExtension API type declarations
// (MV3: Firefox native `browser`, Chrome via webextension-polyfill)

interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

interface ContextualIdentity {
  cookieStoreId: string;
  name: string;
  color: string;
  icon: string;
}

interface Tab {
  id?: number;
  url?: string;
  cookieStoreId?: string;
  groupId?: number;
  active?: boolean;
  index: number;
  windowId?: number;
  openerTabId?: number;
}

interface TabChangeInfo {
  url?: string;
  status?: string;
}

interface MenuClickInfo {
  menuItemId: string;
  linkUrl?: string;
}

interface TabGroup {
  id: number;
  title: string;
  color: string;
  windowId: number;
}

interface BrowserEvent<T extends (...args: never[]) => void> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
}

declare namespace browser {
  namespace storage {
    const local: StorageArea;
    const sync: StorageArea;
    const onChanged: BrowserEvent<(changes: Record<string, StorageChange>, area: string) => void>;
  }

  namespace contextualIdentities {
    function query(filter: Record<string, unknown>): Promise<ContextualIdentity[]>;
    function get(cookieStoreId: string): Promise<ContextualIdentity>;
    function create(details: { name: string; color: string; icon: string }): Promise<ContextualIdentity>;
    function update(cookieStoreId: string, details: { name?: string; color?: string; icon?: string }): Promise<ContextualIdentity>;
    function remove(cookieStoreId: string): Promise<ContextualIdentity>;
    const onCreated: BrowserEvent<() => void>;
    const onRemoved: BrowserEvent<() => void>;
    const onUpdated: BrowserEvent<() => void>;
  }

  namespace tabGroups {
    const TAB_GROUP_ID_NONE: number;
    function query(filter: { windowId?: number; title?: string }): Promise<TabGroup[]>;
    function get(groupId: number): Promise<TabGroup>;
    function update(groupId: number, details: { title?: string; color?: string }): Promise<TabGroup>;
  }

  namespace tabs {
    function create(props: {
      url?: string;
      cookieStoreId?: string;
      active?: boolean;
      index?: number;
      windowId?: number;
      openerTabId?: number;
    }): Promise<Tab>;
    function get(tabId: number): Promise<Tab>;
    function remove(tabId: number): Promise<void>;
    function goBack(tabId: number): Promise<void>;
    function group(props: { tabIds: number[]; groupId?: number }): Promise<number>;
    const onUpdated: BrowserEvent<(tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void>;
    const onCreated: BrowserEvent<(tab: Tab) => void>;
    const onRemoved: BrowserEvent<(tabId: number) => void>;
  }

  // Firefox only
  namespace webRequest {
    interface RequestDetails {
      requestId: string;
      url: string;
      method: string;
      tabId: number;
      type: string;
    }
    interface BlockingResponse {
      cancel?: boolean;
    }
    interface RequestFilter {
      urls: string[];
      types?: string[];
    }
    interface RequestEvent<T extends (details: RequestDetails) => unknown> {
      addListener(callback: T, filter: RequestFilter, extraInfoSpec?: string[]): void;
      removeListener(callback: T): void;
    }
    const onBeforeRequest: RequestEvent<(details: RequestDetails) => Promise<BlockingResponse> | BlockingResponse>;
    const onCompleted: RequestEvent<(details: RequestDetails) => void>;
    const onErrorOccurred: RequestEvent<(details: RequestDetails) => void>;
  }

  // Firefox only
  namespace webNavigation {
    interface HistoryStateDetails {
      tabId: number;
      frameId: number;
      url: string;
    }
    const onHistoryStateUpdated: BrowserEvent<(details: HistoryStateDetails) => void>;
  }

  namespace contextMenus {
    function create(props: { id: string; title: string; contexts: string[] }): void;
    function removeAll(): Promise<void>;
    const onClicked: BrowserEvent<(info: MenuClickInfo, tab?: Tab) => void>;
  }

  namespace action {
    function setBadgeText(details: { text: string }): void;
    function setBadgeBackgroundColor(details: { color: string }): void;
  }

  namespace runtime {
    function openOptionsPage(): Promise<void>;
  }
}

declare module "webextension-polyfill" {
  const browserPolyfill: typeof browser;
  export default browserPolyfill;
}
