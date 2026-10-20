import {
  AgentBoardClientList,
  AgentBoardResult,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AgentBoardLaneState,
  type AgentBoardManualCommandRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

class BoardCliError extends CliError.UserError {
  override get message() {
    return String(this.cause);
  }
}

const fail = (message: string) => Effect.fail(new BoardCliError({ cause: message }));

const clientFlag = Flag.String("client").pipe(
  Flag.withDescription(
    "Client ID shown by `t3 board clients`. It changes whenever that window reloads.",
  ),
);

const threadFlag = Flag.String("thread").pipe(
  Flag.withDescription("Thread ID from the T3 chat URL to inspect or move."),
);

const laneText = (state: AgentBoardLaneState): string => {
  if (!state.lane) return "No board lane is available.";
  return state.overridden
    ? `Current lane: ${state.lane.name} (${state.lane.id}); local override stored.`
    : `Current lane: ${state.lane.name} (${state.lane.id}); using the default lane.`;
};

const printResult = Effect.fn("cli.board.printResult")(function* (result: AgentBoardResult) {
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

const decodeErrorResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(Schema.Struct({ error: Schema.String }))(response).pipe(
    Effect.map((body) => body.error),
    Effect.orElseSucceed(() => `Board request failed with HTTP ${response.status}.`),
  );

const executeJsonRequest = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError(
          (cause) => new BoardCliError({ cause: `Could not reach the T3 board adapter: ${cause}` }),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* fail(yield* decodeErrorResponse(response));
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(
        () => new BoardCliError({ cause: "The board adapter returned invalid JSON." }),
      ),
    );
  });

const withManualBoardSession = <A, E, R>(
  flags: CliAuthLocationFlags,
  scopes: ReadonlyArray<typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope>,
  run: (input: { readonly origin: string; readonly token: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* fail("No running T3 server was found for this T3 home.");
    }
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* Effect.acquireUseRelease(
        environmentAuth.issueSession({
          scopes,
          label: "t3 board cli",
        }),
        (issued) => run({ origin: runtimeState.value.origin, token: issued.token }),
        (issued) =>
          environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.layerRuntime, FetchHttpClient.layer).pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const manualUrl = (origin: string, path: string) => new URL(path, origin).toString();

const runManualBoardCommand = (
  flags: CliAuthLocationFlags,
  input: AgentBoardManualCommandRequest,
) =>
  withManualBoardSession(
    flags,
    [input.command.type === "move" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope],
    ({ origin, token }) =>
      executeJsonRequest(
        HttpClientRequest.post(manualUrl(origin, "/api/board")).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe(input),
        ),
        AgentBoardResult,
      ).pipe(Effect.flatMap(printResult)),
  );

const clientsCommand = Command.make("clients", projectLocationFlags).pipe(
  Command.withDescription(
    "List board-capable windows connected to this T3 server. A window gets a new ID when it reloads.",
  ),
  Command.withHandler((flags) =>
    withManualBoardSession(flags, [AuthOrchestrationReadScope], ({ origin, token }) =>
      executeJsonRequest(
        HttpClientRequest.get(manualUrl(origin, "/api/board/clients")).pipe(
          HttpClientRequest.bearerToken(token),
        ),
        AgentBoardClientList,
      ).pipe(
        Effect.flatMap(({ clients }) =>
          Console.log(
            clients.length === 0
              ? "No board-capable clients are connected."
              : clients
                  .map((client) => `${client.clientId}\t${client.label}\t${client.kind}`)
                  .join("\n"),
          ),
        ),
      ),
    ),
  ),
);

const lanesCommand = Command.make("lanes", {
  ...projectLocationFlags,
  client: clientFlag,
}).pipe(
  Command.withDescription("List workflow lanes on the selected client."),
  Command.withHandler((flags) =>
    runManualBoardCommand(flags, { clientId: flags.client, command: { type: "lanes" } }),
  ),
);

const laneCommand = Command.make("lane", {
  ...projectLocationFlags,
  client: clientFlag,
  thread: threadFlag,
}).pipe(
  Command.withDescription("Show a thread's lane on the selected client."),
  Command.withHandler((flags) =>
    runManualBoardCommand(flags, {
      clientId: flags.client,
      threadId: ThreadId.make(flags.thread),
      command: { type: "lane" },
    }),
  ),
);

const moveCommand = Command.make("move", {
  ...projectLocationFlags,
  client: clientFlag,
  thread: threadFlag,
  lane: Argument.String("lane"),
}).pipe(
  Command.withDescription("Move a thread by lane ID or exact lane name."),
  Command.withHandler(({ lane, ...flags }) =>
    runManualBoardCommand(flags, {
      clientId: flags.client,
      threadId: ThreadId.make(flags.thread),
      command: { type: "move", lane },
    }),
  ),
);

export const boardCommand = Command.make("board").pipe(
  Command.withDescription(
    "Inspect or move client-local board lanes. Agents use the board_lanes and board_move MCP tools instead.",
  ),
  Command.withSubcommands([clientsCommand, lanesCommand, laneCommand, moveCommand]),
);
