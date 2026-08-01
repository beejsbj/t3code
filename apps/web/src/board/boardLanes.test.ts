import { LaneId, type LaneDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarV2Status } from "../components/Sidebar.logic.ts";
import {
  type BoardLaneInput,
  boardLaneLabel,
  boardLaneInterruptPolicy,
  isAttentionLane,
  isWorkflowLane,
  placementReason,
  resolveBoardPlacement,
  resolveRuntimeAttention,
} from "./boardLanes.ts";

const NOW = "2026-07-28T00:00:00.000Z";

const LANES: ReadonlyArray<LaneDefinition> = [
  {
    id: LaneId.make("shaping"),
    name: "Grilling / shaping",
    description: "Working out what this actually is",
    order: 0,
    interrupt: "badge",
  },
  {
    id: LaneId.make("ready"),
    name: "Ready",
    description: "Groomed and ready to pick up",
    order: 1,
    interrupt: "move",
  },
  {
    id: LaneId.make("done"),
    name: "Done",
    description: "Finished, or pinned settled",
    order: 2,
    interrupt: "move",
  },
  {
    id: LaneId.make("watched"),
    name: "Watched",
    description: "A fixture lane that holds attention in place",
    order: 3,
    interrupt: "badge",
  },
];

function AT(now: string, autoSettleAfterDays: number | null = null) {
  return { now, autoSettleAfterDays, lanes: LANES };
}

function shell(
  overrides: Omit<Partial<BoardLaneInput>, "workflowLane"> & {
    readonly workflowLane?: string | null | undefined;
  } = {},
): BoardLaneInput {
  const workflowLane =
    overrides.workflowLane === undefined
      ? null
      : overrides.workflowLane === null
        ? null
        : LaneId.make(overrides.workflowLane);
  return {
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    latestTurn: null,
    latestUserMessageAt: null,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    ...overrides,
    workflowLane,
  } as BoardLaneInput;
}

function session(status: string): BoardLaneInput["session"] {
  return { status } as unknown as BoardLaneInput["session"];
}

function completedTurn(): BoardLaneInput["latestTurn"] {
  return {
    turnId: "turn-1",
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-07-28T00:00:00.000Z",
    startedAt: "2026-07-28T00:00:00.000Z",
    completedAt: "2026-07-28T00:01:00.000Z",
  } as BoardLaneInput["latestTurn"];
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

  it("does not review an actionable proposed plan in default interaction mode", () => {
    expect(resolveRuntimeAttention(shell({ hasActionableProposedPlan: true }))).toBeNull();
  });

  it("reviews an actionable plan only after the latest plan-mode turn settles", () => {
    expect(
      resolveRuntimeAttention(
        shell({
          hasActionableProposedPlan: true,
          interactionMode: "plan",
          latestTurn: completedTurn(),
        }),
      ),
    ).toBe("review");
    expect(
      resolveRuntimeAttention(
        shell({
          hasActionableProposedPlan: true,
          interactionMode: "plan",
          latestTurn: completedTurn(),
          session: session("running"),
        }),
      ),
    ).toBe("active");
  });
});

describe("board/sidebar runtime-state drift", () => {
  const fixtures = [
    { name: "idle", thread: shell(), sidebar: "ready", board: null },
    {
      name: "approval",
      thread: shell({ hasPendingApprovals: true }),
      sidebar: "approval",
      board: "blocked",
    },
    {
      name: "input",
      thread: shell({ hasPendingUserInput: true }),
      sidebar: "input",
      board: "blocked",
    },
    {
      name: "working",
      thread: shell({ session: session("running") }),
      sidebar: "working",
      board: "active",
    },
    {
      name: "connecting",
      thread: shell({ session: session("starting") }),
      sidebar: "working",
      board: "active",
    },
    {
      name: "failed",
      thread: shell({ session: session("error") }),
      sidebar: "failed",
      board: "failed",
    },
    {
      name: "plan-ready",
      thread: shell({
        hasActionableProposedPlan: true,
        interactionMode: "plan",
        latestTurn: completedTurn(),
      }),
      sidebar: "ready",
      board: "review",
    },
  ] as const;

  it.each(fixtures)("keeps the $name projection aligned", ({ thread, sidebar, board }) => {
    expect(resolveSidebarV2Status(thread)).toBe(sidebar);
    expect(resolveRuntimeAttention(thread)).toBe(board);
  });
});

