import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../../types";

import {
  boardComposerDraftCanBeRestored,
  mergeBoardTimelineMessages,
  parseBoardCodexFeedbackCommand,
  parseBoardStandaloneComposerSlashCommand,
  removeBoardAttachmentPreviewHandoff,
  resolveBoardComposerModes,
} from "./useThreadComposer";

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

  it("recognizes feedback only for a plain Codex board draft", () => {
    expect(
      parseBoardCodexFeedbackCommand({
        provider: "codex",
        prompt: "/feedback The agent stopped early.",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toEqual({ reason: "The agent stopped early." });
    expect(
      parseBoardCodexFeedbackCommand({
        provider: "claude",
        prompt: "/feedback",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toBeNull();
    expect(
      parseBoardCodexFeedbackCommand({
        provider: "codex",
        prompt: "/feedback",
        hasAttachments: true,
        hasContexts: false,
      }),
    ).toBeNull();
  });

  it("recognizes standalone mode commands only for an empty enabled-plan draft", () => {
    expect(
      parseBoardStandaloneComposerSlashCommand({
        planModeEnabled: true,
        prompt: " /plan ",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toBe("plan");
    expect(
      parseBoardStandaloneComposerSlashCommand({
        planModeEnabled: true,
        prompt: "/default",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toBe("default");
    expect(
      parseBoardStandaloneComposerSlashCommand({
        planModeEnabled: false,
        prompt: "/plan",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toBeNull();
    expect(
      parseBoardStandaloneComposerSlashCommand({
        planModeEnabled: true,
        prompt: "/default",
        hasAttachments: false,
        hasContexts: true,
      }),
    ).toBeNull();
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

  it("removes a preview handoff while returning its blob URLs for cleanup", () => {
    const handoffs = {
      projected: ["blob:preview-1", "blob:preview-2"],
      pending: ["blob:preview-3"],
    } as const;

    expect(removeBoardAttachmentPreviewHandoff(handoffs, "projected")).toEqual({
      next: { pending: ["blob:preview-3"] },
      previewUrls: ["blob:preview-1", "blob:preview-2"],
    });
    expect(removeBoardAttachmentPreviewHandoff(handoffs, "missing")).toBeNull();
  });

  it("falls back to build mode when a retained plan mode is disabled", () => {
    expect(
      resolveBoardComposerModes({
        planModeEnabled: false,
        draftRuntimeMode: null,
        draftInteractionMode: null,
        summaryRuntimeMode: "full-access",
        summaryInteractionMode: "plan",
      }),
    ).toEqual({ runtimeMode: "full-access", interactionMode: "default" });
  });

  it("uses per-thread draft modes ahead of stale thread summary modes", () => {
    expect(
      resolveBoardComposerModes({
        planModeEnabled: true,
        draftRuntimeMode: "approval-required",
        draftInteractionMode: "plan",
        summaryRuntimeMode: "full-access",
        summaryInteractionMode: "default",
      }),
    ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  });
});
