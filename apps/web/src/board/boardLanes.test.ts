import { LaneId, type LaneDefinition, type WorkflowLane } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { leftmostLane, resolveBoardLane } from "./boardLanes.ts";

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
];

describe("resolveBoardLane", () => {
  it("returns the assigned lane when that lane exists", () => {
    expect(resolveBoardLane({ workflowLane: LaneId.make("ready") }, LANES)).toBe("ready");
  });

  it("falls back to leftmost when workflowLane is null", () => {
    expect(resolveBoardLane({ workflowLane: null }, LANES)).toBe("triage");
  });

  it("falls back to leftmost when the assigned lane id is not in the registry", () => {
    expect(resolveBoardLane({ workflowLane: LaneId.make("retired") }, LANES)).toBe("triage");
  });
});

describe("leftmostLane", () => {
  it("picks lowest order and returns null for an empty registry", () => {
    expect(leftmostLane(LANES)).toBe("triage");
    expect(leftmostLane([])).toBeNull();
  });
});
