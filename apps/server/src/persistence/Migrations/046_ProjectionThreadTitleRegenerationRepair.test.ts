import { CommandId, LaneId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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
  pinnedAt: "2026-08-04T00:01:00.000Z",
  pinOrderKey: "gm",
  workflowLane: LaneId.make("review"),
  titleRegenerationRequestId: CommandId.make("legacy-title-request"),
  titleRegenerationStartedAt: "2026-08-04T00:01:00.000Z",
  latestUserMessageAt: "2026-08-04T00:01:00.000Z",
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasActionableProposedPlan: 0,
  deletedAt: null,
} satisfies ProjectionThread;

layer("046_ProjectionThreadTitleRegenerationRepair", (it) => {
  it.effect("repairs upstream migrations shadowed by old board migration ids", () =>
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
        [40, "ProjectionProjectFaviconPath"],
        [41, "ProjectionThreadsWorkflowLane"],
        [42, "ProjectionLanesAndPlacementProvenance"],
        [43, "ProjectionThreadsWorkflowLanePlacementReason"],
        [44, "ProjectionPlainLanes"],
        [45, "ProjectionLifecycleLanes"],
        [46, "ProjectionThreadTitleRegenerationRepair"],
      ]);

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const threadColumnNames = new Set(threadColumns.map((column) => column.name));
      assert.isTrue(threadColumnNames.has("pinned_at"));
      assert.isTrue(threadColumnNames.has("pin_order_key"));

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      const projectColumnNames = new Set(projectColumns.map((column) => column.name));
      assert.isTrue(projectColumnNames.has("default_thread_env_mode"));
      assert.isTrue(projectColumnNames.has("favicon_path"));

      const turnIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_projection_turns_thread_keyset'
      `;
      assert.lengthOf(turnIndexes, 1);

      yield* threads.upsert(threadRow);
      const persisted = yield* threads.getById({ threadId: threadRow.threadId });
      const persistedRow = Option.getOrNull(persisted);
      assert.equal(persistedRow?.settledOverride, "settled");
      assert.equal(persistedRow?.pinnedAt, "2026-08-04T00:01:00.000Z");
      assert.equal(persistedRow?.pinOrderKey, "gm");
      assert.equal(persistedRow?.workflowLane, "review");
      assert.equal(persistedRow?.titleRegenerationRequestId, "legacy-title-request");
      assert.equal(persistedRow?.titleRegenerationStartedAt, "2026-08-04T00:01:00.000Z");
    }),
  );
});
