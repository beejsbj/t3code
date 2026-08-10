import {
  CommandId,
  LaneId,
  type LaneDefinition,
  type OrchestrationReadModel,
  type ClientOrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { isLifecycleWorkflowLane } from "../orchestration/decider.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  OrchestrationCliRuntimeLive,
  type OrchestrationCliCommandError,
  dispatchLiveOrchestrationCommand,
  fetchLiveOrchestrationSnapshot,
  getOfflineSnapshot,
  makeOrchestrationCliCommandId,
  tryResolveLiveOrchestrationExecutionMode,
  withOrchestrationCliSessionToken,
} from "./orchestrationCliRuntime.ts";

const LANE_CLI_SESSION_LABEL = "t3 lane cli";

type LaneCommandExecutionMode = "live" | "offline";
type LaneCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  {
    type: "lane.create" | "lane.update" | "lane.archive" | "thread.workflow-lane.set";
  }
>;

export type LaneCommandError = OrchestrationCliCommandError | LaneCommandDomainError;
export type LaneCommandDomainError =
  | LaneNameEmptyError
  | LaneNameInvalidCharactersError
  | LaneNameDuplicateError
  | LaneOrderInvalidError
  | LaneNotFoundError
  | ThreadNotFoundError
  | LaneArchiveBlockedError
  | LifecycleLaneMoveBlockedError;

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

export class LaneNameInvalidCharactersError extends Schema.TaggedErrorClass<LaneNameInvalidCharactersError>()(
  "LaneNameInvalidCharactersError",
  {
    operation: Schema.Literal("validateLaneName"),
    name: Schema.String,
  },
) {
  override get message(): string {
    return "Lane name cannot contain tabs or newlines.";
  }
}

export class LaneNameDuplicateError extends Schema.TaggedErrorClass<LaneNameDuplicateError>()(
  "LaneNameDuplicateError",
  {
    operation: Schema.Literal("validateUniqueLaneName"),
    name: Schema.String,
    existingLaneId: Schema.String,
  },
) {
  override get message(): string {
    return `Lane '${this.existingLaneId}' already uses the display name '${this.name}'.`;
  }
}

export class LaneOrderInvalidError extends Schema.TaggedErrorClass<LaneOrderInvalidError>()(
  "LaneOrderInvalidError",
  {
    operation: Schema.Literal("validateLaneOrder"),
    order: Schema.Number,
  },
) {
  override get message(): string {
    return `Lane order must be finite; received ${this.order}.`;
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
    validThreadIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const listed =
      this.validThreadIds.length === 0
        ? "(none)"
        : this.validThreadIds.map((id) => `'${id}'`).join(", ");
    return `Thread '${this.threadId}' was not found. Valid thread ids: ${listed}.`;
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
    return `Lane '${this.laneId}' still has ${this.sessionCount} assigned ${noun} and cannot be archived.`;
  }
}

export class LifecycleLaneMoveBlockedError extends Schema.TaggedErrorClass<LifecycleLaneMoveBlockedError>()(
  "LifecycleLaneMoveBlockedError",
  {
    operation: Schema.Literal("moveThread"),
    laneId: Schema.String,
  },
) {
  override get message(): string {
    return `Lane '${this.laneId}' is a lifecycle lane and cannot be used as a workflow placement target.`;
  }
}

const laneCommandUuid = makeOrchestrationCliCommandId("generateLaneCommandId");

export function sortedLanes(lanes: ReadonlyArray<LaneDefinition>): ReadonlyArray<LaneDefinition> {
  return lanes.toSorted(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

export function validLaneIds(snapshot: OrchestrationReadModel): ReadonlyArray<string> {
  return sortedLanes(snapshot.lanes).map((lane) => lane.id);
}

export function validThreadIds(snapshot: OrchestrationReadModel): ReadonlyArray<string> {
  return snapshot.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => thread.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function nextLaneOrder(lanes: ReadonlyArray<LaneDefinition>): number {
  const finiteOrders = lanes.map((lane) => lane.order).filter(Number.isFinite);
  return Math.max(-1, ...finiteOrders) + 1;
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
    const laneId = lane.id
      .replaceAll("\\", "\\\\")
      .replaceAll("\t", "\\t")
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n");
    const laneName = lane.name
      .replaceAll("\\", "\\\\")
      .replaceAll("\t", "\\t")
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n");
    lines.push(`${laneId}\t${laneName}\t${lane.order}\t${sessions}`);
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
      validThreadIds: [...validThreadIds(snapshot)],
    });
  }
  return thread;
});

export const validateLaneName = Effect.fn("validateLaneName")(function* (name: string) {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return yield* new LaneNameEmptyError({
      operation: "validateLaneName",
      name,
    });
  }
  if (/[\t\r\n]/.test(trimmed)) {
    return yield* new LaneNameInvalidCharactersError({
      operation: "validateLaneName",
      name,
    });
  }
  return trimmed;
});

export const validateUniqueLaneName = Effect.fn("validateUniqueLaneName")(function* (
  lanes: ReadonlyArray<LaneDefinition>,
  name: string,
  excludedLaneId?: LaneDefinition["id"],
) {
  const normalizedName = name.trim().toLocaleLowerCase();
  const duplicate = lanes.find(
    (lane) => lane.id !== excludedLaneId && lane.name.trim().toLocaleLowerCase() === normalizedName,
  );
  if (duplicate !== undefined) {
    return yield* new LaneNameDuplicateError({
      operation: "validateUniqueLaneName",
      name,
      existingLaneId: duplicate.id,
    });
  }
});

export const validateLaneOrder = Effect.fn("validateLaneOrder")(function* (order: number) {
  if (!Number.isFinite(order)) {
    return yield* new LaneOrderInvalidError({
      operation: "validateLaneOrder",
      order,
    });
  }
  return order;
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
    const liveMode = yield* tryResolveLiveOrchestrationExecutionMode(environmentAuth, config, {
      sessionLabel: LANE_CLI_SESSION_LABEL,
      connectFailureLogMessage: "Failed to connect to the persisted lane CLI server.",
    });

    if (Option.isSome(liveMode)) {
      return yield* withOrchestrationCliSessionToken(
        environmentAuth,
        LANE_CLI_SESSION_LABEL,
        (token) =>
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

    const offlineRuntimeLayer = OrchestrationCliRuntimeLive.pipe(
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
      Effect.fn("laneList")(({ snapshot }) => Effect.succeed(formatLaneList(snapshot))),
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
        yield* validateUniqueLaneName(snapshot.lanes, laneName);
        const description = Option.getOrElse(flags.description, () => "—").trim() || "—";
        const order = yield* validateLaneOrder(
          Option.getOrElse(flags.order, () => nextLaneOrder(snapshot.lanes)),
        );
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
        yield* validateUniqueLaneName(snapshot.lanes, laneName, lane.id);
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
}).pipe(
  Command.withDescription("Archive a workflow lane."),
  Command.withHandler((flags) =>
    runLaneCommand(
      flags,
      Effect.fn("laneArchive")(function* ({ snapshot, dispatch }) {
        const lane = yield* resolveLane(snapshot, flags.laneId);
        const sessionCount = countSessionsInLane(snapshot, lane.id);
        if (sessionCount > 0) {
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
        if (isLifecycleWorkflowLane(lane.id)) {
          return yield* new LifecycleLaneMoveBlockedError({
            operation: "moveThread",
            laneId: lane.id,
          });
        }
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
