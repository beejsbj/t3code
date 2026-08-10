import { LaneDefinition, LaneId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionLane = LaneDefinition;
export type ProjectionLane = typeof ProjectionLane.Type;

export const GetProjectionLaneInput = Schema.Struct({ laneId: LaneId });
export type GetProjectionLaneInput = typeof GetProjectionLaneInput.Type;

export interface ProjectionLaneRepositoryShape {
  readonly upsert: (lane: ProjectionLane) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionLaneInput,
  ) => Effect.Effect<Option.Option<ProjectionLane>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionLane>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: GetProjectionLaneInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionLaneRepository extends Context.Service<
  ProjectionLaneRepository,
  ProjectionLaneRepositoryShape
>()("t3/persistence/Services/ProjectionLanes/ProjectionLaneRepository") {}
