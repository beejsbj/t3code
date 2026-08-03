import {
  CommandId,
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  LaneId,
  type LaneDefinition,
  type OrchestrationReadModel,
  type ClientOrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  ProjectCommandIdGenerationError,
  projectCommandErrorFromLiveServerRequest,
  type ProjectCommandError,
} from "./project.ts";

type LaneCommandExecutionMode = "live" | "offline";
type LaneCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  {
    type: "lane.create" | "lane.update" | "lane.archive" | "thread.workflow-lane.set";
  }
>;

export type LaneCommandError = ProjectCommandError | LaneCommandDomainError;
export type LaneCommandDomainError =
  | LaneNameEmptyError
  | LaneNotFoundError
  | ThreadNotFoundError
  | LaneArchiveBlockedError;

export class LaneNameEmptyError extends Schema.TaggedErrorClass<LaneNameEmptyError>()(
  "LaneNameEmptyError",
  {
    operation: Schema.Literal("validateLaneName"),
    name: Schema.String,
  },
) {
  override get message(): string {
    return "Lane name cannot be empty.";
  }
}

export class LaneNotFoundError extends Schema.TaggedErrorClass<LaneNotFoundError>()(
  "LaneNotFoundError",
  {
    operation: Schema.Literal("resolveLane"),
    laneId: Schema.String,
    validLaneIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const listed =
      this.validLaneIds.length === 0
        ? "(none)"
        : this.validLaneIds.map((id) => `'${id}'`).join(", ");
    return `Lane '${this.laneId}' was not found. Valid lane ids: ${listed}.`;
  }
}

export class ThreadNotFoundError extends Schema.TaggedErrorClass<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  {
    operation: Schema.Literal("resolveThread"),
    threadId: Schema.String,
    validLaneIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const listed =
      this.validLaneIds.length === 0
        ? "(none)"
        : this.validLaneIds.map((id) => `'${id}'`).join(", ");
    return `Thread '${this.threadId}' was not found. Valid lane ids: ${listed}.`;
  }
}

export class LaneArchiveBlockedError extends Schema.TaggedErrorClass<LaneArchiveBlockedError>()(
  "LaneArchiveBlockedError",
  {
    operation: Schema.Literal("archiveLane"),
    laneId: Schema.String,
    sessionCount: Schema.Number,
  },
) {
  override get message(): string {
    const noun = this.sessionCount === 1 ? "session" : "sessions";
    return `Lane '${this.laneId}' still has ${this.sessionCount} ${noun}. Re-run with --force to archive anyway.`;
  }
}

const laneCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new ProjectCommandIdGenerationError({
        operation: "generateProjectCommandId",
        cause,
      }),
  ),
);

const LaneCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const LANE_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1);

const withLaneCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: "t3 lane cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withLaneCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(LANE_CLI_LIVE_SERVER_TIMEOUT));

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

