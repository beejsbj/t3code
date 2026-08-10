import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "@t3tools/client-runtime/state/thread-settled";
import type { LaneDefinition, OrchestrationThreadShell, WorkflowLane } from "@t3tools/contracts";
import { LaneId } from "@t3tools/contracts";

/**
 * Lane model for the session board.
 *
 * A session sits in the lane a human placed it in, except for Settled and
 * Snoozed: those lifecycle lanes reflect `effectiveSettled` /
 * `effectiveSnoozed` without writing `workflowLane`. When a session wakes or
 * is un-settled it returns to its stored lane. Nothing else moves a card on
 * its own — no attention displacement and no automatic drain.
 *
 * A session that has never been placed — or whose lane was since deleted —
 * falls back to the leftmost lane, which the migration seeds as "Triage".
 * Triage is an ordinary lane; it can be renamed, reordered, or archived like
 * any other, and whatever ends up leftmost inherits the fallback.
 *
 * The only way a session leaves the board is archival or deletion, exactly as
 * in the sidebar.
 */

export const SETTLED_BOARD_LANE_ID = LaneId.make("settled");
export const SNOOZED_BOARD_LANE_ID = LaneId.make("snoozed");

export function isLifecycleBoardLane(laneId: WorkflowLane): boolean {
  return laneId === SETTLED_BOARD_LANE_ID || laneId === SNOOZED_BOARD_LANE_ID;
}

export function boardLaneCollapsedByDefault(laneId: WorkflowLane): boolean {
  return isLifecycleBoardLane(laneId);
}

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
export type BoardLaneInput = Pick<OrchestrationThreadShell, "workflowLane"> &
  Partial<
    Pick<
      OrchestrationThreadShell,
      | "settledOverride"
      | "settledAt"
      | "snoozedUntil"
      | "snoozedAt"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "session"
      | "latestTurn"
      | "latestUserMessageAt"
    >
  >;

export type BoardLaneResolutionOptions = {
  /** Clock for `effectiveSnoozed` (second-precision wakes). */
  readonly now: string;
  /** Clock for `effectiveSettled`; defaults to `now`. */
  readonly settledNow?: string | undefined;
  readonly autoSettleAfterDays: number | null;
  readonly changeRequestState?: ChangeRequestStateLike | null | undefined;
  readonly supportsSettlement?: boolean | undefined;
  readonly supportsSnooze?: boolean | undefined;
};

function resolveAssignedBoardLane(
  thread: BoardLaneInput,
  lanes: ReadonlyArray<LaneDefinition>,
): WorkflowLane | null {
  const assigned = thread.workflowLane ?? null;
  if (assigned !== null && isWorkflowLane(assigned, lanes)) {
    return assigned;
  }
  return leftmostLane(lanes);
}

/** The lane a card renders in. `null` only when no lanes exist at all. */
export function resolveBoardLane(
  thread: BoardLaneInput,
  lanes: ReadonlyArray<LaneDefinition>,
  options: BoardLaneResolutionOptions,
): WorkflowLane | null {
  const assignedLane = resolveAssignedBoardLane(thread, lanes);
  const supportsSnooze = options.supportsSnooze ?? true;
  const supportsSettlement = options.supportsSettlement ?? true;
  const settledNow = options.settledNow ?? options.now;

  if (
    supportsSnooze &&
    isWorkflowLane(SNOOZED_BOARD_LANE_ID, lanes) &&
    effectiveSnoozed(thread as OrchestrationThreadShell, { now: options.now })
  ) {
    return SNOOZED_BOARD_LANE_ID;
  }

  if (
    supportsSettlement &&
    isWorkflowLane(SETTLED_BOARD_LANE_ID, lanes) &&
    effectiveSettled(thread as OrchestrationThreadShell, {
      now: settledNow,
      autoSettleAfterDays: options.autoSettleAfterDays,
      changeRequestState: options.changeRequestState ?? null,
    })
  ) {
    return SETTLED_BOARD_LANE_ID;
  }

  return assignedLane;
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
