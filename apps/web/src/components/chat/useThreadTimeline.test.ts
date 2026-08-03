import { CheckpointRef, EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntries } from "../../session-logic.ts";
import { deriveRevertTurnCountByUserMessageId } from "./useThreadTimeline.ts";

describe("deriveRevertTurnCountByUserMessageId", () => {
  it("maps a user message to the checkpoint turn count before its assistant reply", () => {
    const timelineEntries = deriveTimelineEntries(
      [
        {
          id: "user-1" as never,
          role: "user",
          text: "hello",
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          streaming: false,
        },
        {
          id: "assistant-1" as never,
          role: "assistant",
          text: "hi",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    const assistantTurnDiffSummary = {
      turnId: TurnId.make("turn-1"),
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: MessageId.make("assistant-1"),
      checkpointTurnCount: 2,
      checkpointRef: CheckpointRef.make("checkpoint-1"),
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified" as const, additions: 3, deletions: 1 }],
    };

    const result = deriveRevertTurnCountByUserMessageId(
      timelineEntries,
      new Map([[MessageId.make("assistant-1"), assistantTurnDiffSummary]]),
      { [TurnId.make("turn-1")]: 2 },
    );

    expect(result.get(MessageId.make("user-1"))).toBe(1);
  });
});
