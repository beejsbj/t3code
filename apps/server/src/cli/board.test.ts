import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  LaneId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type LaneDefinition,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";
import {
  LaneArchiveBlockedError,
  LaneNameDuplicateError,
  LaneNameInvalidCharactersError,
  LaneOrderInvalidError,
  LaneNotFoundError,
  ThreadNotFoundError,
  countSessionsInLane,
  formatLaneList,
  laneIdForName,
  nextLaneOrder,
  sortedLanes,
  validateLaneName,
  validateLaneOrder,
  validateUniqueLaneName,
} from "./board.ts";
import { decideOrchestrationCommand } from "../orchestration/decider.ts";

const LANES: ReadonlyArray<LaneDefinition> = [
  { id: LaneId.make("triage"), name: "Triage", description: "Incoming", order: 0 },
  { id: LaneId.make("ready"), name: "Ready", description: "Ready to work", order: 10 },
];

function snapshotWithLanes(lanes: ReadonlyArray<LaneDefinition> = LANES): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    lanes,
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

it("lists lanes in order with session counts", () => {
  const snapshot: OrchestrationReadModel = {
    ...snapshotWithLanes(),
    threads: [
      {
        id: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-1"),
        title: "A",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        workflowLane: LaneId.make("ready"),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  };

  assert.equal(
    formatLaneList(snapshot),
    ["triage\tTriage\t0\t0", "ready\tReady\t10\t1"].join("\n"),
  );
  assert.deepEqual(
    sortedLanes(snapshot.lanes).map((lane) => lane.id),
    ["triage", "ready"],
  );
});

it("appends new lanes to the right when order is omitted", () => {
  assert.equal(nextLaneOrder(LANES), 11);
  assert.equal(nextLaneOrder([]), 0);
  assert.equal(
    nextLaneOrder([
      { id: LaneId.make("nan"), name: "NaN", description: "Invalid", order: Number.NaN },
      {
        id: LaneId.make("infinite"),
        name: "Infinite",
        description: "Invalid",
        order: Number.POSITIVE_INFINITY,
      },
    ]),
    0,
  );
  assert.equal(laneIdForName("Ship It", LANES), "ship-it");
});

it("escapes structural characters in lane list fields", () => {
  const snapshot = snapshotWithLanes([
    {
      id: LaneId.make("review"),
      name: "Review\tblocked\nnext",
      description: "Review",
      order: 1,
    },
  ]);
  assert.equal(formatLaneList(snapshot), "review\tReview\\tblocked\\nnext\t1\t0");
});

it.effect("rejects duplicate names, structural characters, and invalid orders", () =>
  Effect.gen(function* () {
    const duplicate = yield* validateUniqueLaneName(LANES, "ready").pipe(Effect.flip);
    assert.instanceOf(duplicate, LaneNameDuplicateError);
    assert.equal(duplicate.existingLaneId, "ready");

    const invalidName = yield* validateLaneName("Needs\tReview").pipe(Effect.flip);
    assert.instanceOf(invalidName, LaneNameInvalidCharactersError);

    for (const order of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalidOrder = yield* validateLaneOrder(order).pipe(Effect.flip);
      assert.instanceOf(invalidOrder, LaneOrderInvalidError);
    }

    assert.equal(yield* validateLaneOrder(0), 0);
    assert.equal(yield* validateLaneOrder(-2), -2);
  }),
);

it("refuses to archive a populated lane", () => {
  const snapshot: OrchestrationReadModel = {
    ...snapshotWithLanes([{ id: LaneId.make("ready"), name: "Ready", description: "R", order: 0 }]),
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        workflowLane: LaneId.make("ready"),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
  assert.equal(countSessionsInLane(snapshot, LaneId.make("ready")), 1);
  const error = new LaneArchiveBlockedError({
    operation: "archiveLane",
    laneId: "ready",
    sessionCount: 1,
  });
  assert.include(error.message, "cannot be archived");
});

it("reports unknown lane ids with valid lane ids listed", () => {
  const snapshot = snapshotWithLanes();
  const laneError = new LaneNotFoundError({
    operation: "resolveLane",
    laneId: "missing",
    validLaneIds: ["triage", "ready"],
  });
  assert.include(laneError.message, "missing");
  assert.include(laneError.message, "'triage'");
  assert.include(laneError.message, "'ready'");

  const threadError = new ThreadNotFoundError({
    operation: "resolveThread",
    threadId: "missing-thread",
    validThreadIds: ["thread-a", "thread-b"],
  });
  assert.include(threadError.message, "missing-thread");
  assert.include(threadError.message, "Valid thread ids");
  assert.include(threadError.message, "'thread-b'");
  assert.isAtLeast(snapshot.lanes.length, 1);
});

const orchestrationTestLayer = (() => {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-lane-cli-test-",
  });
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
})();

const now = () => "2026-01-01T00:00:00.000Z";
const orchestrationLayer = it.layer(orchestrationTestLayer);

orchestrationLayer("lane move", (it) => {
  it.effect("sets workflowLane without changing other thread fields", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const createdAt = now();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-lane-project"),
        projectId: ProjectId.make("project-lane"),
        title: "Lane Project",
        workspaceRoot: "/tmp/lane-project",
        createdAt,
      });
      yield* engine.dispatch({
        type: "lane.create",
        commandId: CommandId.make("cmd-lane-create"),
        lane: {
          id: LaneId.make("review"),
          name: "Review",
          description: "Review queue",
          order: 0,
        },
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-lane-thread"),
        threadId: ThreadId.make("thread-lane"),
        projectId: ProjectId.make("project-lane"),
        title: "Lane thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: "/tmp/lane-project",
        createdAt,
      });

      const before = (yield* snapshotQuery.getSnapshot()).threads.find(
        (thread) => thread.id === "thread-lane",
      );
      expect(before).toBeDefined();
      if (!before) return yield* Effect.die("missing thread");

      yield* engine.dispatch({
        type: "thread.workflow-lane.set",
        commandId: CommandId.make("cmd-lane-move"),
        threadId: ThreadId.make("thread-lane"),
        workflowLane: LaneId.make("review"),
      });

      const after = (yield* snapshotQuery.getSnapshot()).threads.find(
        (thread) => thread.id === "thread-lane",
      );
      expect(after?.workflowLane).toBe("review");
      // updatedAt necessarily advances on any write; everything else must be untouched.
      const { workflowLane: _beforeLane, updatedAt: _beforeUpdatedAt, ...beforeRest } = before;
      const { workflowLane: _afterLane, updatedAt: _afterUpdatedAt, ...afterRest } = after ?? {};
      expect(afterRest).toEqual(beforeRest);
    }),
  );

  it.effect("create without explicit order appends using nextLaneOrder", () =>
    Effect.gen(function* () {
      const model = snapshotWithLanes([
        { id: LaneId.make("a"), name: "A", description: "A", order: 2 },
        { id: LaneId.make("b"), name: "B", description: "B", order: 5 },
      ]);

      const created = yield* decideOrchestrationCommand({
        command: {
          type: "lane.create",
          commandId: CommandId.make("cmd-append"),
          lane: {
            id: laneIdForName("Later", model.lanes),
            name: "Later",
            description: "Later",
            order: nextLaneOrder(model.lanes),
          },
        },
        readModel: model,
      });
      const events = Array.isArray(created) ? created : [created];
      const event = events[0];
      if (event === undefined) return yield* Effect.die("expected a planned event");
      if (event.type !== "lane.created") return yield* Effect.die("expected lane.created");

      expect(event.payload.lane.name).toBe("Later");
      expect(event.payload.lane.order).toBe(6);
    }),
  );
});
