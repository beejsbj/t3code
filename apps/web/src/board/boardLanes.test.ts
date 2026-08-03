import { LaneId, type LaneDefinition, type OrchestrationThreadShell } from "@t3tools/contracts";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarV2Status } from "../components/Sidebar.logic.ts";
import {
  type BoardLaneInput,
  boardLaneLabel,
  boardLaneInterruptPolicy,
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

function AT(
  now: string,
  autoSettleAfterDays: number | null = null,
  changeRequestState: "open" | "closed" | "merged" | null = null,
) {
  return { now, autoSettleAfterDays, changeRequestState, lanes: LANES };
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

describe("board/sidebar settled-state drift", () => {
  const fixtures = [
    { name: "no change request", changeRequestState: null, settled: false },
    { name: "open change request", changeRequestState: "open", settled: false },
    { name: "merged change request", changeRequestState: "merged", settled: true },
    { name: "closed change request", changeRequestState: "closed", settled: true },
  ] as const;

  it.each(fixtures)("keeps the $name verdict aligned", ({ changeRequestState, settled }) => {
    const thread = shell({ workflowLane: "ready", settledOverride: null });
    const sidebarSettled = effectiveSettled(thread as OrchestrationThreadShell, {
      now: NOW,
      autoSettleAfterDays: null,
      changeRequestState,
    });
    const boardSettled =
      resolveBoardPlacement(thread, AT(NOW, null, changeRequestState))?.lane === "done";

    expect(sidebarSettled).toBe(settled);
    expect(boardSettled).toBe(sidebarSettled);
  });
});

describe("resolveBoardPlacement", () => {
  it.each(["merged", "closed"] as const)(
    "drains a thread with a %s change request to done",
    (changeRequestState) => {
      const placement = resolveBoardPlacement(
        shell({ workflowLane: "ready", settledOverride: null }),
        AT(NOW, null, changeRequestState),
      );

      expect(placement?.lane).toBe("done");
      expect(placement?.source).toBe("native-done");
    },
  );

  it("preserves existing placement when change-request state is null", () => {
    const thread = shell({ workflowLane: "ready", settledOverride: null });

    expect(resolveBoardPlacement(thread, AT(NOW, null, null))).toEqual(
      resolveBoardPlacement(thread, AT(NOW)),
    );
    expect(resolveBoardPlacement(thread, AT(NOW, null, null))?.lane).toBe("ready");
  });

  it("holds pending user input in a badge-policy lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "shaping", hasPendingUserInput: true }),
      AT(NOW),
    )!;

    expect(placement.lane).toBe("shaping");
    expect(placement.source).toBe("assigned");
    expect(placement.heldInPlace).toBe(true);
    expect(placement.inNeedsYouRail).toBe(false);
    expect(placement.attention).toBe("blocked");
  });

  it("moves a pending approval from a move-policy lane to the rail", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "ready", hasPendingApprovals: true }),
      AT(NOW),
    )!;

    expect(placement.lane).toBeNull();
    expect(placement.inNeedsYouRail).toBe(true);
    expect(placement.heldInPlace).toBe(false);
  });

  it("drains an effectively settled badge-lane thread to done", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "shaping", settledOverride: "settled" }),
      AT(NOW),
    )!;

    expect(placement.lane).toBe("done");
    expect(placement.inNeedsYouRail).toBe(false);
    expect(placement.heldInPlace).toBe(false);
  });

  it("uses the fixed done outlet even when it is absent from the registry", () => {
    const placement = resolveBoardPlacement(shell({ settledOverride: "settled" }), {
      ...AT(NOW),
      lanes: LANES.filter((lane) => lane.id !== "done"),
    })!;

    expect(placement.lane).toBe("done");
    expect(placement.source).toBe("native-done");
    expect(placement.inNeedsYouRail).toBe(false);
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

    expect(movePlacement.lane).toBeNull();
    expect(movePlacement.inNeedsYouRail).toBe(true);
    expect(movePlacement.heldInPlace).toBe(false);
    expect(badgePlacement.lane).toBe("ready");
    expect(badgePlacement.inNeedsYouRail).toBe(false);
    expect(badgePlacement.heldInPlace).toBe(true);
  });

  it("leaves a dangling assigned lane unplaced without losing its id", () => {
    expect(resolveBoardPlacement(shell({ workflowLane: "retired" }), AT(NOW))).toEqual({
      lane: null,
      source: "inbox",
      assignedLane: LaneId.make("retired"),
      assignedBy: "user",
      assignedReason: null,
      danglingLaneId: LaneId.make("retired"),
      attention: null,
      overridden: false,
      heldInPlace: false,
      inNeedsYouRail: false,
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

    expect(placement?.lane).toBeNull();
    expect(placement?.inNeedsYouRail).toBe(true);
    expect(placement?.attention).toBe("blocked");
  });

  it("surfaces a failed session in blocked with a failure reason", () => {
    const placement = resolveBoardPlacement(shell({ session: session("error") }), AT(NOW));

    expect(placement?.lane).toBeNull();
    expect(placement?.inNeedsYouRail).toBe(true);
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
      assignedBy: null,
      assignedReason: null,
      danglingLaneId: null,
      attention: null,
      overridden: false,
      heldInPlace: false,
      inNeedsYouRail: false,
    });
  });

  it("honours the assigned lane when nothing needs attention", () => {
    const placement = resolveBoardPlacement(shell({ workflowLane: "ready" }), AT(NOW))!;
    expect(placement.lane).toBe("ready");
    expect(placement.source).toBe("assigned");
    expect(placement.overridden).toBe(false);
  });

  it("keeps live work in its assigned move-policy lane", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "ready", session: session("running") }),
      AT(NOW),
    )!;
    expect(placement.lane).toBe("ready");
    expect(placement.source).toBe("assigned");
    expect(placement.inNeedsYouRail).toBe(false);
    expect(placement.attention).toBe("active");
    expect(placement.overridden).toBe(false);
    expect(placement.assignedLane).toBe("ready");
  });

  it("does not report an override for a legacy attention assignment", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "active", session: session("running") }),
      AT(NOW),
    )!;
    expect(placement.lane).toBeNull();
    expect(placement.source).toBe("attention");
    expect(placement.inNeedsYouRail).toBe(true);
    expect(placement.overridden).toBe(false);
  });

  it("pulls an unplaced session onto the rail while it needs attention", () => {
    expect(resolveBoardPlacement(shell({ hasPendingApprovals: true }), AT(NOW))).toEqual({
      lane: null,
      source: "attention",
      assignedLane: null,
      assignedBy: null,
      assignedReason: null,
      danglingLaneId: null,
      attention: "blocked",
      overridden: false,
      heldInPlace: false,
      inNeedsYouRail: true,
    });
  });

  it("pulls unplaced live work onto the rail", () => {
    const placement = resolveBoardPlacement(shell({ session: session("running") }), AT(NOW))!;

    expect(placement.lane).toBeNull();
    expect(placement.attention).toBe("active");
    expect(placement.inNeedsYouRail).toBe(true);
  });

  it("keeps live work on the rail while effective settlement is suppressed", () => {
    const placement = resolveBoardPlacement(
      shell({
        workflowLane: "review",
        settledOverride: "settled",
        session: session("running"),
      }),
      AT(NOW),
    )!;
    expect(placement.lane).toBeNull();
    expect(placement.source).toBe("attention");
    expect(placement.inNeedsYouRail).toBe(true);
    expect(placement.assignedLane).toBe("review");
  });

  it("keeps pending attention on the rail while effective settlement is suppressed", () => {
    const placement = resolveBoardPlacement(
      shell({ settledOverride: "settled", hasPendingApprovals: true }),
      AT(NOW),
    )!;
    expect(placement.lane).toBeNull();
    expect(placement.source).toBe("attention");
    expect(placement.inNeedsYouRail).toBe(true);
  });

  it("restores the assigned lane once attention clears", () => {
    const assigned = shell({ workflowLane: "ready" });
    const working = { ...assigned, session: session("running") };
    expect(resolveBoardPlacement(working, AT(NOW))!.lane).toBe("ready");
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

  it("names the agent and its reason when the agent filed the card", () => {
    const placement = resolveBoardPlacement(
      shell({
        workflowLane: "ready",
        workflowLanePlacedBy: "agent",
        workflowLanePlacementReason: "the plan is approved and the work is scoped",
      }),
      AT(NOW),
    )!;

    expect(placement.assignedBy).toBe("agent");
    expect(placementReason(placement, LANES)).toBe(
      "Filed here by the agent — the plan is approved and the work is scoped",
    );
  });

  it("still attributes an agent placement that came with no reason", () => {
    const placement = resolveBoardPlacement(
      shell({ workflowLane: "ready", workflowLanePlacedBy: "agent" }),
      AT(NOW),
    )!;

    expect(placementReason(placement, LANES)).toBe("Filed here by the agent");
  });

  it("keeps the badge explanation and the agent attribution together", () => {
    const placement = resolveBoardPlacement(
      shell({
        workflowLane: "shaping",
        hasPendingUserInput: true,
        workflowLanePlacedBy: "agent",
        workflowLanePlacementReason: "still working out the shape",
      }),
      AT(NOW),
    )!;

    expect(placementReason(placement, LANES)).toBe(
      "waiting on you — held here: this lane keeps your attention. Filed here by the agent — still working out the shape",
    );
  });

  it("treats a placement with no recorded provenance as the user's", () => {
    const placement = resolveBoardPlacement(shell({ workflowLane: "ready" }), AT(NOW))!;

    expect(placement.assignedBy).toBe("user");
    expect(placementReason(placement, LANES)).toBeNull();
  });

  it("says so when a card sits in an attention lane only because it was dragged there", () => {
    // Otherwise the board claims the agent is working when it is idle.
    expect(
      placementReason(resolveBoardPlacement(shell({ workflowLane: "active" }), AT(NOW))!, LANES),
    ).toBeNull();
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
