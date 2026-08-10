import { LaneId, type LaneDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  leftmostLane,
  resolveBoardLane,
  SETTLED_BOARD_LANE_ID,
  SNOOZED_BOARD_LANE_ID,
} from "./boardLanes.ts";

const NOW = "2026-04-10T12:00:00.000Z";
const FUTURE_WAKE = "2026-04-10T18:00:00.000Z";
const PAST_WAKE = "2026-04-09T12:00:00.000Z";

const LANES: ReadonlyArray<LaneDefinition> = [
  {
    id: LaneId.make("triage"),
    name: "Triage",
    description: "Unplaced sessions",
    order: -1,
  },
  {
    id: LaneId.make("ready"),
    name: "Ready",
    description: "Ready to pick up",
    order: 1,
  },
  {
    id: LaneId.make("settled"),
    name: "Settled",
    description: "Settled sessions",
    order: 10,
  },
  {
    id: LaneId.make("snoozed"),
    name: "Snoozed",
    description: "Snoozed sessions",
    order: 11,
  },
];

const LANES_WITHOUT_LIFECYCLE: ReadonlyArray<LaneDefinition> = LANES.filter(
  (lane) => lane.id !== SETTLED_BOARD_LANE_ID && lane.id !== SNOOZED_BOARD_LANE_ID,
);

const RESOLUTION = { now: NOW, autoSettleAfterDays: null } as const;

type BoardLaneInput = Parameters<typeof resolveBoardLane>[0];

function makeShell(
  input: Partial<BoardLaneInput> & Pick<BoardLaneInput, "workflowLane">,
): BoardLaneInput {
  return {
    workflowLane: input.workflowLane,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedAt ?? null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    session: input.session ?? null,
    latestTurn: input.latestTurn ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
  };
}

describe("resolveBoardLane", () => {
  it("returns the assigned lane when that lane exists", () => {
    expect(resolveBoardLane({ workflowLane: LaneId.make("ready") }, LANES, RESOLUTION)).toBe(
      "ready",
    );
  });

  it("falls back to leftmost when workflowLane is null", () => {
    expect(resolveBoardLane({ workflowLane: null }, LANES, RESOLUTION)).toBe("triage");
  });

  it("falls back to leftmost when the assigned lane id is not in the registry", () => {
    expect(resolveBoardLane({ workflowLane: LaneId.make("retired") }, LANES, RESOLUTION)).toBe(
      "triage",
    );
  });

  it("places a snoozed thread in snoozed regardless of its assigned lane", () => {
    expect(
      resolveBoardLane(
        makeShell({
          workflowLane: LaneId.make("ready"),
          snoozedUntil: FUTURE_WAKE,
          snoozedAt: NOW,
        }),
        LANES,
        RESOLUTION,
      ),
    ).toBe(SNOOZED_BOARD_LANE_ID);
  });

  it("places a settled thread in settled regardless of its assigned lane", () => {
    expect(
      resolveBoardLane(
        makeShell({
          workflowLane: LaneId.make("ready"),
          settledOverride: "settled",
          settledAt: NOW,
        }),
        LANES,
        RESOLUTION,
      ),
    ).toBe(SETTLED_BOARD_LANE_ID);
  });

  it("prefers snoozed over settled when both apply", () => {
    expect(
      resolveBoardLane(
        makeShell({
          workflowLane: LaneId.make("ready"),
          settledOverride: "settled",
          settledAt: NOW,
          snoozedUntil: FUTURE_WAKE,
          snoozedAt: NOW,
        }),
        LANES,
        RESOLUTION,
      ),
    ).toBe(SNOOZED_BOARD_LANE_ID);
  });

  it("returns to the assigned lane once a snooze has elapsed", () => {
    expect(
      resolveBoardLane(
        makeShell({
          workflowLane: LaneId.make("ready"),
          snoozedUntil: PAST_WAKE,
          snoozedAt: PAST_WAKE,
        }),
        LANES,
        RESOLUTION,
      ),
    ).toBe("ready");
  });

  it("keeps assigned-lane-then-leftmost behaviour when neither lifecycle applies", () => {
    expect(
      resolveBoardLane(makeShell({ workflowLane: LaneId.make("ready") }), LANES, RESOLUTION),
    ).toBe("ready");
    expect(resolveBoardLane(makeShell({ workflowLane: null }), LANES, RESOLUTION)).toBe("triage");
  });

  it("falls back to the assigned lane when settled or snoozed lanes are missing from the registry", () => {
    expect(
      resolveBoardLane(
        makeShell({
          workflowLane: LaneId.make("ready"),
          settledOverride: "settled",
          settledAt: NOW,
        }),
        LANES_WITHOUT_LIFECYCLE,
        RESOLUTION,
      ),
    ).toBe("ready");
    expect(
      resolveBoardLane(
        makeShell({
          workflowLane: LaneId.make("ready"),
          snoozedUntil: FUTURE_WAKE,
          snoozedAt: NOW,
        }),
        LANES_WITHOUT_LIFECYCLE,
        RESOLUTION,
      ),
    ).toBe("ready");
  });
});

describe("leftmostLane", () => {
  it("picks lowest order and returns null for an empty registry", () => {
    expect(leftmostLane(LANES)).toBe("triage");
    expect(leftmostLane([])).toBeNull();
  });
});
