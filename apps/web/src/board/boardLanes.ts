import {
  TRIAGE_BOARD_LANE_ID,
  type BoardLane,
  type BoardLaneId,
  isObsoleteBoardLaneId,
} from "./boardLaneStore.ts";

export function isBoardFixedLaneId(laneId: BoardLaneId): boolean {
  return laneId === TRIAGE_BOARD_LANE_ID;
}

/** Triage is a fixed-position workflow lane. */
export function isBoardWorkflowLane(lane: BoardLane): boolean {
  return !isObsoleteBoardLaneId(lane.id);
}

export function workflowBoardLanes(lanes: ReadonlyArray<BoardLane>): ReadonlyArray<BoardLane> {
  return orderBoardLanes(lanes).filter(isBoardWorkflowLane);
}

export type WorkflowBoardLaneResolution =
  | { readonly type: "lane"; readonly lane: BoardLane }
  | { readonly type: "error"; readonly message: string };

/** Resolve a live workflow lane by ID, then by an unambiguous exact name. */
export function resolveWorkflowBoardLane(
  lanes: ReadonlyArray<BoardLane>,
  argument: string,
): WorkflowBoardLaneResolution {
  const normalizedArgument = argument.trim().toLocaleLowerCase();
  const workflowLanes = workflowBoardLanes(lanes);
  const idMatch = workflowLanes.find(
    (lane) => lane.id.trim().toLocaleLowerCase() === normalizedArgument,
  );
  if (idMatch) return { type: "lane", lane: idMatch };

  const nameMatches = workflowLanes.filter(
    (lane) => lane.name.trim().toLocaleLowerCase() === normalizedArgument,
  );
  if (nameMatches.length === 1) return { type: "lane", lane: nameMatches[0]! };
  if (nameMatches.length > 1) {
    return {
      type: "error",
      message: `More than one lane is named “${argument}”. Use a lane ID: ${nameMatches
        .map((lane) => lane.id)
        .join(", ")}.`,
    };
  }
  return {
    type: "error",
    message: `No workflow lane matches “${argument}”. Type /lane to choose from current lanes.`,
  };
}

/**
 * One canonical column order: fixed Triage, then user-ordered workflow.
 * Persisted `order` values never move Triage.
 */
export function orderBoardLanes(lanes: ReadonlyArray<BoardLane>): ReadonlyArray<BoardLane> {
  const triage = lanes.find((lane) => lane.id === TRIAGE_BOARD_LANE_ID);
  const workflow = lanes
    .filter((lane) => !isBoardFixedLaneId(lane.id) && !isObsoleteBoardLaneId(lane.id))
    .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return [...(triage === undefined ? [] : [triage]), ...workflow];
}

/**
 * Resolves a thread's effective workflow lane. Missing local override state
 * means Triage; it never means the thread is absent from the board.
 */
export function resolveBoardLane(
  placement: BoardLaneId | undefined,
  lanes: ReadonlyArray<BoardLane>,
): BoardLaneId | null {
  if (
    placement !== undefined &&
    !isObsoleteBoardLaneId(placement) &&
    lanes.some((lane) => lane.id === placement)
  ) {
    return placement;
  }
  return leftmostLane(lanes);
}

/** Triage wins; malformed registries fall back to the first ordered workflow lane. */
export function leftmostLane(lanes: ReadonlyArray<BoardLane>): BoardLaneId | null {
  return orderBoardLanes(lanes).find(isBoardWorkflowLane)?.id ?? null;
}

/**
 * Finds the neighboring displayed workflow lane.
 */
export function adjacentBoardWorkflowLane(
  laneId: BoardLaneId,
  lanes: ReadonlyArray<BoardLane>,
  direction: "left" | "right",
): BoardLaneId | null {
  const workflowLanes = orderBoardLanes(lanes).filter(isBoardWorkflowLane);
  const laneIndex = workflowLanes.findIndex((lane) => lane.id === laneId);
  const adjacent = workflowLanes[laneIndex + (direction === "left" ? -1 : 1)];
  return adjacent?.id ?? null;
}

export function boardLaneLabel(laneId: BoardLaneId, lanes: ReadonlyArray<BoardLane>): string {
  return lanes.find((lane) => lane.id === laneId)?.name ?? laneId;
}

export function isBoardLane(value: string, lanes: ReadonlyArray<BoardLane>): value is BoardLaneId {
  return lanes.some((lane) => lane.id === value);
}