export function sortedLanes(lanes: ReadonlyArray<LaneDefinition>): ReadonlyArray<LaneDefinition> {
  return lanes.toSorted(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

export function validLaneIds(snapshot: OrchestrationReadModel): ReadonlyArray<string> {
  return sortedLanes(snapshot.lanes).map((lane) => lane.id);
}

export function nextLaneOrder(lanes: ReadonlyArray<LaneDefinition>): number {
  return lanes.length === 0 ? 0 : Math.max(...lanes.map((lane) => lane.order)) + 1;
}

export function laneIdForName(
  name: string,
  lanes: ReadonlyArray<LaneDefinition>,
): LaneDefinition["id"] {
  const base =
    name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lane";
  const existingIds = new Set(lanes.map((lane) => lane.id));
  if (!existingIds.has(LaneId.make(base))) return LaneId.make(base);

  let suffix = 2;
  while (existingIds.has(LaneId.make(`${base}-${suffix}`))) suffix += 1;
  return LaneId.make(`${base}-${suffix}`);
}

export function countSessionsInLane(
  snapshot: OrchestrationReadModel,
  laneId: LaneDefinition["id"],
): number {
  let count = 0;
  for (const thread of snapshot.threads) {
    if (thread.deletedAt !== null) continue;
    if (thread.workflowLane === laneId) count += 1;
  }
  return count;
}

export function formatLaneList(snapshot: OrchestrationReadModel): string {
  const lines: Array<string> = [];
  for (const lane of sortedLanes(snapshot.lanes)) {
    const sessions = countSessionsInLane(snapshot, lane.id);
    lines.push(`${lane.id}\t${lane.name}\t${lane.order}\t${sessions}`);
  }
  return lines.join("\n");
}

const resolveLane = Effect.fn("resolveLane")(function* (
  snapshot: OrchestrationReadModel,
  laneId: string,
) {
  const trimmed = laneId.trim();
  const lane = snapshot.lanes.find((entry) => entry.id === trimmed);
  if (lane === undefined) {
    return yield* new LaneNotFoundError({
      operation: "resolveLane",
      laneId: trimmed,
      validLaneIds: [...validLaneIds(snapshot)],
    });
  }
  return lane;
});

const resolveThread = Effect.fn("resolveThread")(function* (
  snapshot: OrchestrationReadModel,
  threadId: string,
) {
  const trimmed = threadId.trim();
  const thread = snapshot.threads.find((entry) => entry.deletedAt === null && entry.id === trimmed);
  if (thread === undefined) {
    return yield* new ThreadNotFoundError({
      operation: "resolveThread",
      threadId: trimmed,
      validLaneIds: [...validLaneIds(snapshot)],
    });
  }
  return thread;
});

const validateLaneName = Effect.fn("validateLaneName")(function* (name: string) {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return yield* new LaneNameEmptyError({
      operation: "validateLaneName",
      name,
    });
  }
  return trimmed;
});

const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(withLaneCliLiveServerTimeout, Effect.mapError(projectCommandErrorFromLiveServerRequest));

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: LaneCliDispatchCommand,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(withLaneCliLiveServerTimeout, Effect.mapError(projectCommandErrorFromLiveServerRequest));

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getSnapshot();
});

const tryResolveLiveLaneExecutionMode = Effect.fn("tryResolveLiveLaneExecutionMode")(function* (
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  config: ServerConfig.ServerConfig["Service"],
) {
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return Option.none<{ readonly origin: string }>();
  }

  const attempt = withLaneCliSessionToken(environmentAuth, (token) =>
    fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
      Effect.as({
        origin: runtimeState.value.origin,
      }),
    ),
  );

  const attempted = yield* Effect.result(attempt);
  if (attempted._tag === "Success") {
    return Option.some(attempted.success);
  }

  yield* Effect.logDebug("Failed to connect to the persisted lane CLI server.", {
    origin: runtimeState.value.origin,
    cause: attempted.failure,
  });
  yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
  return Option.none<{ readonly origin: string }>();
});

