import type { ContextMenuItem, LaneDefinition, WorkflowLane } from "@t3tools/contracts";

import { boardLaneLabel, isLifecycleBoardLane, isWorkflowLane } from "./boardLanes.ts";

const PLACE_IN_LANE_PREFIX = "place-in-lane:";

export function buildBoardPlacementContextMenuItems(
  lanes: ReadonlyArray<LaneDefinition>,
): ReadonlyArray<ContextMenuItem> {
  return [
    {
      id: "place-in-lane",
      label: "Place in lane…",
      children: lanes
        .filter((lane) => !isLifecycleBoardLane(lane.id))
        .map((lane) => ({
          id: `${PLACE_IN_LANE_PREFIX}${lane.id}`,
          label: boardLaneLabel(lane.id, lanes),
        })),
    },
    { id: "remove-from-board", label: "Remove from board" },
  ];
}

export function workflowLaneForBoardPlacementAction(
  action: string | null,
  lanes: ReadonlyArray<LaneDefinition>,
): WorkflowLane | null | undefined {
  if (action === "remove-from-board") return null;
  if (action?.startsWith(PLACE_IN_LANE_PREFIX) !== true) return undefined;

  const lane = action.slice(PLACE_IN_LANE_PREFIX.length);
  if (!isWorkflowLane(lane, lanes)) return undefined;
  if (isLifecycleBoardLane(lane)) return undefined;
  return lane;
}
