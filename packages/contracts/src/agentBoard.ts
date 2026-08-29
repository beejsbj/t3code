import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentBoardLane = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  order: Schema.Number,
});
export type AgentBoardLane = typeof AgentBoardLane.Type;

export const AgentBoardLaneState = Schema.Struct({
  overridden: Schema.Boolean,
  lane: Schema.NullOr(AgentBoardLane),
});
export type AgentBoardLaneState = typeof AgentBoardLaneState.Type;

export const AgentBoardCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("lanes") }),
  Schema.Struct({ type: Schema.Literal("lane") }),
  Schema.Struct({ type: Schema.Literal("move"), lane: TrimmedNonEmptyString }),
]);
export type AgentBoardCommand = typeof AgentBoardCommand.Type;

export const AgentBoardResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("lanes"), lanes: Schema.Array(AgentBoardLane) }),
  Schema.Struct({ type: Schema.Literal("lane"), state: AgentBoardLaneState }),
  Schema.Struct({ type: Schema.Literal("move"), state: AgentBoardLaneState }),
]);
export type AgentBoardResult = typeof AgentBoardResult.Type;

export const AgentBoardClientKind = Schema.Literals(["desktop-renderer", "web"]);
export type AgentBoardClientKind = typeof AgentBoardClientKind.Type;

export const AgentBoardClient = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: AgentBoardClientKind,
});
export type AgentBoardClient = typeof AgentBoardClient.Type;

export const AgentBoardClientList = Schema.Struct({
  clients: Schema.Array(AgentBoardClient),
});
export type AgentBoardClientList = typeof AgentBoardClientList.Type;

export const AgentBoardManualCommandRequest = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  command: AgentBoardCommand,
});
export type AgentBoardManualCommandRequest = typeof AgentBoardManualCommandRequest.Type;

export const AgentBoardHostRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  expiresAtMs: Schema.Int,
  threadId: Schema.optional(ThreadId),
  command: AgentBoardCommand,
});
export type AgentBoardHostRequest = typeof AgentBoardHostRequest.Type;

export const AgentBoardConnectInput = AgentBoardClient;
export type AgentBoardConnectInput = typeof AgentBoardConnectInput.Type;

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
