import type { Destination, NewDestination } from "./types";

export interface EngineTab {
  id: number;
  url?: string;
  windowId: number;
  index: number;
  active: boolean;
  cookieStoreId?: string; // Firefox only
  groupId?: number; // Chrome only
  openerTabId?: number; // Firefox only
}

/** Returns the destination `url` must be routed to, or null to leave it alone. */
export type PreRequestResolver = (url: string, currentDestinationId: string) => Promise<string | null>;

export interface Engine {
  readonly id: "firefox" | "chrome";
  /** Destination colour names this engine accepts, mapped to a preview swatch. */
  readonly colors: Record<string, string>;
  /** Destination icon names mapped to their glyph. Absent when the engine has no icons. */
  readonly icons?: Record<string, string>;
  listDestinations(): Promise<Destination[]>;
  createDestination(input: NewDestination): Promise<Destination>;
  updateDestination(id: string, patch: Partial<NewDestination>): Promise<void>;
  deleteDestination(id: string): Promise<void>;
  currentDestinationId(tab: EngineTab): Promise<string>;
  /**
   * Routes `tab` to `destinationId`. Returns true when the tab was routed,
   * false when it was not (missing destination, browser call failed, ...).
   * Never rejects: callers treat a false as "left where it was".
   */
  applyRoute(tab: EngineTab, destinationId: string): Promise<boolean>;
  /**
   * Optional. Engines that can route before a navigation request is sent
   * (Firefox, via blocking webRequest) implement this; the background then
   * uses it instead of reacting to `tabs.onUpdated` + `applyRoute`.
   * `resolve` decides the destination, `onRouted` is called after each route.
   */
  startPreRequestRouting?(resolve: PreRequestResolver, onRouted: () => void): void;
  openInDestination(url: string, destinationId: string, refTab: EngineTab): Promise<void>;
  onDestinationsChanged(cb: () => void): void;
}
