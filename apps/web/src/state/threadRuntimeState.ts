import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { isLatestTurnSettled } from "../session-logic";

export type ThreadRuntimeState =
  | "approval"
  | "input"
  | "working"
  | "connecting"
  | "failed"
  | "plan-ready"
  | "idle";

export type ThreadRuntimeStateInput = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session"
> &
  Partial<
    Pick<OrchestrationThreadShell, "hasActionableProposedPlan" | "interactionMode" | "latestTurn">
  >;

/** Canonical precedence for native thread runtime state. */
export function resolveThreadRuntimeState(thread: ThreadRuntimeStateInput): ThreadRuntimeState {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";

  if (thread.session?.status === "running") return "working";
  if (thread.session?.status === "starting") return "connecting";
  if (thread.session?.status === "error") return "failed";

  if (
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn ?? null, thread.session) &&
    thread.hasActionableProposedPlan
  ) {
    return "plan-ready";
  }

  return "idle";
}
