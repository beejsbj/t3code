import type { ScopedThreadRef } from "@t3tools/contracts";

import type { BoardLane, BoardLaneId } from "./boardLaneStore.ts";
import { isBoardWorkflowLane, orderBoardLanes } from "./boardLanes.ts";

export type LocalBoardCommand =
  | { readonly type: "open-board" }
  | { readonly type: "place"; readonly laneId: BoardLaneId }
  | { readonly type: "unplace" };

export type LocalBoardCommandResult =
  | { readonly type: "not-local" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "command"; readonly command: LocalBoardCommand };

const UNPLACE_ARGUMENTS = new Set(["none", "remove", "unplace", "unplaced"]);

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function workflowBoardLanes(lanes: ReadonlyArray<BoardLane>): ReadonlyArray<BoardLane> {
  return orderBoardLanes(lanes).filter(isBoardWorkflowLane);
}

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
      message: "Open an existing thread before placing it in a board lane.",
    };
  }

  const argument = laneMatch[1]?.trim() ?? "";
  if (!argument) {
    return {
      type: "error",
      message: "Choose a lane from the menu, or enter /lane <lane name>.",
    };
  }

  const workflowLanes = workflowBoardLanes(lanes);
  const normalizedArgument = normalized(argument);
  const idMatch = workflowLanes.find((lane) => normalized(lane.id) === normalizedArgument);
  if (idMatch) {
    return { type: "command", command: { type: "place", laneId: idMatch.id } };
  }
  if (UNPLACE_ARGUMENTS.has(normalizedArgument)) {
    return { type: "command", command: { type: "unplace" } };
  }

  const nameMatches = workflowLanes.filter((lane) => normalized(lane.name) === normalizedArgument);
  if (nameMatches.length === 1) {
    return {
      type: "command",
      command: { type: "place", laneId: nameMatches[0]!.id },
    };
  }
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

export function localLaneChoiceQuery(slashQuery: string): string | null {
  const match = /^lane\s+(.*)$/i.exec(slashQuery);
  return match ? (match[1] ?? "").trim().toLocaleLowerCase() : null;
}
