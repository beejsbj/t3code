import type { ScopedThreadRef } from "@t3tools/contracts";

import type { BoardLane, BoardLaneId } from "./boardLaneStore.ts";
import { resolveWorkflowBoardLane } from "./boardLanes.ts";

export type LocalBoardCommand =
  | { readonly type: "open-board" }
  | { readonly type: "move"; readonly laneId: BoardLaneId };

export type LocalBoardCommandResult =
  | { readonly type: "not-local" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "command"; readonly command: LocalBoardCommand };

/**
 * Local commands deliberately require the whole composer value. Anything
 * outside these two exact namespaces remains ordinary provider input.
 */
export function resolveLocalBoardCommand(
  text: string,
  lanes: ReadonlyArray<BoardLane>,
  threadRef: ScopedThreadRef | null,
): LocalBoardCommandResult {
  const trimmed = text.trim();
  if (/^\/board$/i.test(trimmed)) {
    return { type: "command", command: { type: "open-board" } };
  }

  const laneMatch = /^\/lane(?:\s+(.*))?$/i.exec(trimmed);
  if (!laneMatch) return { type: "not-local" };
  if (threadRef === null) {
    return {
      type: "error",
      message: "Open an existing thread before moving it to a board lane.",
    };
  }

  const argument = laneMatch[1]?.trim() ?? "";
  if (!argument) {
    return {
      type: "error",
      message: "Choose a lane from the menu, or enter /lane <lane name>.",
    };
  }

  const resolved = resolveWorkflowBoardLane(lanes, argument);
  if (resolved.type === "error") return resolved;
  return {
    type: "command",
    command: { type: "move", laneId: resolved.lane.id },
  };
}

export function localLaneChoiceQuery(slashQuery: string): string | null {
  const match = /^lane\s+(.*)$/i.exec(slashQuery);
  return match ? (match[1] ?? "").trim().toLocaleLowerCase() : null;
}
