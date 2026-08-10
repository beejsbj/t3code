import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const laneColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_lanes)
  `;
  if (laneColumns.some((column) => column.name === "interrupt")) {
    yield* sql`DROP TABLE IF EXISTS projection_lanes_plain`;
    yield* sql`
      CREATE TABLE projection_lanes_plain (
        lane_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        lane_order REAL NOT NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_lanes_plain (lane_id, name, description, lane_order)
      SELECT lane_id, name, description, lane_order
      FROM projection_lanes
    `;
    yield* sql`DROP TABLE projection_lanes`;
    yield* sql`ALTER TABLE projection_lanes_plain RENAME TO projection_lanes`;
  } else {
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_lanes (
        lane_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        lane_order REAL NOT NULL
      )
    `;
  }

  yield* sql`
    INSERT OR IGNORE INTO projection_lanes (lane_id, name, description, lane_order)
    VALUES
      ('triage', 'Triage', 'New and unplaced sessions start here until you file them elsewhere', -1)
  `;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const hasPlacementProvenance = threadColumns.some(
    (column) =>
      column.name === "workflow_lane_placed_by" || column.name === "workflow_lane_placement_reason",
  );
  if (hasPlacementProvenance) {
    yield* sql`DROP TABLE IF EXISTS projection_threads_plain`;
    yield* sql`
      CREATE TABLE projection_threads_plain (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        model_selection_json TEXT NOT NULL,
        runtime_mode TEXT NOT NULL,
        interaction_mode TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        latest_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        settled_override TEXT,
        settled_at TEXT,
        snoozed_until TEXT,
        snoozed_at TEXT,
        workflow_lane TEXT,
        title_regeneration_request_id TEXT,
        title_regeneration_started_at TEXT,
        latest_user_message_at TEXT,
        pending_approval_count INTEGER NOT NULL DEFAULT 0,
        pending_user_input_count INTEGER NOT NULL DEFAULT 0,
        has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT
      )
    `;
    yield* sql`
      INSERT INTO projection_threads_plain (
        thread_id,
        project_id,
        title,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        branch,
        worktree_path,
        latest_turn_id,
        created_at,
        updated_at,
        archived_at,
        settled_override,
        settled_at,
        snoozed_until,
        snoozed_at,
        workflow_lane,
        title_regeneration_request_id,
        title_regeneration_started_at,
        latest_user_message_at,
        pending_approval_count,
        pending_user_input_count,
        has_actionable_proposed_plan,
        deleted_at
      )
      SELECT
        thread_id,
        project_id,
        title,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        branch,
        worktree_path,
        latest_turn_id,
        created_at,
        updated_at,
        archived_at,
        settled_override,
        settled_at,
        snoozed_until,
        snoozed_at,
        workflow_lane,
        title_regeneration_request_id,
        title_regeneration_started_at,
        latest_user_message_at,
        pending_approval_count,
        pending_user_input_count,
        has_actionable_proposed_plan,
        deleted_at
      FROM projection_threads
    `;
    yield* sql`DROP TABLE projection_threads`;
    yield* sql`ALTER TABLE projection_threads_plain RENAME TO projection_threads`;

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_threads_project_id
      ON projection_threads(project_id)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_at
      ON projection_threads(project_id, archived_at)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_threads_project_deleted_created
      ON projection_threads(project_id, deleted_at, created_at)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_active
      ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_archived
      ON projection_threads(deleted_at, archived_at, project_id, thread_id)
    `;
  }
});
