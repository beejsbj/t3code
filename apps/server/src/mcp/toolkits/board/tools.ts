import {
  AgentBoardClientKind,
  AgentBoardError,
  AgentBoardLane,
  AgentBoardLaneState,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BoardAgentBroker from "../../../agentBoard/BoardAgentBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BoardAgentBroker.BoardAgentBroker,
];

const BoardToolFailure = Schema.Union([AgentBoardError, OrchestratorMcpFailure]);

export const BoardWindow = Schema.Struct({
  label: Schema.String,
  kind: AgentBoardClientKind,
  routing: Schema.Literals(["origin", "only-client"]).annotate({
    description:
      "origin: the window that last sent a message to this thread. only-client: that window is unknown or closed, and this was the only window with a board open.",
  }),
}).annotate({ description: "The T3 Code window whose board answered." });

const BOARD_SCOPE =
  "Needs an agent running inside a T3 thread. Lanes are kept by each T3 Code web or desktop window, not by the server, so this asks the window that last sent a message to this thread.";

const BoardLanesTool = Tool.make("board_lanes", {
  description: `${BOARD_SCOPE} List the workflow lanes on the user's session board, with stable ids, names, and descriptions, and report which lane this thread's card is in. Call this before board_move when you do not know a lane id.`,
  // No `parameters`: Tool.EmptyParams serializes to a top-level object schema.
  success: Schema.Struct({
    lanes: Schema.Array(AgentBoardLane),
    current: AgentBoardLaneState,
    board: BoardWindow,
  }),
  failure: BoardToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List board lanes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const BoardMoveTool = Tool.make("board_move", {
  description: `${BOARD_SCOPE} Move this thread's card to a workflow lane on the user's session board. It moves only this thread's card; it does not settle, snooze, or otherwise change the thread. Move the card only when the user asked for it, directly or through standing instructions. Moving to Triage clears the card's lane override. Report the returned lane faithfully; on failure, nothing was moved.`,
  parameters: Schema.Struct({
    lane: TrimmedNonEmptyString.annotate({
      description: "Lane id from board_lanes (preferred), or the lane's exact name.",
    }),
  }),
  success: Schema.Struct({ current: AgentBoardLaneState, board: BoardWindow }),
  failure: BoardToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Move this thread's board card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BoardToolkit = Toolkit.make(BoardLanesTool, BoardMoveTool);
