import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "workflow_lane_placed_by")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workflow_lane_placed_by TEXT
    `;
  }
  if (!columns.some((column) => column.name === "workflow_lane_placed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workflow_lane_placed_at TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_lanes (
      lane_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      lane_order REAL NOT NULL,
      interrupt TEXT NOT NULL
    )
  `;

  const laneColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_lanes)
  `;
  if (laneColumns.some((column) => column.name === "interrupt")) {
    yield* sql`
      INSERT OR IGNORE INTO projection_lanes (lane_id, name, description, lane_order, interrupt)
      VALUES
        ('shaping', 'Grilling / shaping', 'Working out what this actually is', 0, 'badge'),
        ('ready', 'Ready', 'Groomed and ready to pick up', 1, 'move'),
        ('done', 'Done', 'Finished, or pinned settled', 2, 'move')
    `;
  } else {
    yield* sql`
      INSERT OR IGNORE INTO projection_lanes (lane_id, name, description, lane_order)
      VALUES
        ('shaping', 'Grilling / shaping', 'Working out what this actually is', 0),
        ('ready', 'Ready', 'Groomed and ready to pick up', 1),
        ('done', 'Done', 'Finished, or pinned settled', 2)
    `;
  }
});
