import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_lanes (
      lane_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      lane_order REAL NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_lanes (lane_id, name, description, lane_order)
    SELECT
      'settled',
      'Settled',
      'Sessions you have settled or that have gone quiet',
      COALESCE((SELECT MAX(lane_order) FROM projection_lanes), -1) + 1
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_lanes (lane_id, name, description, lane_order)
    SELECT
      'snoozed',
      'Snoozed',
      'Sessions snoozed until a later time',
      COALESCE((SELECT MAX(lane_order) FROM projection_lanes), -1) + 1
  `;
});
