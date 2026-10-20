import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardOriginThreadId } from "./boardOrigin.ts";

const commandId = CommandId.make("command-1");
const threadId = ThreadId.make("thread-1");

describe("boardOriginThreadId", () => {
  it("names the thread a client's run-starting command acts on", () => {
    expect(
      boardOriginThreadId({
        type: "queued-message.promote-to-steer",
        commandId,
        threadId,
        queuedRunId: RunId.make("run-queued"),
        targetRunId: RunId.make("run-active"),
      }),
    ).toBe(threadId);
    expect(boardOriginThreadId({ type: "queue.resume", commandId, threadId })).toBe(threadId);
  });

  it("ignores commands that only organize a thread", () => {
    expect(boardOriginThreadId({ type: "thread.archive", commandId, threadId })).toBeUndefined();
    expect(boardOriginThreadId({ type: "thread.pin", commandId, threadId })).toBeUndefined();
  });
});
