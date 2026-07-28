import { describe, expect, it, vi } from "vite-plus/test";

import { loadClerkRuntime } from "./clerkRuntime";

describe("loadClerkRuntime", () => {
  it("does not evaluate Electron-only modules in a browser", async () => {
    const loadBrowser = vi.fn(async () => ({ provider: "browser" }));
    const loadElectron = vi.fn(async () => ({ provider: "electron" }));
    const loadPasskeys = vi.fn(async () => ({ passkeys: "passkeys" }));

    await expect(
      loadClerkRuntime(false, { loadBrowser, loadElectron, loadPasskeys }),
    ).resolves.toEqual({ provider: "browser" });
    expect(loadBrowser).toHaveBeenCalledOnce();
    expect(loadElectron).not.toHaveBeenCalled();
    expect(loadPasskeys).not.toHaveBeenCalled();
  });
});
