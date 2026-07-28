import type { OrchestrationThreadShell, WorkflowLane } from "@t3tools/contracts";
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

export const BOARD_LANES = [
  {
    id: "shaping",
    label: "Grilling / shaping",
    hint: "Working out what this actually is",
    interrupt: "badge",
  },
  {
    id: "ready",
    label: "Ready",
    hint: "Groomed and ready to pick up",
    interrupt: "move",
  },
  {
    id: "active",
    label: "Active",
    hint: "The agent is working right now",
    interrupt: "move",
  },
  {
    id: "blocked",
    label: "Blocked · needs Burooj",
    hint: "Waiting on a human decision",
    interrupt: "move",
  },
  {
    id: "review",
    label: "Review",
    hint: "There is something to look at",
    interrupt: "move",
  },
  {
    id: "done",
    label: "Done",
    hint: "Finished, or pinned settled",
    interrupt: "move",
  },
] as const satisfies ReadonlyArray<{
  readonly id: WorkflowLane;
  readonly label: string;
  readonly hint: string;
  readonly interrupt: "move" | "badge";
}>;

export type BoardLane = (typeof BOARD_LANES)[number];

export const BOARD_LANE_IDS: ReadonlyArray<WorkflowLane> = BOARD_LANES.map((lane) => lane.id);

export function isWorkflowLane(value: string): value is WorkflowLane {
  return (BOARD_LANE_IDS as ReadonlyArray<string>).includes(value);
}

export function boardLaneLabel(lane: WorkflowLane): string {
  return BOARD_LANES.find((entry) => entry.id === lane)?.label ?? lane;
}

export function boardLaneInterruptPolicy(lane: WorkflowLane): "move" | "badge" {
  return BOARD_LANES.find((entry) => entry.id === lane)?.interrupt ?? "move";
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
 * - **Intent lanes** (`shaping`, `ready`, `done`) describe what a human decided.
 *   Nothing in the runtime can produce or contradict them.
 * - **Attention lanes** (`active`, `blocked`, `review`) describe what the
 *   session is doing right now. The runtime is the authority on these.
 *
 * A human may still drag a card into an attention lane — the board would be
 * annoying otherwise — but a card sitting in `active` because someone dragged
 * it there is *not* the same claim as a card in `active` because the agent is
 * running. `placement.source` distinguishes them and the card says which it is.
 */
export const ATTENTION_LANES: ReadonlySet<WorkflowLane> = new Set(["active", "blocked", "review"]);

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
}

export type BoardPlacementSource = "attention" | "assigned" | "native-done" | "inbox";

export interface BoardPlacement {
  /** `null` means the session is in the inbox/source queue, not on a lane. */
  readonly lane: WorkflowLane | null;
  readonly source: BoardPlacementSource;
  /** The persisted, human-assigned lane — unchanged by attention overrides. */
  readonly assignedLane: WorkflowLane | null;
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
  const attention = resolveRuntimeAttention(thread);
  const holdsAttention =
    assignedLane !== null && boardLaneInterruptPolicy(assignedLane) === "badge";

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
      lane: "blocked",
      source: "attention",
      assignedLane,
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
      lane: "done",
      source: "native-done",
      assignedLane,
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
      attention,
      overridden: false,
      heldInPlace: true,
    };
  }

  if (attention !== null) {
    return {
      lane: attention === "failed" ? "blocked" : attention,
      source: "attention",
      assignedLane,
      attention,
      overridden: assignedLane !== null && assignedLane !== attention,
      heldInPlace: false,
    };
  }

  if (assignedLane !== null) {
    return {
      lane: assignedLane,
      source: "assigned",
      assignedLane,
      attention,
      overridden: false,
      heldInPlace: false,
    };
  }

  return {
    lane: null,
    source: "inbox",
    assignedLane: null,
    attention,
    overridden: false,
    heldInPlace: false,
  };
}

/**
 * Short human-readable reason a card is sitting where it is. Rendered on the
 * card so the precedence rule is visible in the product, not just in a doc.
 */
export function placementReason(placement: BoardPlacement): string | null {
  switch (placement.source) {
    case "attention":
      return placement.overridden
        ? `Held here while ${attentionLabel(placement.attention)} — assigned to ${
            placement.assignedLane === null ? "inbox" : boardLaneLabel(placement.assignedLane)
          }`
        : attentionLabel(placement.attention);
    case "native-done":
      return "Settled";
    case "assigned":
      if (placement.heldInPlace) {
        return `${attentionLabel(placement.attention)} — held here: this lane keeps your attention`;
      }
      // A card parked in an attention lane by hand is not the same claim as a
      // card the runtime put there. Say so, or the board lies about what the
      // session is doing.
      return placement.assignedLane !== null && isAttentionLane(placement.assignedLane)
        ? "Placed here by hand — the session is idle"
        : null;
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
