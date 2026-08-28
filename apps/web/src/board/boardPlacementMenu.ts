import type { ContextMenuItem } from "@t3tools/contracts";

import type { BoardLane, BoardLaneId } from "./boardLaneStore.ts";
import { boardLaneLabel, isBoardLane, isBoardWorkflowLane, orderBoardLanes } from "./boardLanes.ts";

const MOVE_TO_LANE_PREFIX = "move-to-lane:";

export function buildBoardLaneMoveContextMenuItems(
  lanes: ReadonlyArray<BoardLane>,
): ReadonlyArray<ContextMenuItem> {
  const workflowLanes = orderBoardLanes(lanes).filter(isBoardWorkflowLane);
  return [
    {
      id: "move-to-lane",
      label: "Move to lane…",
      children: workflowLanes.map((lane) => ({
        id: `${MOVE_TO_LANE_PREFIX}${lane.id}`,
        label: boardLaneLabel(lane.id, lanes),
      })),
    },
  ];
}

export function boardLaneForMoveAction(
  action: string | null,
  lanes: ReadonlyArray<BoardLane>,
): BoardLaneId | undefined {
  if (action?.startsWith(MOVE_TO_LANE_PREFIX) !== true) return undefined;

  const lane = action.slice(MOVE_TO_LANE_PREFIX.length);
  if (!isBoardLane(lane, lanes)) return undefined;
  const targetLane = lanes.find((candidate) => candidate.id === lane);
  if (targetLane === undefined || !isBoardWorkflowLane(targetLane)) return undefined;
  return lane;
}
