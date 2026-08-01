import {
  LaneId,
  type LaneDefinition,
  type OrchestrationThreadShell,
  type WorkflowLane,
} from "@t3tools/contracts";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";

import { resolveThreadRuntimeState } from "../state/threadRuntimeState.ts";

/**
 * Lane model for the live session board.
 *
 * ## State precedence
 *
 * A card's lane is decided by native lifecycle state plus persisted intent:
 *
 * 1. **Runtime attention** (derived, native, never persisted). If the session
 *    is currently doing something a human must see — it is running, or it is
 *    blocked waiting on an approval / an answer / a plan decision — that fact
 *    temporarily displaces cards from move-policy lanes. Badge-policy lanes
 *    keep the card in place and expose the attention there instead. The
 *    assigned lane underneath is never overwritten.
 * 2. **Assigned lane** (`thread.workflowLane`, session-owned, persisted). This
 *    is what a drag/drop writes, and the only thing a drag/drop writes.
 *
 * If neither applies (no attention, never placed) the session is in the inbox:
 * `placement.lane === null`, and it renders in the source queue rather than on
 * a lane.
 *
 * Why one persisted field is needed at all: every *runtime* lane on this board
 * is already derivable from native session state, effective settlement, or
 * snooze. What is NOT derivable is human intent —
 * "still shaping this" versus "groomed, ready to pick up" are the same thing to
 * the runtime (idle session, nothing pending), and a drag gesture is a
 * statement no runtime signal can stand in for. That gap, and only that gap, is
 * what `workflowLane` stores.
 */

const ACTIVE_LANE = LaneId.make("active");
const BLOCKED_LANE = LaneId.make("blocked");
const REVIEW_LANE = LaneId.make("review");
const DONE_LANE = LaneId.make("done");

export function isWorkflowLane(
  value: string,
  lanes: ReadonlyArray<LaneDefinition>,
): value is WorkflowLane {
  return lanes.some((lane) => lane.id === value);
}

export function boardLaneLabel(lane: WorkflowLane, lanes: ReadonlyArray<LaneDefinition>): string {
  return lanes.find((entry) => entry.id === lane)?.name ?? lane;
}

export function boardLaneInterruptPolicy(
  lane: WorkflowLane,
  lanes: ReadonlyArray<LaneDefinition>,
): "move" | "badge" {
  return lanes.find((entry) => entry.id === lane)?.interrupt ?? "move";
}

/**
 * The subset of a thread shell the lane model reads. Kept as a structural
 * `Pick` so board logic can be unit-tested without constructing a whole
 * `OrchestrationThreadShell`, and so callers can pass a full shell directly.
 */
export type BoardLaneInput = Pick<
  OrchestrationThreadShell,
  | "session"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestTurn"
  | "latestUserMessageAt"
  | "archivedAt"
  | "settledOverride"
  | "settledAt"
  | "snoozedUntil"
> & {
  readonly workflowLane?: WorkflowLane | null | undefined;
};

/**
 * Runtime attention, derived purely from native session state.
 *
 * Ordered most-urgent first: a session that is both blocked and nominally
 * running is blocked — the human is the bottleneck, not the agent.
 */
export type RuntimeAttention = "blocked" | "active" | "failed" | "review" | null;

export function resolveRuntimeAttention(thread: BoardLaneInput): RuntimeAttention {
  switch (resolveThreadRuntimeState(thread)) {
    case "approval":
    case "input":
      return "blocked";
    case "working":
    case "connecting":
      return "active";
    case "failed":
      return "failed";
    case "plan-ready":
      return "review";
    case "idle":
      return null;
  }
}

/**
 * Lanes split into two classes, and the distinction is what keeps the model
 * honest:
 *
 * Registry lanes describe what a human decided. The derived attention ids
 * (`active`, `blocked`, `review`) are not registry lanes; they survive only as
 * a compact placement concept until the Needs-you rail replaces them.
 * Keeping that concept independent preserves precedence without pretending
 * derived states are droppable workflow lanes.
 */
export const ATTENTION_LANES: ReadonlySet<WorkflowLane> = new Set([
  ACTIVE_LANE,
  BLOCKED_LANE,
  REVIEW_LANE,
]);

export function isAttentionLane(lane: WorkflowLane): boolean {
  return ATTENTION_LANES.has(lane);
}

/**
 * Placement options carry the clock and the same persisted auto-settle setting
 * used by the sidebar. Keeping them explicit preserves deterministic tests and
 * keeps this module independent of React stores.
 */
export interface BoardPlacementOptions {
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  readonly lanes: ReadonlyArray<LaneDefinition>;
}

export type BoardPlacementSource = "attention" | "assigned" | "native-done" | "inbox";