describe("resolveBoardPlacement", () => {
  it("holds pending user input in a badge-policy lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "shaping", hasPendingUserInput: true }),
      AT(NOW),
    )!;

    expect(placement.lane).toBe("shaping");
    expect(placement.source).toBe("assigned");
    expect(placement.heldInPlace).toBe(true);
    expect(placement.attention).toBe("blocked");
  });

  it("moves pending user input out of a move-policy lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "ready", hasPendingUserInput: true }),
      AT(NOW),
    )!;

    expect(placement.lane).toBe("blocked");
    expect(placement.heldInPlace).toBe(false);
  });

  it("drains an effectively settled badge-lane thread to done", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "shaping", settledOverride: "settled" }),
      AT(NOW),
    )!;

    expect(placement.lane).toBe("done");
    expect(placement.heldInPlace).toBe(false);
  });

  it("leaves a settled thread unplaced when the done lane is absent", () => {
    const placement = resolveBoardPlacement(shell({ settledOverride: "settled" }), {
      ...AT(NOW),
      lanes: LANES.filter((lane) => lane.id !== "done"),
    })!;

    expect(placement.lane).toBeNull();
    expect(placement.source).toBe("native-done");
  });

  it("holds pending approval in a badge-policy lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "watched", hasPendingApprovals: true }),
      AT(NOW),
    )!;

    expect(placement.lane).toBe("watched");
    expect(placement.heldInPlace).toBe(true);
  });

  it("takes interrupt policy from the registry", () => {
    const thread = shell({ workflowLane: "ready", hasPendingUserInput: true });
    const movePlacement = resolveBoardPlacement(thread, AT(NOW))!;
    const badgePlacement = resolveBoardPlacement(thread, {
      ...AT(NOW),
      lanes: LANES.map((lane) =>
        lane.id === "ready" ? { ...lane, interrupt: "badge" as const } : lane,
      ),
    })!;

    expect(movePlacement.lane).toBe("blocked");
    expect(movePlacement.heldInPlace).toBe(false);
    expect(badgePlacement.lane).toBe("ready");
    expect(badgePlacement.heldInPlace).toBe(true);
  });

  it("leaves a dangling assigned lane unplaced without losing its id", () => {
    expect(resolveBoardPlacement(shell({ workflowLane: "retired" }), AT(NOW))).toEqual({
      lane: null,
      source: "inbox",
      assignedLane: LaneId.make("retired"),
      danglingLaneId: LaneId.make("retired"),
      attention: null,
      overridden: false,
      heldInPlace: false,
    });
  });

  it("holds failed attention in a badge-policy lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "shaping", session: session("error") }),
      AT(NOW),
    )!;

    expect(placement.lane).toBe("shaping");
    expect(placement.heldInPlace).toBe(true);
    expect(placement.attention).toBe("failed");
  });

  it("drains an inactive thread to done through effective settlement", () => {
    const placement = resolveBoardPlacement(
      shell({
        workflowLane: "ready",
        latestUserMessageAt: "2026-07-20T00:00:00.000Z",
      } as Partial<BoardLaneInput>),
      AT(NOW, 3),
    )!;

    expect(placement.lane).toBe("done");
    expect(placement.source).toBe("native-done");
  });

  it("suppresses a snoozed idle thread from the board", () => {
    expect(
      resolveBoardPlacement(shell({ snoozedUntil: "2026-07-29T00:00:00.000Z" }), AT(NOW)),
    ).toBeNull();
  });

  it("lets a snoozed thread raise its hand for pending approval", () => {
    const placement = resolveBoardPlacement(
      shell({
        hasPendingApprovals: true,
        snoozedUntil: "2026-07-29T00:00:00.000Z",
      }),
      AT(NOW),
    );

    expect(placement?.lane).toBe("blocked");
    expect(placement?.attention).toBe("blocked");
  });

  it("surfaces a failed session in blocked with a failure reason", () => {
    const placement = resolveBoardPlacement(shell({ session: session("error") }), AT(NOW));

    expect(placement?.lane).toBe("blocked");
    expect(placement?.attention).toBe("failed");
    expect(placement === null ? null : placementReason(placement, LANES)).toBe(
      "the session failed",
    );
  });

  it("puts an unplaced, quiet session in the inbox", () => {
    expect(resolveBoardPlacement(shell(), AT(NOW))).toEqual({
      lane: null,
      source: "inbox",
      assignedLane: null,
      danglingLaneId: null,
      attention: null,
      overridden: false,
      heldInPlace: false,
    });
  });

  it("honours the assigned lane when nothing needs attention", () => {
    const placement = resolveBoardPlacement(shell({ workflowLane: "ready" }), AT(NOW))!;
    expect(placement.lane).toBe("ready");
    expect(placement.source).toBe("assigned");
    expect(placement.overridden).toBe(false);
  });

  it("lets runtime attention temporarily override the assigned lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "ready", session: session("running") }),
      AT(NOW),
    )!;
    expect(placement.lane).toBe("active");
    expect(placement.source).toBe("attention");
    expect(placement.overridden).toBe(true);
    // The persisted assignment is untouched — this is the whole point.
    expect(placement.assignedLane).toBe("ready");
  });

  it("does not report an override when attention agrees with the assignment", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "active", session: session("running") }),
      AT(NOW),
    )!;
    expect(placement.lane).toBe("active");
    expect(placement.source).toBe("attention");
    expect(placement.overridden).toBe(false);
  });

  it("pulls an unplaced session onto a lane while it needs attention", () => {
    expect(resolveBoardPlacement(shell({ hasPendingApprovals: true }), AT(NOW))).toEqual({
      lane: "blocked",
      source: "attention",
      assignedLane: null,
      danglingLaneId: null,
      attention: "blocked",
      overridden: false,
      heldInPlace: false,
    });
  });

  it("keeps live work active even when explicitly settled", () => {
    const placement = resolveBoardPlacement(
      shell({
        workflowLane: "review",
        settledOverride: "settled",
        session: session("running"),
      }),
      AT(NOW),
    )!;
    expect(placement.lane).toBe("active");
    expect(placement.source).toBe("attention");
    expect(placement.assignedLane).toBe("review");
  });

  it("keeps a settled session in blocked when it is still waiting on a human", () => {
    // Burying a pending approval under Done is the exact failure the board
    // exists to prevent, so blocked outranks even an explicit settle pin.
    const placement = resolveBoardPlacement(
      shell({ settledOverride: "settled", hasPendingApprovals: true }),
      AT(NOW),
    )!;
    expect(placement.lane).toBe("blocked");
    expect(placement.source).toBe("attention");
  });

  it("restores the assigned lane once attention clears", () => {
    const assigned = shell({ workflowLane: "ready" });
    const working = { ...assigned, session: session("running") };
    expect(resolveBoardPlacement(working, AT(NOW))!.lane).toBe("active");
    expect(resolveBoardPlacement(assigned, AT(NOW))!.lane).toBe("ready");
  });
});

