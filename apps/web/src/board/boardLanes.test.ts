import { describe, expect, it } from "vite-plus/test";

import type { BoardLane } from "./boardLaneStore.ts";
import {
  isBoardFixedLaneId,
  isBoardWorkflowLane,
  adjacentBoardWorkflowLane,
  leftmostLane,
  orderBoardLanes,
  resolveBoardLane,
} from "./boardLanes.ts";

const LANES: ReadonlyArray<BoardLane> = [
  { id: "triage", name: "Triage", description: "Unplaced", order: 100 },
  { id: "ready", name: "Ready", description: "Ready", order: 1 },
  { id: "blocked", name: "Blocked", description: "Blocked", order: 0 },
];

describe("resolveBoardLane", () => {
  it("uses an explicit local placement when the local registry contains it", () => {
    expect(resolveBoardLane("ready", LANES)).toBe("ready");
  });

  it("puts never-placed or obsolete cards in the local leftmost lane", () => {
    expect(resolveBoardLane(undefined, LANES)).toBe("triage");
    expect(resolveBoardLane("archived-lane", LANES)).toBe("triage");
  });

  it("rejects obsolete board-lane placements from old local state", () => {
    expect(resolveBoardLane("snoozed", LANES)).toBe("triage");
    expect(resolveBoardLane("settled", LANES)).toBe("triage");
  });
});

describe("leftmostLane", () => {
  it("pins Triage left regardless of persisted order", () => {
    expect(leftmostLane(LANES)).toBe("triage");
  });

  it("falls back to the first ordered workflow lane for a malformed registry", () => {
    expect(leftmostLane(LANES.filter((lane) => lane.id !== "triage"))).toBe("blocked");
    expect(leftmostLane([])).toBeNull();
  });
});

describe("adjacentBoardWorkflowLane", () => {
  it("moves through the displayed local workflow lanes", () => {
    expect(adjacentBoardWorkflowLane("triage", LANES, "right")).toBe("blocked");
    expect(adjacentBoardWorkflowLane("blocked", LANES, "right")).toBe("ready");
    expect(adjacentBoardWorkflowLane("ready", LANES, "left")).toBe("blocked");
  });

  it("does not wrap at either workflow edge", () => {
    expect(adjacentBoardWorkflowLane("triage", LANES, "left")).toBeNull();
    expect(adjacentBoardWorkflowLane("ready", LANES, "right")).toBeNull();
  });
});

describe("board lane invariants", () => {
  it("pins Triage to the left of user-ordered workflow lanes", () => {
    expect(orderBoardLanes(LANES).map((lane) => lane.id)).toEqual(["triage", "blocked", "ready"]);
  });

  it("distinguishes fixed and workflow lanes", () => {
    expect(isBoardFixedLaneId("triage")).toBe(true);
    expect(isBoardFixedLaneId("ready")).toBe(false);
    expect(isBoardWorkflowLane(LANES.find((lane) => lane.id === "triage")!)).toBe(true);
  });
});
