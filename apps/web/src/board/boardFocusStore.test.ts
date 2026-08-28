import { beforeEach, describe, expect, it } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { DraftId } from "../composerDraftStore.ts";
import { selectBoardCardFocusRequestNonce, useBoardFocusStore } from "./boardFocusStore.ts";

beforeEach(() => {
  useBoardFocusStore.setState({
    request: null,
    acknowledgedFocus: null,
    focusedThreadKey: null,
    expandedTarget: null,
  });
});

describe("boardFocusStore", () => {
  it("acknowledges only the current focus request", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    const request = useBoardFocusStore.getState().request;
    expect(request).not.toBeNull();

    store.acknowledgeFocus("thread-a", (request?.nonce ?? 0) - 1);
    expect(useBoardFocusStore.getState().acknowledgedFocus).toBeNull();

    store.acknowledgeFocus("thread-a", request?.nonce ?? 0);
    expect(useBoardFocusStore.getState().request).toBeNull();
    expect(useBoardFocusStore.getState().acknowledgedFocus).toEqual({
      threadKey: "thread-a",
      requestNonce: request?.nonce,
    });
    expect(useBoardFocusStore.getState().focusedThreadKey).toBe("thread-a");
  });

  it("preserves an acknowledgement for a later request to the same thread", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    const firstNonce = useBoardFocusStore.getState().request?.nonce ?? 0;
    store.acknowledgeFocus("thread-a", firstNonce);

    store.requestFocus("thread-a");
    expect(useBoardFocusStore.getState().request?.nonce).toBe(firstNonce + 1);
    expect(useBoardFocusStore.getState().acknowledgedFocus?.requestNonce).toBe(firstNonce);
    expect(useBoardFocusStore.getState().focusedThreadKey).toBeNull();
    expect(selectBoardCardFocusRequestNonce(useBoardFocusStore.getState(), "thread-a")).toBeNull();
  });

  it("releases a pending request to the card composer only after board focus settles", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    const requestNonce = useBoardFocusStore.getState().request?.nonce ?? 0;

    expect(selectBoardCardFocusRequestNonce(useBoardFocusStore.getState(), "thread-a")).toBeNull();

    store.setFocused("thread-a");
    expect(selectBoardCardFocusRequestNonce(useBoardFocusStore.getState(), "thread-a")).toBe(
      requestNonce,
    );
  });

  it("keeps focus acknowledgement scoped to the selected environment", () => {
    const firstKey = scopedThreadKey(
      scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("shared-thread")),
    );
    const secondKey = scopedThreadKey(
      scopeThreadRef(EnvironmentId.make("environment-b"), ThreadId.make("shared-thread")),
    );
    const store = useBoardFocusStore.getState();

    store.requestFocus(firstKey);
    store.acknowledgeFocus(firstKey, useBoardFocusStore.getState().request?.nonce ?? 0);
    store.requestFocus(secondKey);

    expect(secondKey).not.toBe(firstKey);
    expect(useBoardFocusStore.getState().request?.threadKey).toBe(secondKey);
    expect(useBoardFocusStore.getState().acknowledgedFocus).toBeNull();
  });

  it("clears only the matching pending request", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    const nonce = useBoardFocusStore.getState().request?.nonce ?? 0;

    store.clearRequest("thread-a", nonce - 1);
    expect(useBoardFocusStore.getState().request?.nonce).toBe(nonce);

    store.clearRequest("thread-a", nonce);
    expect(useBoardFocusStore.getState().request).toBeNull();
  });

  it("clears acknowledgement when focus moves to another thread", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    store.acknowledgeFocus("thread-a", useBoardFocusStore.getState().request?.nonce ?? 0);

    store.requestFocus("thread-b");
    expect(useBoardFocusStore.getState().acknowledgedFocus).toBeNull();
    store.setFocused("thread-b");
    expect(useBoardFocusStore.getState().focusedThreadKey).toBe("thread-b");
  });

  it("opens either a thread or a draft in the shared expanded surface", () => {
    const store = useBoardFocusStore.getState();

    store.setExpanded({ kind: "thread", threadKey: "thread-a" });
    expect(useBoardFocusStore.getState().expandedTarget).toEqual({
      kind: "thread",
      threadKey: "thread-a",
    });

    const draftId = DraftId.make("draft-a");
    store.setExpanded({ kind: "draft", draftId });
    expect(useBoardFocusStore.getState().expandedTarget).toEqual({ kind: "draft", draftId });

    store.setExpanded(null);
    expect(useBoardFocusStore.getState().expandedTarget).toBeNull();
  });

  it("does not publish a store update for the same expanded target", () => {
    const updates: unknown[] = [];
    const unsubscribe = useBoardFocusStore.subscribe((state) => updates.push(state.expandedTarget));

    useBoardFocusStore.getState().setExpanded({ kind: "thread", threadKey: "thread-a" });
    useBoardFocusStore.getState().setExpanded({ kind: "thread", threadKey: "thread-a" });
    useBoardFocusStore.getState().setExpanded(null);
    useBoardFocusStore.getState().setExpanded(null);
    unsubscribe();

    expect(updates).toEqual([{ kind: "thread", threadKey: "thread-a" }, null]);
  });
});
