import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadRepositoryLive } from "../Layers/ProjectionThreads.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../Services/ProjectionThreads.ts";

const sqliteLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(sqliteLayer)));

const threadRow = {
  threadId: ThreadId.make("legacy-board-thread"),
  projectId: ProjectId.make("project-1"),
  title: "Legacy board thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurnId: null,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
  archivedAt: null,
  settledOverride: "settled",
  settledAt: "2026-08-04T00:01:00.000Z",
  snoozedUntil: null,
  snoozedAt: null,
  workflowLane: null,
  titleRegenerationRequestId: CommandId.make("legacy-title-request"),
  titleRegenerationStartedAt: "2026-08-04T00:01:00.000Z",
  latestUserMessageAt: "2026-08-04T00:01:00.000Z",
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasActionableProposedPlan: 0,
  deletedAt: null,
} satisfies ProjectionThread;

layer("041_ProjectionThreadTitleRegenerationRepair", (it) => {
  it.effect("repairs databases whose old board migration ids shadowed title regeneration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ProjectionThreadRepository;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_lane TEXT`;
      yield* sql`
        CREATE TABLE projection_lanes (
          lane_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          lane_order REAL NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (35, 'ProjectionThreadsWorkflowLane'),
          (36, 'ProjectionLanesAndPlacementProvenance'),
          (37, 'ProjectionThreadsWorkflowLanePlacementReason'),
          (38, 'ProjectionPlainLanes'),
          (39, 'ProjectionLifecycleLanes')
      `;

      const columnsBeforeRepair = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const columnNamesBeforeRepair = new Set(columnsBeforeRepair.map((column) => column.name));
      assert.notOk(columnNamesBeforeRepair.has("title_regeneration_request_id"));
      assert.notOk(columnNamesBeforeRepair.has("title_regeneration_started_at"));

      const executed = yield* runMigrations();
      assert.deepEqual(executed, [
        [40, "ProjectionLifecycleLanes"],
        [41, "ProjectionThreadTitleRegenerationRepair"],
      ]);

      yield* threads.upsert(threadRow);
      const persisted = yield* threads.getById({ threadId: threadRow.threadId });
      const persistedRow = Option.getOrNull(persisted);
      assert.equal(persistedRow?.settledOverride, "settled");
      assert.equal(persistedRow?.titleRegenerationRequestId, "legacy-title-request");
      assert.equal(persistedRow?.titleRegenerationStartedAt, "2026-08-04T00:01:00.000Z");
    }),
  );
});
