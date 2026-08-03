import { describe, expect, it } from "vite-plus/test";

import { useThreadComposerRouteState } from "./useThreadComposer.ts";

describe("useThreadComposerRouteState", () => {
  it("exports pending state derivation for a thread", () => {
    expect(typeof useThreadComposerRouteState).toBe("function");
  });
});