export interface BoardPlacement {
  /** `null` means the session is in the inbox/source queue, not on a lane. */
  readonly lane: WorkflowLane | null;
  readonly source: BoardPlacementSource;
  /** The persisted, human-assigned lane — unchanged by attention overrides. */
  readonly assignedLane: WorkflowLane | null;
  /** Persisted lane id absent from the live registry, retained for later UI. */
  readonly danglingLaneId: WorkflowLane | null;
  readonly attention: RuntimeAttention;
  /** True when runtime attention is displacing the card from its assigned lane. */
  readonly overridden: boolean;
  /** True when a badge-policy lane is keeping runtime attention in place. */
  readonly heldInPlace: boolean;
}

export function resolveBoardPlacement(
  thread: BoardLaneInput,
  options: BoardPlacementOptions,
): BoardPlacement | null {
  const assignedLane = thread.workflowLane ?? null;
  const danglingLaneId =
    assignedLane !== null && !isWorkflowLane(assignedLane, options.lanes) ? assignedLane : null;
  const attention = resolveRuntimeAttention(thread);
  const holdsAttention =
    assignedLane !== null &&
    danglingLaneId === null &&
    boardLaneInterruptPolicy(assignedLane, options.lanes) === "badge";

  // Keep snooze suppression in the pure placement model rather than in the
  // React list filter. `null` is distinct from an inbox placement and makes
  // every board consumer obey the same wake / raise-the-hand rule.
  const snoozedUntilMs = thread.snoozedUntil == null ? Number.NaN : Date.parse(thread.snoozedUntil);
  if (
    attention === null &&
    !Number.isNaN(snoozedUntilMs) &&
    snoozedUntilMs > Date.parse(options.now)
  ) {
    return null;
  }

  // Blocking or failed attention outranks everything, including settled. A
  // session holding an approval or exposing a failure needs a human now;
  // burying it under Done is exactly the failure this board exists to prevent.
  // (The server already refuses to settle a thread with pending work, so this
  // is a belt-and-braces ordering rather than a common case.)
  if ((attention === "blocked" || attention === "failed") && !holdsAttention) {
    return {
      lane: BLOCKED_LANE,
      source: "attention",
      assignedLane,
      danglingLaneId,
      attention,
      overridden: assignedLane !== null && assignedLane !== "blocked",
      heldInPlace: false,
    };
  }

  if (
    effectiveSettled(thread as OrchestrationThreadShell, {
      now: options.now,
      autoSettleAfterDays: options.autoSettleAfterDays,
    })
  ) {
    return {
      lane: isWorkflowLane(DONE_LANE, options.lanes) ? DONE_LANE : null,
      source: "native-done",
      assignedLane,
      danglingLaneId,
      attention,
      overridden: assignedLane !== null && assignedLane !== "done",
      heldInPlace: false,
    };
  }

  if (attention !== null && assignedLane !== null && holdsAttention) {
    return {
      lane: assignedLane,
      source: "assigned",
      assignedLane,
      danglingLaneId,
      attention,
      overridden: false,
      heldInPlace: true,
    };
  }

  if (attention !== null) {
    return {
      lane: attention === "failed" ? BLOCKED_LANE : LaneId.make(attention),
      source: "attention",
      assignedLane,
      danglingLaneId,
      attention,
      overridden: assignedLane !== null && assignedLane !== attention,
      heldInPlace: false,
    };
  }

  if (assignedLane !== null && danglingLaneId === null) {
    return {
      lane: assignedLane,
      source: "assigned",
      assignedLane,
      danglingLaneId,
      attention,
      overridden: false,
      heldInPlace: false,
    };
  }

  return {
    lane: null,
    source: "inbox",
    assignedLane,
    danglingLaneId,
    attention,
    overridden: false,
    heldInPlace: false,
  };
}

/**
 * Short human-readable reason a card is sitting where it is. Rendered on the
 * card so the precedence rule is visible in the product, not just in a doc.
 */
export function placementReason(
  placement: BoardPlacement,
  lanes: ReadonlyArray<LaneDefinition>,
): string | null {
  switch (placement.source) {
    case "attention":
      return placement.overridden
        ? `Held here while ${attentionLabel(placement.attention)} — assigned to ${
            placement.assignedLane === null
              ? "inbox"
              : boardLaneLabel(placement.assignedLane, lanes)
          }`
        : attentionLabel(placement.attention);
    case "native-done":
      return "Settled";
    case "assigned":
      if (placement.heldInPlace) {
        return `${attentionLabel(placement.attention)} — held here: this lane keeps your attention`;
      }
      return null;
    case "inbox":
      return null;
  }
}

function attentionLabel(attention: RuntimeAttention): string {
  switch (attention) {
    case "blocked":
      return "waiting on you";
    case "active":
      return "the agent is working";
    case "failed":
      return "the session failed";
    case "review":
      return "a plan is waiting for review";
    case null:
      return "";
  }
}
