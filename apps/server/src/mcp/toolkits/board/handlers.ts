import { CommandId, type LaneDefinition } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { OrchestrationDispatchError } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionLaneRepository } from "../../../persistence/Services/ProjectionLanes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type BoardToolkit,
  SetBoardLaneError,
  type SetBoardLaneInput,
  type SetBoardLaneResult,
} from "./tools.ts";

const USER_PLACEMENT_REFUSAL =
  "The user placed this session on the board, so it was not moved. Leave their placement alone; if it looks wrong, say so in your reply instead.";

/**
 * Lane creation is human-only by design: a board is only worth glancing at if
 * its geography is stable, and an agent minting columns destroys that. So an
 * unknown lane is a hard error that hands back the real list rather than a
 * silent create.
 */
export function unknownLaneMessage(laneId: string, lanes: ReadonlyArray<LaneDefinition>): string {
  if (lanes.length === 0) {
    return `There is no lane '${laneId}'. This board has no lanes at all, so there is nowhere to file this session. Only the user can create a lane.`;
  }
  const valid = lanes.map((lane) => `'${lane.id}'`).join(", ");
  return `There is no lane '${laneId}'. The lanes on this board are: ${valid}. This tool cannot create a lane — only the user can. If none of these fits, leave the session unplaced and say so.`;
}

export function toSetBoardLaneError(cause: OrchestrationDispatchError): SetBoardLaneError {
  if (
    cause._tag === "OrchestrationCommandInvariantError" &&
    cause.detail.includes("user placement")
  ) {
    return new SetBoardLaneError({
      reason: "user-placement-wins",
      detail: USER_PLACEMENT_REFUSAL,
    });
  }
  return new SetBoardLaneError({
    reason: "refused",
    detail: `The board placement was refused: ${cause.message}`,
  });
}

export function normalizePlacementReason(reason: string | undefined): string | null {
  const trimmed = reason?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

// Command ids must be unique per call: the engine deduplicates by receipt, so a
// stable id would silently swallow a genuine second placement.
let placementCommandSequence = 0;
const nextPlacementCommandId = (providerSessionId: string) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((millis) => {
      placementCommandSequence += 1;
      return CommandId.make(
        `mcp:set-board-lane:${providerSessionId}:${millis}:${placementCommandSequence}`,
      );
    }),
  );

export const handleSetBoardLane = Effect.fn("BoardToolkit.set_board_lane")(function* (
  input: SetBoardLaneInput,
) {
  // Thread identity is ambient. Nothing the agent sends can change which
  // session gets filed.
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const laneRepository = yield* ProjectionLaneRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const lanes = yield* laneRepository.listAll().pipe(
    Effect.mapError(
      (cause) =>
        new SetBoardLaneError({
          reason: "registry-unavailable",
          detail: `The board lane registry could not be read: ${cause.message}`,
        }),
    ),
  );

  const lane = lanes.find((entry) => entry.id === input.laneId);
  if (lane === undefined) {
    return yield* new SetBoardLaneError({
      reason: "unknown-lane",
      detail: unknownLaneMessage(input.laneId, lanes),
    });
  }

  const placementReason = normalizePlacementReason(input.reason);
  const commandId = yield* nextPlacementCommandId(invocation.providerSessionId);

  yield* orchestrationEngine
    .dispatchWorkflowLanePlacement(
      {
        type: "thread.workflow-lane.set",
        commandId,
        threadId: invocation.threadId,
        workflowLane: lane.id,
        placementReason,
      },
      // D2's seam: provenance is a trusted, server-derived argument rather than
      // part of the command payload, and this is the only entry point allowed
      // to claim "agent". The generic `dispatch` is user ingress and would
      // stamp "user", defeating the never-overwrite-a-human rule.
      "agent",
    )
    .pipe(Effect.mapError(toSetBoardLaneError));

  return {
    laneId: lane.id,
    laneName: lane.name,
    placedBy: "agent",
    reason: placementReason,
  } satisfies SetBoardLaneResult;
});

export const makeBoardToolkitHandlersLive = (toolkit: BoardToolkit) =>
  toolkit.toLayer({
    set_board_lane: handleSetBoardLane,
  });
