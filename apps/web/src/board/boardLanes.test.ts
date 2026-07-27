import { describe, expect, it } from "vite-plus/test";

import {
  type BoardLaneInput,
  isAttentionLane,
  isNativelyDone,
  isWorkflowLane,
  placementReason,
  resolveBoardPlacement,
  resolveRuntimeAttention,
} from "./boardLanes.ts";

function shell(overrides: Partial<BoardLaneInput> = {}): BoardLaneInput {
  return {
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    archivedAt: null,
    settledOverride: null,
    workflowLane: null,
    ...overrides,
  } as BoardLaneInput;
}

function session(status: string): BoardLaneInput["session"] {
  return { status } as unknown as BoardLaneInput["session"];
}

describe("resolveRuntimeAttention", () => {
  it("reports no attention for an idle, unblocked session", () => {
    expect(resolveRuntimeAttention(shell())).toBeNull();
    expect(resolveRuntimeAttention(shell({ session: session("ready") }))).toBeNull();
  });

  it("treats a running or starting session as active", () => {
    expect(resolveRuntimeAttention(shell({ session: session("running") }))).toBe("active");
    expect(resolveRuntimeAttention(shell({ session: session("starting") }))).toBe("active");
  });

  it("treats pending approvals and pending questions as blocked", () => {
    expect(resolveRuntimeAttention(shell({ hasPendingApprovals: true }))).toBe("blocked");
    expect(resolveRuntimeAttention(shell({ hasPendingUserInput: true }))).toBe("blocked");
  });

  it("ranks blocked above active when the session is nominally still running", () => {
    expect(
      resolveRuntimeAttention(shell({ session: session("running"), hasPendingApprovals: true })),
    ).toBe("blocked");
  });

  it("treats an actionable proposed plan as review, but only when nothing is more urgent", () => {
    expect(resolveRuntimeAttention(shell({ hasActionableProposedPlan: true }))).toBe("review");
    expect(
      resolveRuntimeAttention(
        shell({ hasActionableProposedPlan: true, session: session("running") }),
      ),
    ).toBe("active");
  });
});

describe("isNativelyDone", () => {
  it("is true only for an explicitly settled thread", () => {
    expect(isNativelyDone(shell())).toBe(false);
    expect(isNativelyDone(shell({ settledOverride: "settled" }))).toBe(true);
    expect(isNativelyDone(shell({ settledOverride: "active" }))).toBe(false);
  });

  it("ignores archivedAt, because archived sessions leave the board entirely", () => {
    expect(isNativelyDone(shell({ archivedAt: "2026-07-27T00:00:00.000Z" }))).toBe(false);
  });
});

describe("resolveBoardPlacement", () => {
  it("puts an unplaced, quiet session in the inbox", () => {
    const placement = resolveBoardPlacement(shell());
    expect(placement.lane).toBeNull();
    expect(placement.source).toBe("inbox");
    expect(placement.overridden).toBe(false);
  });

  it("honours the assigned lane when nothing needs attention", () => {
    const placement = resolveBoardPlacement(shell({ workflowLane: "ready" }));
    expect(placement.lane).toBe("ready");
    expect(placement.source).toBe("assigned");
    expect(placement.overridden).toBe(false);
  });

  it("lets runtime attention temporarily override the assigned lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "ready", session: session("running") }),
    );
    expect(placement.lane).toBe("active");
    expect(placement.source).toBe("attention");
    expect(placement.overridden).toBe(true);
    // The persisted assignment is untouched — this is the whole point.
    expect(placement.assignedLane).toBe("ready");
  });

  it("does not report an override when attention agrees with the assignment", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "active", session: session("running") }),
    );
    expect(placement.lane).toBe("active");
    expect(placement.source).toBe("attention");
    expect(placement.overridden).toBe(false);
  });

  it("pulls an unplaced session onto a lane while it needs attention", () => {
    const placement = resolveBoardPlacement(shell({ hasPendingApprovals: true }));
    expect(placement.lane).toBe("blocked");
    expect(placement.assignedLane).toBeNull();
    expect(placement.overridden).toBe(false);
  });

  it("ranks native done above active and review attention", () => {
    const placement = resolveBoardPlacement(
      shell({
        workflowLane: "review",
        settledOverride: "settled",
        session: session("running"),
      }),
    );
    expect(placement.lane).toBe("done");
    expect(placement.source).toBe("native-done");
    expect(placement.assignedLane).toBe("review");
  });

  it("keeps a settled session in blocked when it is still waiting on a human", () => {
    // Burying a pending approval under Done is the exact failure the board
    // exists to prevent, so blocked outranks even an explicit settle pin.
    const placement = resolveBoardPlacement(
      shell({ settledOverride: "settled", hasPendingApprovals: true }),
    );
    expect(placement.lane).toBe("blocked");
    expect(placement.source).toBe("attention");
  });

  it("restores the assigned lane once attention clears", () => {
    const assigned = shell({ workflowLane: "ready" });
    const working = { ...assigned, session: session("running") };
    expect(resolveBoardPlacement(working).lane).toBe("active");
    expect(resolveBoardPlacement(assigned).lane).toBe("ready");
  });
});

describe("placementReason", () => {
  it("explains an override in terms of both lanes", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "ready", hasPendingApprovals: true }),
    );
    expect(placementReason(placement)).toBe("Held here while waiting on you — assigned to Ready");
  });

  it("stays quiet for a plainly assigned intent lane", () => {
    expect(placementReason(resolveBoardPlacement(shell({ workflowLane: "ready" })))).toBeNull();
  });

  it("says so when a card sits in an attention lane only because it was dragged there", () => {
    // Otherwise the board claims the agent is working when it is idle.
    expect(placementReason(resolveBoardPlacement(shell({ workflowLane: "active" })))).toBe(
      "Placed here by hand — the session is idle",
    );
  });
});

describe("isAttentionLane", () => {
  it("separates runtime-owned lanes from human-intent lanes", () => {
    expect(isAttentionLane("active")).toBe(true);
    expect(isAttentionLane("blocked")).toBe(true);
    expect(isAttentionLane("review")).toBe(true);
    expect(isAttentionLane("shaping")).toBe(false);
    expect(isAttentionLane("ready")).toBe(false);
    expect(isAttentionLane("done")).toBe(false);
  });
});

describe("isWorkflowLane", () => {
  it("accepts board lanes and rejects anything else", () => {
    expect(isWorkflowLane("shaping")).toBe(true);
    expect(isWorkflowLane("done")).toBe(true);
    expect(isWorkflowLane("inbox")).toBe(false);
    expect(isWorkflowLane("")).toBe(false);
  });
});
