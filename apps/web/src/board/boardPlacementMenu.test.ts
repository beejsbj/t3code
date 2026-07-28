import { describe, expect, it } from "vite-plus/test";

import { BOARD_LANES } from "./boardLanes.ts";
import {
  buildBoardPlacementContextMenuItems,
  workflowLaneForBoardPlacementAction,
} from "./boardPlacementMenu.ts";

describe("board placement context menu", () => {
  it("offers every board lane in a placement submenu and removal", () => {
    expect(buildBoardPlacementContextMenuItems()).toEqual([
      {
        id: "place-in-lane",
        label: "Place in lane…",
        children: BOARD_LANES.map((lane) => ({
          id: `place-in-lane:${lane.id}`,
          label: lane.label,
        })),
      },
      { id: "remove-from-board", label: "Remove from board" },
    ]);
  });

  it.each(BOARD_LANES)("maps the $id placement action to its lane", (lane) => {
    expect(workflowLaneForBoardPlacementAction(`place-in-lane:${lane.id}`)).toBe(lane.id);
  });

  it("maps removal to null and ignores unrelated actions", () => {
    expect(workflowLaneForBoardPlacementAction("remove-from-board")).toBeNull();
    expect(workflowLaneForBoardPlacementAction("rename")).toBeUndefined();
  });
});
