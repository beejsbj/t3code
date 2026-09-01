import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../../types";

import { boardComposerDraftCanBeRestored, mergeBoardTimelineMessages } from "./useThreadComposer";

describe("board thread composer", () => {
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

  it("removes only the optimistic message that the server has projected", () => {
    const message = (id: string, text: string): ChatMessage => ({
      id: MessageId.make(id),
      role: "user",
      text,
      turnId: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      streaming: false,
    });
    const projected = message("projected", "server copy");
    const stillPending = message("pending", "another pending send");

    expect(
      mergeBoardTimelineMessages(
        [projected],
        [message("projected", "optimistic copy"), stillPending],
        {},
      ),
    ).toEqual([projected, stillPending]);
  });
});
