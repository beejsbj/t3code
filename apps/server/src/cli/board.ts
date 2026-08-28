import {
  AgentBoardResult,
  type AgentBoardCommand,
  type AgentBoardPlacement,
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

const placementText = (placement: AgentBoardPlacement): string => {
  if (!placement.lane) return "No board lane is available.";
  return placement.explicit
    ? `Placed in ${placement.lane.name} (${placement.lane.id}).`
    : `Not explicitly placed; effective lane is ${placement.lane.name} (${placement.lane.id}).`;
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
    case "placement":
    case "place":
    case "unplace":
      yield* Console.log(placementText(result.placement));
      break;
  }
});

const runBoardCommand = (command: AgentBoardCommand) =>
  runBoardCommandRaw(command).pipe(Effect.provide(FetchHttpClient.layer));

const lanesCommand = Command.make("lanes").pipe(
  Command.withDescription("List the originating client's current workflow lanes."),
  Command.withHandler(() => runBoardCommand({ type: "lanes" })),
);

const placementCommand = Command.make("placement").pipe(
  Command.withDescription("Show this thread's current local board placement."),
  Command.withHandler(() => runBoardCommand({ type: "placement" })),
);

const placeCommand = Command.make("place", { lane: Argument.string("lane") }).pipe(
  Command.withDescription("Place this thread by lane ID or exact lane name."),
  Command.withHandler(({ lane }) => runBoardCommand({ type: "place", lane })),
);

const unplaceCommand = Command.make("unplace").pipe(
  Command.withDescription("Remove this thread's explicit local board placement."),
  Command.withHandler(() => runBoardCommand({ type: "unplace" })),
);

export const boardCommand = Command.make("board").pipe(
  Command.withDescription("Operate the originating client's local board placement."),
  Command.withSubcommands([lanesCommand, placementCommand, placeCommand, unplaceCommand]),
);
