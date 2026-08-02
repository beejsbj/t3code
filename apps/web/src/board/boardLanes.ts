import {
  LaneId,
  type ChangeRequestState,
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
 * 1. **Runtime attention** (derived, native, never persisted). Interrupting
 *    attention — approval, input, failure, or plan review — temporarily
 *    displaces cards from move-policy lanes. Working cards stay in their
 *    assigned lane and show live status chrome. Badge-policy lanes keep every
 *    kind of attention in place. The assigned lane is never overwritten.
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
 * Placement options carry the clock, change-request state, and the same
 * persisted auto-settle setting used by the sidebar. Keeping them explicit
 * preserves deterministic tests and keeps this module independent of React
 * stores.
 */
export interface BoardPlacementOptions {
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  readonly changeRequestState: ChangeRequestState | null;
  readonly lanes: ReadonlyArray<LaneDefinition>;
}

export type BoardPlacementSource = "attention" | "assigned" | "native-done" | "inbox";

export interface BoardPlacement {
  /** `null` means the session is not in a persisted lane column. */
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
  /** Derived rail membership. The rail is never persisted or droppable. */
  readonly inNeedsYouRail: boolean;
}

export function resolveBoardPlacement(
  thread: BoardLaneInput,
  options: BoardPlacementOptions,
): BoardPlacement | null {
  const assignedLane = thread.workflowLane ?? null;
  const danglingLaneId =
    assignedLane !== null && !isWorkflowLane(assignedLane, options.lanes) ? assignedLane : null;
  const attention = resolveRuntimeAttention(thread);
  const interruptsPlacement =
    attention === "blocked" || attention === "failed" || attention === "review";
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

  // Done is the fixed drain outlet rather than a user-defined intent lane.
  // Once effective settlement applies, it wins over badge policy and runtime
  // attention so settled work cannot remain on the active board.
  if (
    effectiveSettled(thread as OrchestrationThreadShell, {
      now: options.now,
      autoSettleAfterDays: options.autoSettleAfterDays,
      changeRequestState: options.changeRequestState,
    })
  ) {
    return {
      lane: DONE_LANE,
      source: "native-done",
      assignedLane,
      danglingLaneId,
      attention,
      overridden: assignedLane !== null && assignedLane !== "done",
      heldInPlace: false,
      inNeedsYouRail: false,
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
      inNeedsYouRail: false,
    };
  }

  if (
    attention !== null &&
    !interruptsPlacement &&
    assignedLane !== null &&
    danglingLaneId === null
  ) {
    return {
      lane: assignedLane,
      source: "assigned",
      assignedLane,
      danglingLaneId,
      attention,
      overridden: false,
      heldInPlace: false,
      inNeedsYouRail: false,
    };
  }

  if (attention !== null) {
    return {
      lane: null,
      source: "attention",
      assignedLane,
      danglingLaneId,
      attention,
      overridden: assignedLane !== null && danglingLaneId === null,
      heldInPlace: false,
      inNeedsYouRail: true,
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
      inNeedsYouRail: false,
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
    inNeedsYouRail: false,
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
