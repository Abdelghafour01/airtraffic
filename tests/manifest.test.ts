import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function permissions(target: "firefox" | "chrome"): string[] {
  const manifest = JSON.parse(readFileSync(new URL(`../manifests/${target}.json`, import.meta.url), "utf-8"));
  return manifest.permissions;
}

const FIREFOX_ONLY = ["webRequest", "webRequestBlocking"];

describe("manifest permissions", () => {
  it("positive: firefox requests webRequest and webRequestBlocking", () => {
    const p = permissions("firefox");
    for (const perm of FIREFOX_ONLY) assert.ok(p.includes(perm), perm);
  });

  it("positive: firefox keeps its existing permissions", () => {
    const p = permissions("firefox");
    for (const perm of ["contextualIdentities", "cookies", "tabs", "contextMenus", "storage"]) {
      assert.ok(p.includes(perm), perm);
    }
  });

  it("negative: chrome requests none of the Firefox-only permissions", () => {
    const p = permissions("chrome");
    for (const perm of FIREFOX_ONLY) assert.ok(!p.includes(perm), perm);
  });

  it("negative: no permission is listed twice", () => {
    for (const target of ["firefox", "chrome"] as const) {
      const p = permissions(target);
      assert.equal(new Set(p).size, p.length, target);
    }
  });
});
