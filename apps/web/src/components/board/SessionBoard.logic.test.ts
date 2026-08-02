import { LaneId, type LaneDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  laneArchiveIntent,
  laneIdForName,
  nextLaneOrder,
  reorderLaneUpdates,
} from "./SessionBoard.logic.ts";

const lanes: ReadonlyArray<LaneDefinition> = [
  {
    id: LaneId.make("shaping"),
    name: "Shaping",
    description: "Work out the shape",
    order: 0,
    interrupt: "badge",
  },
  {
    id: LaneId.make("ready"),
    name: "Ready",
    description: "Ready to start",
    order: 10,
    interrupt: "move",
  },
  {
    id: LaneId.make("done"),
    name: "Done",
    description: "Settled sessions drain here",
    order: 20,
    interrupt: "move",
  },
];

describe("laneIdForName", () => {
  it("creates a readable unique lane id without exposing id as an authoring field", () => {
    expect(laneIdForName("To Review", lanes)).toBe("to-review");
    expect(laneIdForName("Ready", lanes)).toBe("ready-2");
  });
});

describe("nextLaneOrder", () => {
  it("places a new intent lane after existing intent lanes while Done remains fixed", () => {
    expect(nextLaneOrder(lanes)).toBe(11);
  });
});

describe("reorderLaneUpdates", () => {
  it("swaps neighbouring intent lanes and never reorders Done", () => {
    expect(reorderLaneUpdates(lanes, LaneId.make("ready"), "up")).toEqual([
      { laneId: LaneId.make("ready"), order: 0 },
      { laneId: LaneId.make("shaping"), order: 10 },
    ]);
    expect(reorderLaneUpdates(lanes, LaneId.make("ready"), "down")).toEqual([]);
    expect(reorderLaneUpdates(lanes, LaneId.make("done"), "up")).toEqual([]);
  });
});

describe("laneArchiveIntent", () => {
  it("blocks archiving Done because it is the board drain outlet", () => {
    expect(laneArchiveIntent(LaneId.make("done"), 4)).toEqual({
      kind: "blocked",
      explanation:
        "Done is the board's drain outlet. It cannot be archived because settled sessions must remain visible.",
    });
  });

  it("requires member-aware confirmation before archiving a populated lane", () => {
    expect(laneArchiveIntent(LaneId.make("ready"), 3)).toEqual({
      kind: "confirm",
      memberCount: 3,
      explanation:
        "Archive this lane? Its 3 sessions will become unplaced and keep a lane removed note.",
    });
  });

  it("allows an empty non-Done lane to be archived immediately", () => {
    expect(laneArchiveIntent(LaneId.make("ready"), 0)).toEqual({ kind: "archive" });
  });
});
