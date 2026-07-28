import type { ContextMenuItem, WorkflowLane } from "@t3tools/contracts";

import { BOARD_LANES, boardLaneLabel, isWorkflowLane } from "./boardLanes.ts";

const PLACE_IN_LANE_PREFIX = "place-in-lane:";

export function buildBoardPlacementContextMenuItems(): ReadonlyArray<ContextMenuItem> {
  return [
    {
      id: "place-in-lane",
      label: "Place in lane…",
      children: BOARD_LANES.map((lane) => ({
        id: `${PLACE_IN_LANE_PREFIX}${lane.id}`,
        label: boardLaneLabel(lane.id),
      })),
    },
    { id: "remove-from-board", label: "Remove from board" },
  ];
}

export function workflowLaneForBoardPlacementAction(
  action: string | null,
): WorkflowLane | null | undefined {
  if (action === "remove-from-board") return null;
  if (action?.startsWith(PLACE_IN_LANE_PREFIX) !== true) return undefined;

  const lane = action.slice(PLACE_IN_LANE_PREFIX.length);
  return isWorkflowLane(lane) ? lane : undefined;
}
