import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionLaneInput,
  ProjectionLane,
  ProjectionLaneRepository,
  type ProjectionLaneRepositoryShape,
} from "../Services/ProjectionLanes.ts";

const makeProjectionLaneRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionLane,
    execute: (lane) => sql`
      INSERT INTO projection_lanes (lane_id, name, description, lane_order)
      VALUES (${lane.id}, ${lane.name}, ${lane.description}, ${lane.order})
      ON CONFLICT (lane_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        lane_order = excluded.lane_order
    `,
  });
  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionLaneInput,
    Result: ProjectionLane,
    execute: ({ laneId }) => sql`
      SELECT lane_id AS id, name, description, lane_order AS "order"
      FROM projection_lanes
      WHERE lane_id = ${laneId}
    `,
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLane,
    execute: () => sql`
      SELECT lane_id AS id, name, description, lane_order AS "order"
      FROM projection_lanes
      ORDER BY lane_order ASC, lane_id ASC
    `,
  });
  const deleteRow = SqlSchema.void({
    Request: GetProjectionLaneInput,
    execute: ({ laneId }) => sql`DELETE FROM projection_lanes WHERE lane_id = ${laneId}`,
  });

  return {
    upsert: (lane) =>
      upsertRow(lane).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionLaneRepository.upsert:query")),
      ),
    getById: (input) =>
      getRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionLaneRepository.getById:query")),
      ),
    listAll: () =>
      listRows().pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionLaneRepository.listAll:query")),
      ),
    deleteById: (input) =>
      deleteRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionLaneRepository.deleteById:query")),
      ),
  } satisfies ProjectionLaneRepositoryShape;
});

export const ProjectionLaneRepositoryLive = Layer.effect(
  ProjectionLaneRepository,
  makeProjectionLaneRepository,
);
