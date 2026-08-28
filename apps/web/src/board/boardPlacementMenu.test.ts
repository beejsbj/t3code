import { describe, expect, it } from "vite-plus/test";

import type { BoardLane } from "./boardLaneStore.ts";
import {
  boardLaneForMoveAction,
  buildBoardLaneMoveContextMenuItems,
} from "./boardPlacementMenu.ts";

const LANES: ReadonlyArray<BoardLane> = [
  { id: "settled", name: "Settled", description: "Finished", order: -10 },
  { id: "triage", name: "Triage", description: "New", order: 100 },
  { id: "shaping", name: "Grilling / shaping", description: "Shape it", order: 0 },
  { id: "ready", name: "Ready", description: "Ready", order: 1 },
  { id: "snoozed", name: "Snoozed", description: "Later", order: -20 },
];

const WORKFLOW_LANES = [LANES[1]!, LANES[2]!, LANES[3]!];

describe("board lane move context menu", () => {
  it("offers ordered workflow lanes without lifecycle or removal actions", () => {
    expect(buildBoardLaneMoveContextMenuItems(LANES)).toEqual([
      {
        id: "move-to-lane",
        label: "Move to lane…",
        children: WORKFLOW_LANES.map((lane) => ({
          id: `move-to-lane:${lane.id}`,
          label: lane.name,
        })),
      },
    ]);
  });

  it.each(WORKFLOW_LANES)("maps the $id move action to its local lane", (lane) => {
    expect(boardLaneForMoveAction(`move-to-lane:${lane.id}`, LANES)).toBe(lane.id);
  });

  it("ignores lifecycle, removed, stale, and unrelated actions", () => {
    expect(boardLaneForMoveAction("remove-from-board", LANES)).toBeUndefined();
    expect(boardLaneForMoveAction("move-to-lane:snoozed", LANES)).toBeUndefined();
    expect(boardLaneForMoveAction("move-to-lane:settled", LANES)).toBeUndefined();
    expect(boardLaneForMoveAction("rename", LANES)).toBeUndefined();
    expect(boardLaneForMoveAction("move-to-lane:retired", LANES)).toBeUndefined();
  });
});
