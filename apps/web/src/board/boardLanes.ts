import type { LaneDefinition, WorkflowLane } from "@t3tools/contracts";

/**
 * Lane model for the session board.
 *
 * A session sits in the lane it was put in. Nothing else moves it. There is no
 * derived placement, no attention displacement, and no automatic drain: the
 * board shows intent, and intent is only ever written by a human drag or an
 * explicit command.
 *
 * A session that has never been placed — or whose lane was since deleted —
 * falls back to the leftmost lane, which the migration seeds as "Triage".
 * Triage is an ordinary lane; it can be renamed, reordered, or archived like
 * any other, and whatever ends up leftmost inherits the fallback.
 *
 * The only way a session leaves the board is archival or deletion, exactly as
 * in the sidebar.
 */

export function isWorkflowLane(
  value: string,
  lanes: ReadonlyArray<LaneDefinition>,
): value is WorkflowLane {
  return lanes.some((lane) => lane.id === value);
}

export function boardLaneLabel(lane: WorkflowLane, lanes: ReadonlyArray<LaneDefinition>): string {
  return lanes.find((entry) => entry.id === lane)?.name ?? lane;
}

/**
 * The subset of a thread the lane model reads. Structural so board logic stays
 * unit-testable without building a whole `OrchestrationThreadShell`, and so
 * callers can pass a full shell directly.
 */
export type BoardLaneInput = {
  readonly workflowLane?: WorkflowLane | null | undefined;
};

/** The lane a card renders in. `null` only when no lanes exist at all. */
export function resolveBoardLane(
  thread: BoardLaneInput,
  lanes: ReadonlyArray<LaneDefinition>,
): WorkflowLane | null {
  const assigned = thread.workflowLane ?? null;
  if (assigned !== null && isWorkflowLane(assigned, lanes)) {
    return assigned;
  }
  return leftmostLane(lanes);
}

/**
 * Lowest `order` wins; ties keep registry order so the fallback is stable
 * across renders.
 */
export function leftmostLane(lanes: ReadonlyArray<LaneDefinition>): WorkflowLane | null {
  let leftmost: LaneDefinition | null = null;
  for (const lane of lanes) {
    if (leftmost === null || lane.order < leftmost.order) {
      leftmost = lane;
    }
  }
  return leftmost?.id ?? null;
}
