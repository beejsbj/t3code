import { AgentBoardError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BoardAgentBroker from "../../../agentBoard/BoardAgentBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BoardToolkit } from "./tools.ts";

const requireBoard = McpInvocationContext.requireThreadMcpCapability("board").pipe(
  Effect.mapError(
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot use the session board.",
      }),
  ),
);

const unexpectedResult = new AgentBoardError({
  message: "The board window returned an unexpected result. Nothing is known to have changed.",
});

const boardWindow = ({ client, routing }: BoardAgentBroker.AgentBoardRoutedResult) => ({
  label: client.label,
  kind: client.kind,
  routing,
});

// Both tools take the thread from the caller's credential, never from input,
// so an agent can only see and move its own card.
const handlers = {
  board_lanes: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* requireBoard;
      const broker = yield* BoardAgentBroker.BoardAgentBroker;
      const lanes = yield* broker.invoke(scope.thread.threadId, { type: "lanes" });
      const lane = yield* broker.invoke(scope.thread.threadId, { type: "lane" });
      if (lanes.result.type !== "lanes" || lane.result.type !== "lane") {
        return yield* unexpectedResult;
      }
      return { lanes: lanes.result.lanes, current: lane.result.state, board: boardWindow(lane) };
    }),
  ),
  board_move: McpToolAccess.actsAsCaller(({ lane }) =>
    Effect.gen(function* () {
      const scope = yield* requireBoard;
      const broker = yield* BoardAgentBroker.BoardAgentBroker;
      const moved = yield* broker.invoke(scope.thread.threadId, { type: "move", lane });
      if (moved.result.type !== "move") return yield* unexpectedResult;
      return { current: moved.result.state, board: boardWindow(moved) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof BoardToolkit.tools>;

export const layer = McpToolAccess.toLayer(BoardToolkit, handlers);
