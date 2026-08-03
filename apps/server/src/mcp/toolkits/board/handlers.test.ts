import {
  EnvironmentId,
  LaneId,
  ProviderInstanceId,
  ThreadId,
  type LaneDefinition,
  type OrchestrationCommand,
  type WorkflowLanePlacedBy,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  OrchestrationCommandInvariantError,
  type OrchestrationDispatchError,
} from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionLaneRepository,
  type ProjectionLaneRepositoryShape,
} from "../../../persistence/Services/ProjectionLanes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { handleSetBoardLane } from "./handlers.ts";
import { SetBoardLaneError } from "./tools.ts";

const LANES: ReadonlyArray<LaneDefinition> = [
  {
    id: LaneId.make("shaping"),
    name: "Grilling / shaping",
    description: "Working out what this actually is",
    order: 0,
    interrupt: "badge",
  },
  {
    id: LaneId.make("ready"),
    name: "Ready",
    description: "Groomed and ready to pick up",
    order: 1,
    interrupt: "move",
  },
  {
    id: LaneId.make("done"),
    name: "Done",
    description: "Finished, or pinned settled",
    order: 2,
    interrupt: "move",
  },
];

const AMBIENT_THREAD = ThreadId.make("thread-ambient");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: AMBIENT_THREAD,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 0,
};

type LanePlacementCommand = Extract<OrchestrationCommand, { type: "thread.workflow-lane.set" }>;

interface Dispatched {
  readonly command: LanePlacementCommand;
  readonly placedBy: WorkflowLanePlacedBy;
}

const runSetBoardLane = (
  input: { readonly laneId: string; readonly reason?: string },
  options: {
    readonly lanes?: ReadonlyArray<LaneDefinition>;
    readonly dispatchFailure?: OrchestrationDispatchError;
    readonly dispatched?: Array<Dispatched>;
  } = {},
) => {
  const lanes = options.lanes ?? LANES;
  const laneRepository = {
    upsert: () => Effect.void,
    getById: () => Effect.succeed(Option.none()),
    listAll: () => Effect.succeed(lanes),
    deleteById: () => Effect.void,
  } satisfies ProjectionLaneRepositoryShape;

  const orchestrationEngine = {
    readEvents: () => Stream.empty,
    // D2 made provenance a separate trusted argument. The generic path stamps
    // "user", so an agent placement routed through it would silently claim to
    // be the human's.
    dispatch: () => Effect.die("set_board_lane must not use the generic dispatch"),
    dispatchWorkflowLanePlacement: (command, placedBy) => {
      options.dispatched?.push({ command, placedBy });
      return options.dispatchFailure === undefined
        ? Effect.succeed({ sequence: 1 })
        : Effect.fail(options.dispatchFailure);
    },
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } satisfies OrchestrationEngineShape;

  return handleSetBoardLane(input).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(ProjectionLaneRepository, laneRepository),
    Effect.provideService(OrchestrationEngineService, orchestrationEngine),
  );
};

const expectSetBoardLaneError = (error: unknown): SetBoardLaneError => {
  if (!(error instanceof SetBoardLaneError)) {
    throw new Error(`Expected a SetBoardLaneError, received ${String(error)}`);
  }
  return error;
};

it.effect("files the ambient thread through the trusted provenance seam", () =>
  Effect.gen(function* () {
    const dispatched: Array<Dispatched> = [];
    const result = yield* runSetBoardLane(
      { laneId: "ready", reason: "Plan is approved and the work is scoped" },
      { dispatched },
    );

    expect(dispatched).toHaveLength(1);
    const [only] = dispatched;
    if (only === undefined) throw new Error("Expected a dispatched placement");

    expect(only.placedBy).toBe("agent");
    expect(only.command.type).toBe("thread.workflow-lane.set");
    // Nothing in the input names a thread; identity comes from the MCP session.
    expect(only.command.threadId).toBe(AMBIENT_THREAD);
    expect(only.command.workflowLane).toBe("ready");
    expect(only.command.placementReason).toBe("Plan is approved and the work is scoped");
    // Provenance travels as a dispatch argument, never in the payload.
    expect("placedBy" in only.command).toBe(false);

    expect(result).toEqual({
      laneId: "ready",
      laneName: "Ready",
      placedBy: "agent",
      reason: "Plan is approved and the work is scoped",
    });
  }),
);

it.effect("files with no reason when none is given", () =>
  Effect.gen(function* () {
    const dispatched: Array<Dispatched> = [];
    const result = yield* runSetBoardLane({ laneId: "shaping", reason: "   " }, { dispatched });

    expect(dispatched[0]?.command.placementReason).toBeNull();
    expect(result.reason).toBeNull();
  }),
);

it.effect("refuses an unknown lane with the real list and dispatches nothing", () =>
  Effect.gen(function* () {
    const dispatched: Array<Dispatched> = [];
    const error = expectSetBoardLaneError(
      yield* Effect.flip(runSetBoardLane({ laneId: "on-deck" }, { dispatched })),
    );

    expect(error.reason).toBe("unknown-lane");
    expect(error.message).toContain("'shaping', 'ready', 'done'");
    expect(error.message).toContain("cannot create a lane");
    expect(dispatched).toEqual([]);
  }),
);

it.effect("says so plainly when the board has no lanes at all", () =>
  Effect.gen(function* () {
    const error = expectSetBoardLaneError(
      yield* Effect.flip(runSetBoardLane({ laneId: "ready" }, { lanes: [] })),
    );

    expect(error.reason).toBe("unknown-lane");
    expect(error.message).toContain("no lanes at all");
  }),
);

it.effect("surfaces the decider's user-precedence rejection as a readable refusal", () =>
  Effect.gen(function* () {
    const error = expectSetBoardLaneError(
      yield* Effect.flip(
        runSetBoardLane(
          { laneId: "done" },
          {
            dispatchFailure: new OrchestrationCommandInvariantError({
              commandType: "thread.workflow-lane.set",
              detail: `Agent placement cannot overwrite the user placement on thread '${AMBIENT_THREAD}'.`,
            }),
          },
        ),
      ),
    );

    expect(error.reason).toBe("user-placement-wins");
    expect(error.message).toContain("The user placed this session");
    expect(error.message).toContain("not moved");
  }),
);

it.effect("passes any other refusal through in readable prose", () =>
  Effect.gen(function* () {
    const error = expectSetBoardLaneError(
      yield* Effect.flip(
        runSetBoardLane(
          { laneId: "done" },
          {
            dispatchFailure: new OrchestrationCommandInvariantError({
              commandType: "thread.workflow-lane.set",
              detail: "Unknown thread 'thread-ambient'.",
            }),
          },
        ),
      ),
    );

    expect(error.reason).toBe("refused");
    expect(error.message).toContain("Unknown thread");
  }),
);
