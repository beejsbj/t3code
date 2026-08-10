import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadRepositoryLive } from "../Layers/ProjectionThreads.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import Migration044 from "./044_ProjectionPlainLanes.ts";

const sqliteLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(sqliteLayer)));
const retryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

retryLayer("044_ProjectionPlainLanes retry", (it) => {
  it.effect("discards stale lane and thread staging tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });

      yield* sql`CREATE TABLE projection_lanes_plain (stale TEXT)`;
      yield* sql`CREATE TABLE projection_threads_plain (stale TEXT)`;

      yield* Migration044;

      const lanes = yield* sql<{ readonly laneId: string }>`
        SELECT lane_id AS "laneId" FROM projection_lanes ORDER BY lane_id
      `;
      assert.isTrue(lanes.some((lane) => lane.laneId === "triage"));

      const stagingTables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('projection_lanes_plain', 'projection_threads_plain')
      `;
      assert.deepEqual(stagingTables, []);
    }),
  );
});

layer("044_ProjectionPlainLanes", (it) => {
  it.effect("keeps the projection thread schema aligned with repository writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ProjectionThreadRepository;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at,
          title_regeneration_request_id,
          title_regeneration_started_at
        )
        VALUES (
          'thread-before-044',
          'project-1',
          'Before migration',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-08-04T00:00:00.000Z',
          '2026-08-04T00:00:00.000Z',
          'title-request-before-044',
          '2026-08-04T00:01:00.000Z'
        )
      `;

      yield* sql`
        UPDATE projection_threads
        SET pinned_at = '2026-08-04T00:01:30.000Z', pin_order_key = 'gm'
        WHERE thread_id = 'thread-before-044'
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const migrated = yield* threads.getById({
        threadId: ThreadId.make("thread-before-044"),
      });
      const migratedRow = Option.getOrNull(migrated);
      if (!migratedRow) {
        return yield* Effect.die("Expected the migration to preserve the projection thread.");
      }
      assert.equal(migratedRow.titleRegenerationRequestId, "title-request-before-044");
      assert.equal(migratedRow.titleRegenerationStartedAt, "2026-08-04T00:01:00.000Z");
      assert.equal(migratedRow.pinnedAt, "2026-08-04T00:01:30.000Z");
      assert.equal(migratedRow.pinOrderKey, "gm");

      yield* threads.upsert({
        threadId: ThreadId.make("thread-after-044"),
        projectId: ProjectId.make("project-1"),
        title: "After migration",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-08-04T00:02:00.000Z",
        updatedAt: "2026-08-04T00:02:00.000Z",
        archivedAt: null,
        settledOverride: "settled",
        settledAt: "2026-08-04T00:02:00.000Z",
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: "2026-08-04T00:02:00.000Z",
        pinOrderKey: "h",
        workflowLane: null,
        titleRegenerationRequestId: CommandId.make("title-request-after-044"),
        titleRegenerationStartedAt: "2026-08-04T00:02:00.000Z",
        latestUserMessageAt: "2026-08-04T00:02:00.000Z",
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const inserted = yield* threads.getById({
        threadId: ThreadId.make("thread-after-044"),
      });
      assert.equal(Option.getOrNull(inserted)?.settledOverride, "settled");
      assert.equal(
        Option.getOrNull(inserted)?.titleRegenerationRequestId,
        "title-request-after-044",
      );
      assert.equal(Option.getOrNull(inserted)?.pinOrderKey, "h");
    }),
  );
});
