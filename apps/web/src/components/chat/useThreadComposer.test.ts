import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  resolveBoardComposerModelSelection,
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

describe("resolveBoardComposerModelSelection", () => {
  const fallback = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("uses the active provider's draft selection", () => {
    const selected = {
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-5",
    };
    expect(
      resolveBoardComposerModelSelection(
        {
          activeProvider: selected.instanceId,
          modelSelectionByProvider: { [selected.instanceId]: selected },
        },
        fallback,
      ),
    ).toEqual(selected);
  });

  it("falls back to the thread selection when the draft has no active model", () => {
    expect(
      resolveBoardComposerModelSelection(
        { activeProvider: null, modelSelectionByProvider: {} },
        fallback,
      ),
    ).toEqual(fallback);
  });
});
