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
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it as vitestIt } from "vite-plus/test";

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
  LaneNotFoundError,
  ThreadNotFoundError,
  countSessionsInLane,
  formatLaneList,
  laneIdForName,
  nextLaneOrder,
  sortedLanes,
} from "./lane.ts";
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
  assert.equal(laneIdForName("Ship It", LANES), "ship-it");
});

it.effect("refuses to archive a populated lane without --force", () =>
  Effect.gen(function* () {
    const snapshot: OrchestrationReadModel = {
      ...snapshotWithLanes([
        { id: LaneId.make("ready"), name: "Ready", description: "R", order: 0 },
      ]),
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
    assert.include(error.message, "--force");
  }),
);

it.effect("reports unknown lane ids with valid lane ids listed", () =>
  Effect.gen(function* () {
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
      validLaneIds: ["triage", "ready"],
    });
    assert.include(threadError.message, "missing-thread");
    assert.include(threadError.message, "'ready'");
    assert.isAtLeast(snapshot.lanes.length, 1);
  }),
);

async function createOrchestrationSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-lane-cli-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
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
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

const now = () => "2026-01-01T00:00:00.000Z";

describe("lane move", () => {
  vitestIt("sets workflowLane without changing other thread fields", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-lane-project"),
        projectId: ProjectId.make("project-lane"),
        title: "Lane Project",
        workspaceRoot: "/tmp/lane-project",
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "lane.create",
        commandId: CommandId.make("cmd-lane-create"),
        lane: {
          id: LaneId.make("review"),
          name: "Review",
          description: "Review queue",
          order: 0,
        },
      }),
    );
    await system.run(
      system.engine.dispatch({
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
      }),
    );

    const before = (await system.readModel()).threads.find((thread) => thread.id === "thread-lane");
    expect(before).toBeDefined();
    if (!before) throw new Error("missing thread");

    await system.run(
      system.engine.dispatch({
        type: "thread.workflow-lane.set",
        commandId: CommandId.make("cmd-lane-move"),
        threadId: ThreadId.make("thread-lane"),
        workflowLane: LaneId.make("review"),
      }),
    );

    const after = (await system.readModel()).threads.find((thread) => thread.id === "thread-lane");
    expect(after?.workflowLane).toBe("review");
    // updatedAt necessarily advances on any write; everything else must be untouched.
    const { workflowLane: _beforeLane, updatedAt: _beforeUpdatedAt, ...beforeRest } = before;
    const { workflowLane: _afterLane, updatedAt: _afterUpdatedAt, ...afterRest } = after ?? {};
    expect(afterRest).toEqual(beforeRest);

    await system.dispose();
  });

  vitestIt("create without explicit order appends using nextLaneOrder", async () => {
    const model = snapshotWithLanes([
      { id: LaneId.make("a"), name: "A", description: "A", order: 2 },
      { id: LaneId.make("b"), name: "B", description: "B", order: 5 },
    ]);

    const created = await Effect.runPromise(
      decideOrchestrationCommand({
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
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const events = Array.isArray(created) ? created : [created];
    const event = events[0];
    if (event === undefined) throw new Error("expected a planned event");
    if (event.type !== "lane.created") throw new Error("expected lane.created");

    expect(event.payload.lane.name).toBe("Later");
    expect(event.payload.lane.order).toBe(6);
  });
});
