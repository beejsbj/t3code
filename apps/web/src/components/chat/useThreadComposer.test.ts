import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore.ts";

import {
  boardComposerDraftCanBeRestored,
  buildBoardComposerMessageFields,
  canBeginBoardComposerSend,
  resolveBoardComposerModelSelection,
  resolveBoardComposerSubmission,
  retainUnacknowledgedMessages,
} from "./useThreadComposer.ts";

const connection = (phase: "connected" | "reconnecting") => ({
  phase,
  error: null,
  traceId: null,
});

describe("canBeginBoardComposerSend", () => {
  it("only starts one send while the owning environment is connected", () => {
    expect(canBeginBoardComposerSend(connection("connected"), false)).toBe(true);
    expect(canBeginBoardComposerSend(connection("connected"), true)).toBe(false);
    expect(canBeginBoardComposerSend(connection("reconnecting"), false)).toBe(false);
  });
});

describe("resolveBoardComposerSubmission", () => {
  it("allows the shell-backed composer to send before thread detail loads", () => {
    expect(
      resolveBoardComposerSubmission({
        prompt: "  follow up  ",
        imageCount: 0,
      }),
    ).toEqual({ text: "follow up" });
  });

  it("rejects an empty draft", () => {
    expect(
      resolveBoardComposerSubmission({
        prompt: "  ",
        imageCount: 0,
      }),
    ).toBeNull();
  });

  it("does not couple submission validity to session lifecycle", () => {
    expect(
      resolveBoardComposerSubmission({
        prompt: "follow up",
        imageCount: 0,
      }),
    ).toEqual({ text: "follow up" });
  });
});

describe("boardComposerDraftCanBeRestored", () => {
  it("restores after clearComposerContent deletes a plain-message draft", () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("board-send-failure-environment"),
      ThreadId.make("board-send-failure-thread"),
    );
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "message to retry");
    store.clearComposerContent(threadRef);

    const clearedDraft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(clearedDraft).toBeNull();
    expect(boardComposerDraftCanBeRestored(clearedDraft)).toBe(true);

    useComposerDraftStore.getState().setPrompt(threadRef, "message to retry");
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "message to retry",
    );
  });

  it("restores over an empty draft but never overwrites concurrent input", () => {
    expect(boardComposerDraftCanBeRestored({ prompt: "", images: [] })).toBe(true);
    expect(boardComposerDraftCanBeRestored({ prompt: "new input", images: [] })).toBe(false);
    expect(
      boardComposerDraftCanBeRestored({
        prompt: "",
        images: [{} as ComposerImageAttachment],
      }),
    ).toBe(false);
    expect(
      boardComposerDraftCanBeRestored({
        prompt: "",
        images: [],
        reviewComments: [{} as never],
      }),
    ).toBe(false);
  });
});

describe("buildBoardComposerMessageFields", () => {
  const context = {
    version: 1 as const,
    records: [
      {
        version: 1 as const,
        contextId: "terminal:terminal-context" as never,
        kind: "terminal" as const,
        label: "dev server line 1",
        terminalId: "terminal-1",
        terminalLabel: "dev server",
        lineStart: 1,
        lineEnd: 1,
        text: "server output",
      },
    ],
  };

  it("sends typed context records to current servers", () => {
    expect(
      buildBoardComposerMessageFields({
        text: "Fix this",
        context,
        supportsInlineMessageContext: true,
      }),
    ).toEqual({ text: "Fix this", context });
  });

  it("serializes records for older servers", () => {
    const result = buildBoardComposerMessageFields({
      text: "Fix this",
      context,
      supportsInlineMessageContext: false,
    });

    expect(result.context).toBeUndefined();
    expect(result.text).toContain("<terminal_context>");
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

describe("retainUnacknowledgedMessages", () => {
  const sent = { id: MessageId.make("message-sent") };
  const acknowledged = { id: MessageId.make("message-acknowledged") };

  it("returns the same array when the server has acknowledged none of it", () => {
    // A new array here on every render re-derives the board card's timeline and loops.
    const none: ReadonlyArray<typeof sent> = [];
    const pending = [sent];
    expect(retainUnacknowledgedMessages(none, new Set([acknowledged.id]))).toBe(none);
    expect(retainUnacknowledgedMessages(pending, new Set([acknowledged.id]))).toBe(pending);
  });

  it("drops the rows the server already has", () => {
    expect(retainUnacknowledgedMessages([sent, acknowledged], new Set([acknowledged.id]))).toEqual([
      sent,
    ]);
  });
});