const runLaneCommand = Effect.fn("runLaneCommand")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: (
      command: LaneCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
    readonly mode: LaneCommandExecutionMode;
  }) => Effect.Effect<
    string,
    Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const liveMode = yield* tryResolveLiveLaneExecutionMode(environmentAuth, config);

    if (Option.isSome(liveMode)) {
      return yield* withLaneCliSessionToken(environmentAuth, (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) =>
              dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
            mode: "live",
          });
          yield* Console.log(output);
        }),
      );
    }

    const offlineRuntimeLayer = LaneCliRuntimeLive.pipe(
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => orchestrationEngine.dispatch(command),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(offlineRuntimeLayer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const laneListCommand = Command.make("list", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("List workflow lanes and session counts."),
  Command.withHandler((flags) =>
    runLaneCommand(
      flags,
      Effect.fn("laneList")(function* ({ snapshot }) {
        return formatLaneList(snapshot);
      }),
    ),
  ),
);

const laneCreateCommand = Command.make("create", {
  ...projectLocationFlags,
  name: Argument.string("name").pipe(Argument.withDescription("Display name for the new lane.")),
  description: Flag.string("description").pipe(
    Flag.withDescription("Optional lane description."),
    Flag.optional,
  ),
  order: Flag.integer("order").pipe(
    Flag.withDescription("Optional sort order; defaults to appending on the right."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Create a workflow lane."),
  Command.withHandler((flags) =>
    runLaneCommand(
      flags,
      Effect.fn("laneCreate")(function* ({ snapshot, dispatch }) {
        const laneName = yield* validateLaneName(flags.name);
        const description = Option.getOrElse(flags.description, () => "—").trim() || "—";
        const order = Option.getOrElse(flags.order, () => nextLaneOrder(snapshot.lanes));
        const lane: LaneDefinition = {
          id: laneIdForName(laneName, snapshot.lanes),
          name: laneName,
          description,
          order,
        };
        yield* dispatch({
          type: "lane.create",
          commandId: CommandId.make(yield* laneCommandUuid),
          lane,
        });
        return `Created lane ${lane.id} (${lane.name}) at order ${lane.order}.`;
      }),
    ),
  ),
);

const laneRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  laneId: Argument.string("lane-id").pipe(Argument.withDescription("Lane id to rename.")),
  name: Argument.string("name").pipe(Argument.withDescription("New display name.")),
}).pipe(
  Command.withDescription("Rename a workflow lane."),
  Command.withHandler((flags) =>
    runLaneCommand(
      flags,
      Effect.fn("laneRename")(function* ({ snapshot, dispatch }) {
        const lane = yield* resolveLane(snapshot, flags.laneId);
        const laneName = yield* validateLaneName(flags.name);
        if (laneName === lane.name) {
          return `Lane ${lane.id} is already named ${laneName}.`;
        }
        yield* dispatch({
          type: "lane.update",
          commandId: CommandId.make(yield* laneCommandUuid),
          laneId: lane.id,
          name: laneName,
        });
        return `Renamed lane ${lane.id} to ${laneName}.`;
      }),
    ),
  ),
);

const laneArchiveCommand = Command.make("archive", {
  ...projectLocationFlags,
  laneId: Argument.string("lane-id").pipe(Argument.withDescription("Lane id to archive.")),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Archive even when sessions are still assigned to this lane."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Archive a workflow lane."),
  Command.withHandler((flags) =>
    runLaneCommand(
      flags,
      Effect.fn("laneArchive")(function* ({ snapshot, dispatch }) {
        const lane = yield* resolveLane(snapshot, flags.laneId);
        const sessionCount = countSessionsInLane(snapshot, lane.id);
        if (sessionCount > 0 && !flags.force) {
          return yield* new LaneArchiveBlockedError({
            operation: "archiveLane",
            laneId: lane.id,
            sessionCount,
          });
        }
        yield* dispatch({
          type: "lane.archive",
          commandId: CommandId.make(yield* laneCommandUuid),
          laneId: lane.id,
        });
        return `Archived lane ${lane.id}.`;
      }),
    ),
  ),
);

const laneMoveCommand = Command.make("move", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id to move.")),
  laneId: Argument.string("lane-id").pipe(Argument.withDescription("Target lane id.")),
}).pipe(
  Command.withDescription("Set a thread's workflow lane."),
  Command.withHandler((flags) =>
    runLaneCommand(
      flags,
      Effect.fn("laneMove")(function* ({ snapshot, dispatch }) {
        const thread = yield* resolveThread(snapshot, flags.threadId);
        const lane = yield* resolveLane(snapshot, flags.laneId);
        if (thread.workflowLane === lane.id) {
          return `Thread ${thread.id} is already in lane ${lane.id}.`;
        }
        yield* dispatch({
          type: "thread.workflow-lane.set",
          commandId: CommandId.make(yield* laneCommandUuid),
          threadId: ThreadId.make(thread.id),
          workflowLane: lane.id,
        });
        return `Moved thread ${thread.id} to lane ${lane.id}.`;
      }),
    ),
  ),
);

export const boardCommand = Command.make("board").pipe(
  Command.withDescription(
    "Inspect and manage the session board: its lanes and where sessions sit.",
  ),
  Command.withSubcommands([
    laneListCommand,
    laneCreateCommand,
    laneRenameCommand,
    laneArchiveCommand,
    laneMoveCommand,
  ]),
);
