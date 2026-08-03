import type { LaneDefinition, LaneInterruptPolicy } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionLaneRepository } from "../../../persistence/Services/ProjectionLanes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const SET_BOARD_LANE_TOOL_NAME = "set_board_lane";

/**
 * Why this tool takes no thread id: the per-thread MCP session already knows
 * which thread it belongs to (`McpProviderSession` issues one credential per
 * thread and `McpInvocationContext` carries it). Accepting a thread id would
 * let one session file — or refile — another session's card. Making that
 * structurally impossible is stronger than forbidding it in the description.
 */
export const SetBoardLaneInput = Schema.Struct({
  laneId: Schema.String.annotate({
    description:
      "Id of an existing board lane, copied exactly from the list in this tool's description. This tool never creates a lane.",
  }),
  reason: Schema.optional(
    Schema.String.annotate({
      description:
        "One short line on why this lane fits, shown to the user on the card. Omit it rather than restating the lane name.",
    }),
  ).annotate({
    description:
      "One short line on why this lane fits, shown to the user on the card. Omit it rather than restating the lane name.",
  }),
});
export type SetBoardLaneInput = typeof SetBoardLaneInput.Type;

export const SetBoardLaneResult = Schema.Struct({
  laneId: Schema.String,
  laneName: Schema.String,
  placedBy: Schema.Literal("agent"),
  reason: Schema.NullOr(Schema.String),
});
export type SetBoardLaneResult = typeof SetBoardLaneResult.Type;

export const SetBoardLaneFailureReason = Schema.Literals([
  "unknown-lane",
  "user-placement-wins",
  "refused",
  "registry-unavailable",
]);
export type SetBoardLaneFailureReason = typeof SetBoardLaneFailureReason.Type;

/**
 * `message` is what the agent actually reads: `McpServer.registerToolkit`
 * renders a declared failure as `toolErrorResult(error.message)`, so the
 * refusal has to be legible prose rather than a tag.
 */
export class SetBoardLaneError extends Schema.TaggedErrorClass<SetBoardLaneError>()(
  "SetBoardLaneError",
  {
    reason: SetBoardLaneFailureReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const interruptHint = (interrupt: LaneInterruptPolicy): string =>
  interrupt === "badge"
    ? "a card that needs the user stays in this lane and lights up in place — this lane is for work the user is already watching."
    : "a card that needs the user leaves this lane for the Needs-you rail.";

const byRegistryOrder = (left: LaneDefinition, right: LaneDefinition): number =>
  left.order - right.order || left.id.localeCompare(right.id);

/**
 * The whole prompt surface for agent self-placement. There is no skill and no
 * system-prompt append: whatever the user wrote when they created a lane is
 * what teaches the model that lane's meaning, so the authored name and
 * description are reproduced here verbatim.
 */
export function renderSetBoardLaneDescription(lanes: ReadonlyArray<LaneDefinition>): string {
  const laneBlock =
    lanes.length === 0
      ? [
          "This board has no lanes right now, so there is nowhere to file this session. Say so instead of calling this tool.",
        ]
      : [...lanes]
          .sort(byRegistryOrder)
          .flatMap((lane) => [
            `- \`${lane.id}\` (${lane.name}) — ${lane.description}`,
            `  Attention: ${interruptHint(lane.interrupt)}`,
          ]);

  return [
    "File the coding session you are running in into a lane on the user's session board.",
    "",
    "You can only file this session. The thread is fixed by the session this tool is served to, so there is no session or thread parameter and you cannot move anyone else's card.",
    "",
    "Lanes are the user's own geography. Only the user creates them, and this tool never will. Pass `laneId` exactly as written:",
    "",
    ...laneBlock,
    "",
    "If no lane fits, leave the session unplaced and say so in your reply rather than forcing it into the nearest lane.",
    "The user's placement always wins: if the user has already filed this session, this call is refused and their placement is left alone.",
  ].join("\n");
}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionLaneRepository,
  OrchestrationEngineService,
];

export function makeSetBoardLaneTool(lanes: ReadonlyArray<LaneDefinition>) {
  return Tool.make(SET_BOARD_LANE_TOOL_NAME, {
    description: renderSetBoardLaneDescription(lanes),
    parameters: SetBoardLaneInput,
    success: SetBoardLaneResult,
    failure: SetBoardLaneError,
    dependencies,
  })
    .annotate(Tool.Title, "File this session into a board lane")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false);
}

export function makeBoardToolkit(lanes: ReadonlyArray<LaneDefinition>) {
  return Toolkit.make(makeSetBoardLaneTool(lanes));
}

export type BoardToolkit = ReturnType<typeof makeBoardToolkit>;
