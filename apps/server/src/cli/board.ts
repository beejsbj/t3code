import {
  AgentBoardResult,
  type AgentBoardCommand,
  type AgentBoardLaneState,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  FetchHttpClient,
} from "effect/unstable/http";

class BoardCliError extends CliError.UserError {
  override get message() {
    return String(this.cause);
  }
}

const fail = (message: string) => Effect.fail(new BoardCliError({ cause: message }));

const laneText = (state: AgentBoardLaneState): string => {
  if (!state.lane) return "No board lane is available.";
  return state.overridden
    ? `Current lane: ${state.lane.name} (${state.lane.id}); local override stored.`
    : `Current lane: ${state.lane.name} (${state.lane.id}); using the default lane.`;
};

const runBoardCommandRaw = Effect.fn("cli.board.run")(function* (command: AgentBoardCommand) {
  const endpoint = process.env.T3_AGENT_ENDPOINT?.trim();
  const token = process.env.T3_AGENT_BEARER_TOKEN?.trim();
  if (!endpoint || !token) {
    return yield* fail(
      "`t3 board` is available only inside a T3 agent turn with a connected originating client.",
    );
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyJsonUnsafe(command),
    client.execute,
    Effect.mapError(
      (cause) => new BoardCliError({ cause: `Could not reach the T3 board adapter: ${cause}` }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    const error = yield* HttpClientResponse.schemaBodyJson(Schema.Struct({ error: Schema.String }))(
      response,
    ).pipe(
      Effect.map((body) => body.error),
      Effect.orElseSucceed(() => `Board adapter request failed with HTTP ${response.status}.`),
    );
    return yield* fail(error);
  }
  const result = yield* HttpClientResponse.schemaBodyJson(AgentBoardResult)(response).pipe(
    Effect.mapError(
      () => new BoardCliError({ cause: "The board adapter returned an invalid receipt." }),
    ),
  );
  switch (result.type) {
    case "lanes":
      yield* Console.log(
        result.lanes.map((lane) => `${lane.id}\t${lane.name}\t${lane.description}`).join("\n"),
      );
      break;
    case "lane":
    case "move":
      yield* Console.log(laneText(result.state));
      break;
  }
});

const runBoardCommand = (command: AgentBoardCommand) =>
  runBoardCommandRaw(command).pipe(Effect.provide(FetchHttpClient.layer));

const lanesCommand = Command.make("lanes").pipe(
  Command.withDescription("List the originating client's current workflow lanes."),
  Command.withHandler(() => runBoardCommand({ type: "lanes" })),
);

const laneCommand = Command.make("lane").pipe(
  Command.withDescription("Show this thread's current board lane."),
  Command.withHandler(() => runBoardCommand({ type: "lane" })),
);

const moveCommand = Command.make("move", { lane: Argument.string("lane") }).pipe(
  Command.withDescription("Move this thread by lane ID or exact lane name."),
  Command.withHandler(({ lane }) => runBoardCommand({ type: "move", lane })),
);

export const boardCommand = Command.make("board").pipe(
  Command.withDescription("Inspect or move the current thread on the originating client's board."),
  Command.withSubcommands([lanesCommand, laneCommand, moveCommand]),
);
