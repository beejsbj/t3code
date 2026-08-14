import type { ThreadRuntimeState } from "../../state/threadRuntimeState.ts";

export type BoardCardVisualState = ThreadRuntimeState | "done";

/** A board visit acknowledges exactly the completed turn currently on screen. */
export function boardCardVisitTimestamp(thread: {
  readonly latestTurn: { readonly completedAt: string | null } | null;
}): string | null {
  return thread.latestTurn?.completedAt ?? null;
}

/** Seen idle threads have no sidebar status glyph; unseen completions still show Done. */
export function shouldShowBoardStatusIcon(status: BoardCardVisualState): boolean {
  return status !== "idle";
}

export interface BoardTimelineFollowCancellation {
  readonly cancelled: boolean;
  readonly leftEndBand: boolean;
}

export function resolveBoardTimelineFollowCancellation(input: {
  readonly state: BoardTimelineFollowCancellation;
  readonly isAtEnd: boolean;
  readonly explicitReturn?: boolean;
}): BoardTimelineFollowCancellation {
  if (!input.state.cancelled) return input.state;
  if (!input.isAtEnd) return { cancelled: true, leftEndBand: true };
  if (input.state.leftEndBand || input.explicitReturn === true) {
    return { cancelled: false, leftEndBand: false };
  }
  return input.state;
}
