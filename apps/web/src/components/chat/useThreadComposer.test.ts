import { describe, expect, it } from "vite-plus/test";

import {
  boardComposerDraftCanBeRestored,
  resolveBoardComposerSubmission,
} from "./useThreadComposer";

describe("board thread composer", () => {
  it("keeps blank board submissions from starting a turn but allows an image-only turn", () => {
    expect(resolveBoardComposerSubmission({ prompt: "   ", imageCount: 0 })).toBeNull();
    expect(resolveBoardComposerSubmission({ prompt: "  Fix this  ", imageCount: 0 })).toEqual({
      text: "Fix this",
    });
    expect(resolveBoardComposerSubmission({ prompt: "  ", imageCount: 1 })).toEqual({ text: "" });
  });

  it("only restores a failed board send when the user has not typed into that card again", () => {
    expect(boardComposerDraftCanBeRestored({ prompt: "", images: [] })).toBe(true);
    expect(boardComposerDraftCanBeRestored({ prompt: "new work", images: [] })).toBe(false);
    expect(
      boardComposerDraftCanBeRestored({
        prompt: "",
        images: [{} as never],
      }),
    ).toBe(false);
  });
});
