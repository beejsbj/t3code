import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadRuntimeState, type ThreadRuntimeStateInput } from "./threadRuntimeState";

const RUN_ID = RunId.make("run-1");

function makeRuntime(status: ThreadRuntimeSummary["status"] | null): ThreadRuntimeSummary | null {
  if (status === null) return null;
  return {
    status,
    activeRunId:
      status === "running" || status === "starting" || status === "queued" ? RUN_ID : null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: status === "failed" ? "boom" : null,
    updatedAt: "2026-03-09T10:05:00.000Z",
  };
}

function makeFixture(input: {
  hasActionableProposedPlan?: boolean;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  interactionMode?: "default" | "plan";
  latestRunSettled?: boolean;
  runtimeStatus: ThreadRuntimeSummary["status"] | null;
}): ThreadRuntimeStateInput {
  const settled = input.latestRunSettled ?? true;
  return {
    hasActionableProposedPlan: input.hasActionableProposedPlan ?? false,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    interactionMode: input.interactionMode ?? "default",
    latestRun: {
      runId: RUN_ID,
      status: settled ? "completed" : "running",
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: settled ? "2026-03-09T10:05:00.000Z" : null,
      assistantMessageId: null,
    },
    runtime: makeRuntime(input.runtimeStatus),
  };
}

describe("resolveThreadRuntimeState", () => {
  it("keeps a thread parked on background work visible after the run settles", () => {
    expect(resolveThreadRuntimeState(makeFixture({ runtimeStatus: "idle" }))).toBe("monitoring");
  });

  it.each([
    [
      "approval outranks every other signal",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        interactionMode: "plan",
        runtimeStatus: "running",
      }),
      "approval",
    ],
    [
      "input outranks active work",
      makeFixture({ hasPendingUserInput: true, interactionMode: "plan", runtimeStatus: "running" }),
      "input",
    ],
    ["running is working", makeFixture({ runtimeStatus: "running" }), "working"],
    ["queued is working", makeFixture({ runtimeStatus: "queued" }), "working"],
    ["starting is connecting", makeFixture({ runtimeStatus: "starting" }), "connecting"],
    ["a failed run is failed", makeFixture({ runtimeStatus: "failed" }), "failed"],
    [
      "a settled plan run with an actionable proposal is plan-ready",
      makeFixture({
        hasActionableProposedPlan: true,
        interactionMode: "plan",
        runtimeStatus: "completed",
      }),
      "plan-ready",
    ],
    [
      "an actionable proposal outside plan mode is idle",
      makeFixture({ hasActionableProposedPlan: true, runtimeStatus: "completed" }),
      "idle",
    ],
    [
      "an actionable proposal from an unsettled run is idle",
      makeFixture({
        hasActionableProposedPlan: true,
        interactionMode: "plan",
        latestRunSettled: false,
        runtimeStatus: "completed",
      }),
      "idle",
    ],
    ["a resting thread is idle", makeFixture({ runtimeStatus: null }), "idle"],
  ] as const)("%s", (_name, thread, expected) => {
    expect(resolveThreadRuntimeState(thread)).toBe(expected);
  });
});