describe("placementReason", () => {
  it("explains attention held in a badge-policy lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "shaping", hasPendingUserInput: true }),
      AT(NOW),
    )!;

    expect(placementReason(placement, LANES)).toBe(
      "waiting on you — held here: this lane keeps your attention",
    );
  });

  it("explains an override in terms of both lanes", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "ready", hasPendingApprovals: true }),
      AT(NOW),
    )!;
    expect(placementReason(placement, LANES)).toBe(
      "Held here while waiting on you — assigned to Ready",
    );
  });

  it("stays quiet for a plainly assigned intent lane", () => {
    expect(
      placementReason(resolveBoardPlacement(shell({ workflowLane: "ready" }), AT(NOW))!, LANES),
    ).toBeNull();
  });

  it("says so when a card sits in an attention lane only because it was dragged there", () => {
    // Otherwise the board claims the agent is working when it is idle.
    expect(
      placementReason(resolveBoardPlacement(shell({ workflowLane: "active" }), AT(NOW))!, LANES),
    ).toBeNull();
  });
});

describe("isAttentionLane", () => {
  it("separates runtime-owned lanes from human-intent lanes", () => {
    expect(isAttentionLane(LaneId.make("active"))).toBe(true);
    expect(isAttentionLane(LaneId.make("blocked"))).toBe(true);
    expect(isAttentionLane(LaneId.make("review"))).toBe(true);
    expect(isAttentionLane(LaneId.make("shaping"))).toBe(false);
    expect(isAttentionLane(LaneId.make("ready"))).toBe(false);
    expect(isAttentionLane(LaneId.make("done"))).toBe(false);
  });
});

describe("isWorkflowLane", () => {
  it("accepts registry lanes and rejects anything else", () => {
    expect(isWorkflowLane("shaping", LANES)).toBe(true);
    expect(isWorkflowLane("done", LANES)).toBe(true);
    expect(isWorkflowLane("active", LANES)).toBe(false);
    expect(isWorkflowLane("inbox", LANES)).toBe(false);
    expect(isWorkflowLane("", LANES)).toBe(false);
  });
});

describe("boardLaneInterruptPolicy", () => {
  it("reads policy from the registry and defaults missing lanes to move", () => {
    expect(boardLaneInterruptPolicy(LaneId.make("shaping"), LANES)).toBe("badge");
    expect(boardLaneInterruptPolicy(LaneId.make("ready"), LANES)).toBe("move");
    expect(boardLaneInterruptPolicy(LaneId.make("active"), LANES)).toBe("move");
  });
});

describe("boardLaneLabel", () => {
  it("reads the name from the registry and falls back to the lane id", () => {
    expect(boardLaneLabel(LaneId.make("shaping"), LANES)).toBe("Grilling / shaping");
    expect(boardLaneLabel(LaneId.make("retired"), LANES)).toBe("retired");
  });
});
