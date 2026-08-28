import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentBoardLane = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  order: Schema.Number,
});
export type AgentBoardLane = typeof AgentBoardLane.Type;

export const AgentBoardPlacement = Schema.Struct({
  explicit: Schema.Boolean,
  lane: Schema.NullOr(AgentBoardLane),
});
export type AgentBoardPlacement = typeof AgentBoardPlacement.Type;

export const AgentBoardCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("lanes") }),
  Schema.Struct({ type: Schema.Literal("placement") }),
  Schema.Struct({ type: Schema.Literal("place"), lane: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("unplace") }),
]);
export type AgentBoardCommand = typeof AgentBoardCommand.Type;

export const AgentBoardResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("lanes"), lanes: Schema.Array(AgentBoardLane) }),
  Schema.Struct({ type: Schema.Literal("placement"), placement: AgentBoardPlacement }),
  Schema.Struct({ type: Schema.Literal("place"), placement: AgentBoardPlacement }),
  Schema.Struct({ type: Schema.Literal("unplace"), placement: AgentBoardPlacement }),
]);
export type AgentBoardResult = typeof AgentBoardResult.Type;

export const AgentBoardHostRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  command: AgentBoardCommand,
});
export type AgentBoardHostRequest = typeof AgentBoardHostRequest.Type;

export const AgentBoardStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected") }),
  Schema.Struct({ type: Schema.Literal("request"), request: AgentBoardHostRequest }),
]);
export type AgentBoardStreamEvent = typeof AgentBoardStreamEvent.Type;

export const AgentBoardHostResponse = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  result: Schema.optional(AgentBoardResult),
  error: Schema.optional(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter(
    (value) =>
      Number(value.result !== undefined) + Number(value.error !== undefined) === 1 ||
      "Provide exactly one of result or error.",
  ),
);
export type AgentBoardHostResponse = typeof AgentBoardHostResponse.Type;

export class AgentBoardError extends Schema.TaggedErrorClass<AgentBoardError>()("AgentBoardError", {
  message: TrimmedNonEmptyString,
}) {}
