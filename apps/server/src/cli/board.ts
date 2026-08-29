import {
  AgentBoardClientList,
  AgentBoardResult,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AgentBoardCommand,
  type AgentBoardLaneState,
  type AgentBoardManualCommandRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { boardSkillFiles } from "./boardSkill.ts";

class BoardCliError extends CliError.UserError {
  override get message() {
    return String(this.cause);
  }
}

const fail = (message: string) => Effect.fail(new BoardCliError({ cause: message }));

const clientFlag = Flag.string("client").pipe(
  Flag.withDescription("Stable client ID shown by `t3 board clients`."),
  Flag.optional,
);

const threadFlag = Flag.string("thread").pipe(
  Flag.withDescription("Thread ID from the T3 chat URL to inspect or move."),
  Flag.optional,
);

const directoryFlag = Flag.string("directory").pipe(
  Flag.withDescription("Project directory in which to install the opt-in filesystem skill."),
  Flag.optional,
);

const isAgentScopedProcess = () =>
  Boolean(process.env.T3_AGENT_ENDPOINT?.trim() || process.env.T3_AGENT_BEARER_TOKEN?.trim());

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

const runAgentBoardCommand = Effect.fn("cli.board.runAgent")(function* (
  command: AgentBoardCommand,
) {
  const endpoint = process.env.T3_AGENT_ENDPOINT?.trim();
  const token = process.env.T3_AGENT_BEARER_TOKEN?.trim();
  if (!endpoint || !token) {
    return yield* fail(
      "No agent turn is active. For manual use, select a client with `t3 board clients`, then pass `--client` and (for lane or move) `--thread`.",
    );
  }
  const result = yield* executeJsonRequest(
    HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJsonUnsafe(command),
    ),
    AgentBoardResult,
  );
  yield* printResult(result);
});

const withManualBoardSession = <A, E, R>(
  flags: CliAuthLocationFlags,
  scopes: ReadonlyArray<typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope>,
  run: (input: { readonly origin: string; readonly token: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (isAgentScopedProcess()) {
      return yield* fail(
        "Manual board targeting is unavailable inside a T3 agent turn; use the scoped lanes, lane, and move commands without --client or --thread.",
      );
    }
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
        Layer.mergeAll(EnvironmentAuth.runtimeLayer, FetchHttpClient.layer).pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const installBoardSkill = Effect.fn("cli.board.installSkill")(function* (
  directory: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDirectory = path.resolve(Option.getOrElse(directory, () => process.cwd()));
  const skillDirectory = path.join(projectDirectory, ".agents", "skills", "t3-board");
  const targets = yield* Effect.forEach(
    Object.entries(boardSkillFiles),
    ([relativePath, content]) =>
      Effect.gen(function* () {
        const target = path.join(skillDirectory, relativePath);
        const exists = yield* fs.exists(target);
        return { target, content, exists } as const;
      }),
  );

  for (const target of targets) {
    if (target.exists && (yield* fs.readFileString(target.target)) !== target.content) {
      return yield* fail(
        `Refusing to overwrite the existing T3 board skill at ${target.target}. Remove it explicitly before reinstalling.`,
      );
    }
  }

  const missing = targets.filter((target) => !target.exists);
  for (const target of missing) {
    yield* fs.makeDirectory(path.dirname(target.target), { recursive: true });
    yield* fs.writeFileString(target.target, target.content);
  }

  yield* Console.log(
    missing.length > 0
      ? `Installed the opt-in T3 board skill at ${skillDirectory}. Start a new provider session to discover it.`
      : `The opt-in T3 board skill is already installed at ${skillDirectory}.`,
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

const runSelectedThreadCommand = (
  flags: CliAuthLocationFlags & {
    readonly client: Option.Option<string>;
    readonly thread: Option.Option<string>;
  },
  command: AgentBoardCommand,
) => {
  if (Option.isNone(flags.client) && Option.isNone(flags.thread)) {
    return runAgentBoardCommand(command).pipe(Effect.provide(FetchHttpClient.layer));
  }
  if (Option.isNone(flags.client) || Option.isNone(flags.thread)) {
    return fail("Manual lane and move commands require both `--client` and `--thread`.");
  }
  return runManualBoardCommand(flags, {
    clientId: flags.client.value,
    threadId: ThreadId.make(flags.thread.value),
    command,
  });
};

const clientsCommand = Command.make("clients", projectLocationFlags).pipe(
  Command.withDescription("List board-capable clients connected to this T3 server."),
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
  Command.withDescription("List workflow lanes on the originating or selected client."),
  Command.withHandler((flags) =>
    Option.isSome(flags.client)
      ? runManualBoardCommand(flags, {
          clientId: flags.client.value,
          command: { type: "lanes" },
        })
      : runAgentBoardCommand({ type: "lanes" }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const laneCommand = Command.make("lane", {
  ...projectLocationFlags,
  client: clientFlag,
  thread: threadFlag,
}).pipe(
  Command.withDescription("Show a thread's lane on the originating or selected client."),
  Command.withHandler((flags) => runSelectedThreadCommand(flags, { type: "lane" })),
);

const moveCommand = Command.make("move", {
  ...projectLocationFlags,
  client: clientFlag,
  thread: threadFlag,
  lane: Argument.string("lane"),
}).pipe(
  Command.withDescription("Move a thread by lane ID or exact lane name."),
  Command.withHandler(({ lane, ...flags }) =>
    runSelectedThreadCommand(flags, { type: "move", lane }),
  ),
);

const installSkillCommand = Command.make("install", { directory: directoryFlag }).pipe(
  Command.withDescription("Install the opt-in T3 board skill in a project."),
  Command.withHandler(({ directory }) => installBoardSkill(directory)),
);

const skillCommand = Command.make("skill").pipe(
  Command.withDescription("Manage the opt-in T3 board filesystem skill."),
  Command.withSubcommands([installSkillCommand]),
);

export const boardCommand = Command.make("board").pipe(
  Command.withDescription("Inspect or move client-local board lanes."),
  Command.withSubcommands([clientsCommand, lanesCommand, laneCommand, moveCommand, skillCommand]),
);
