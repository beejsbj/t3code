import { describe, expect, it } from "vite-plus/test";

import {
  resolveBoardComposerSubmission,
  useThreadComposerRouteState,
} from "./useThreadComposer.ts";

describe("useThreadComposerRouteState", () => {
  it("exports pending state derivation for a thread", () => {
    expect(typeof useThreadComposerRouteState).toBe("function");
  });
});

describe("resolveBoardComposerSubmission", () => {
  it("allows the shell-backed composer to send before thread detail loads", () => {
    expect(
      resolveBoardComposerSubmission({
        sessionStatus: "ready",
        prompt: "  follow up  ",
        imageCount: 0,
      }),
    ).toEqual({ text: "follow up" });
  });

  it("rejects an empty draft", () => {
    expect(
      resolveBoardComposerSubmission({
        sessionStatus: "ready",
        prompt: "  ",
        imageCount: 0,
      }),
    ).toBeNull();
  });

  it.each(["starting", "running"] as const)("rejects a draft while the shell is %s", (status) => {
    expect(
      resolveBoardComposerSubmission({
        sessionStatus: status,
        prompt: "follow up",
        imageCount: 0,
      }),
    ).toBeNull();
  });
});
