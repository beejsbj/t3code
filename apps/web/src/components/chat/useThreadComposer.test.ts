import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore.ts";
import type { ChatMessage } from "../../types.ts";

import {
  boardComposerDraftCanBeRestored,
  buildBoardComposerMessageText,
  canBeginBoardComposerSend,
  mergeBoardTimelineMessages,
  resolveBoardComposerModelSelection,
  resolveBoardComposerSubmission,
  useThreadComposerRouteState,
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

describe("useThreadComposerRouteState", () => {
  it("exports pending state derivation for a thread", () => {
    expect(typeof useThreadComposerRouteState).toBe("function");
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

describe("buildBoardComposerMessageText", () => {
  it("serializes every stored composer context into the outgoing message", () => {
    const text = buildBoardComposerMessageText({
      prompt: "Fix this",
      terminalContexts: [
        {
          id: "terminal-context",
          threadId: ThreadId.make("board-context-thread"),
          terminalId: "terminal-1",
          terminalLabel: "dev server",
          lineStart: 1,
          lineEnd: 1,
          text: "server output",
          createdAt: "2026-08-14T12:00:00.000Z",
        },
      ],
      elementContexts: [
        {
          id: "element-context",
          threadId: ThreadId.make("board-context-thread"),
          pageUrl: "http://localhost:3000",
          pageTitle: "App",
          tagName: "button",
          selector: ".submit",
          htmlPreview: "<button>Send</button>",
          componentName: "SubmitButton",
          source: null,
          styles: "color: red",
          pickedAt: "2026-08-14T12:00:00.000Z",
        },
      ],
      previewAnnotations: [
        {
          id: "annotation-1",
          pageUrl: "http://localhost:3000",
          pageTitle: "App",
          comment: "Move this",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: "2026-08-14T12:00:00.000Z",
        },
      ],
      reviewComments: [
        {
          id: "review-1",
          sectionId: "file:app.ts",
          sectionTitle: "File comment",
          filePath: "app.ts",
          startIndex: 0,
          endIndex: 0,
          rangeLabel: "L1",
          text: "Rename this",
          diff: "const oldName = true;",
        },
      ],
    });

    expect(text).toContain("<terminal_context>");
    expect(text).toContain("<element_context>");
    expect(text).toContain("<preview_annotation>");
    expect(text).toContain("<review_comment");
  });
});

describe("mergeBoardTimelineMessages", () => {
  it("hands an optimistic image preview to the matching projected message", () => {
    const messageId = MessageId.make("board-image-message");
    const serverMessage: ChatMessage = {
      id: messageId,
      role: "user",
      text: "image",
      attachments: [
        {
          type: "image",
          id: "server-attachment",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
      turnId: null,
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
      streaming: false,
    };
    const optimisticMessage: ChatMessage = {
      ...serverMessage,
      attachments: [{ ...serverMessage.attachments![0]!, previewUrl: "blob:optimistic" }],
    };

    const merged = mergeBoardTimelineMessages([serverMessage], [optimisticMessage], {
      [messageId]: ["blob:optimistic"],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.attachments?.[0]?.previewUrl).toBe("blob:optimistic");
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
