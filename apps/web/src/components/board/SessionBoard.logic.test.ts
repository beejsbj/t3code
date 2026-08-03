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
  },
  {
    id: LaneId.make("ready"),
    name: "Ready",
    description: "Ready to start",
    order: 10,
  },
  {
    id: LaneId.make("done"),
    name: "Done",
    description: "Finished work",
    order: 20,
  },
];

describe("laneIdForName", () => {
  it("creates a readable unique lane id without exposing id as an authoring field", () => {
    expect(laneIdForName("To Review", lanes)).toBe("to-review");
    expect(laneIdForName("Ready", lanes)).toBe("ready-2");
  });
});

describe("nextLaneOrder", () => {
  it("places a new lane after the highest existing order", () => {
    expect(nextLaneOrder(lanes)).toBe(21);
  });
});

describe("reorderLaneUpdates", () => {
  it("swaps neighbouring lanes", () => {
    expect(reorderLaneUpdates(lanes, LaneId.make("ready"), "up")).toEqual([
      { laneId: LaneId.make("ready"), order: 0 },
      { laneId: LaneId.make("shaping"), order: 10 },
    ]);
    expect(reorderLaneUpdates(lanes, LaneId.make("done"), "down")).toEqual([]);
  });
});

describe("laneArchiveIntent", () => {
  it("requires member-aware confirmation before archiving a populated lane", () => {
    expect(laneArchiveIntent(LaneId.make("ready"), 3)).toEqual({
      kind: "confirm",
      memberCount: 3,
      explanation:
        "Archive this lane? Its 3 sessions will become unplaced and keep a lane removed note.",
    });
  });

  it("allows an empty lane to be archived immediately", () => {
    expect(laneArchiveIntent(LaneId.make("done"), 0)).toEqual({ kind: "archive" });
  });
});
