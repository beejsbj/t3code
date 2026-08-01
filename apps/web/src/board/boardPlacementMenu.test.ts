import { LaneId, type LaneDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildBoardPlacementContextMenuItems,
  workflowLaneForBoardPlacementAction,
} from "./boardPlacementMenu.ts";

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
];

describe("board placement context menu", () => {
  it("offers every board lane in a placement submenu and removal", () => {
    expect(buildBoardPlacementContextMenuItems(LANES)).toEqual([
      {
        id: "place-in-lane",
        label: "Place in lane…",
        children: LANES.map((lane) => ({
          id: `place-in-lane:${lane.id}`,
          label: lane.name,
        })),
      },
      { id: "remove-from-board", label: "Remove from board" },
    ]);
  });

  it.each(LANES)("maps the $id placement action to its lane", (lane) => {
    expect(workflowLaneForBoardPlacementAction(`place-in-lane:${lane.id}`, LANES)).toBe(lane.id);
  });

  it("maps removal to null and ignores unrelated actions", () => {
    expect(workflowLaneForBoardPlacementAction("remove-from-board", LANES)).toBeNull();
    expect(workflowLaneForBoardPlacementAction("rename", LANES)).toBeUndefined();
    expect(workflowLaneForBoardPlacementAction("place-in-lane:retired", LANES)).toBeUndefined();
  });
});
