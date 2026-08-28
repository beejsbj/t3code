import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId, type AgentBoardResult } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as BoardAgentBroker from "./BoardAgentBroker.ts";

const makeBroker = BoardAgentBroker.make.pipe(Effect.provide(NodeServices.layer));
const threadId = ThreadId.make("thread-1");
const lanesResult: AgentBoardResult = { type: "lanes", lanes: [] };

it.effect("routes only to the exact client bound by the accepted turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const aReady = yield* Deferred.make<void>();
      const bReady = yield* Deferred.make<void>();
      const bRequests = yield* Ref.make(0);
      yield* Stream.runForEach(yield* broker.connect(1), (event) => {
        if (event.type === "connected") return Deferred.succeed(aReady, undefined);
        return broker.respond(1, { requestId: event.request.requestId, result: lanesResult });
      }).pipe(Effect.forkScoped);
      yield* Stream.runForEach(yield* broker.connect(2), (event) => {
        if (event.type === "connected") return Deferred.succeed(bReady, undefined);
        return Ref.update(bRequests, (count) => count + 1);
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(aReady);
      yield* Deferred.await(bReady);
      yield* broker.bind(threadId, 1);

      expect(yield* broker.invoke(threadId, { type: "lanes" })).toEqual(lanesResult);
      expect(yield* Ref.get(bRequests)).toBe(0);
    }),
  ),
);

it.effect("keeps the binding on disconnect and never falls back to another client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const aReady = yield* Deferred.make<void>();
      const bReady = yield* Deferred.make<void>();
      const bRequests = yield* Ref.make(0);
      const aFiber = yield* Stream.runForEach(yield* broker.connect(1), (event) =>
        event.type === "connected" ? Deferred.succeed(aReady, undefined) : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(yield* broker.connect(2), (event) => {
        if (event.type === "connected") return Deferred.succeed(bReady, undefined);
        return Ref.update(bRequests, (count) => count + 1);
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(aReady);
      yield* Deferred.await(bReady);
      yield* broker.bind(threadId, 1);
      yield* Fiber.interrupt(aFiber);

      const result = yield* Effect.flip(broker.invoke(threadId, { type: "placement" }));
      expect(result.message).toContain("not connected");
      expect(yield* Ref.get(bRequests)).toBe(0);
    }),
  ),
);

it.effect("ignores a response sent by a different websocket client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requestSeen = yield* Deferred.make<void>();
      const connected = yield* Deferred.make<void>();
      yield* Stream.runForEach(yield* broker.connect(1), (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        return broker
          .respond(2, { requestId: event.request.requestId, result: lanesResult })
          .pipe(
            Effect.andThen(Deferred.succeed(requestSeen, undefined)),
            Effect.andThen(
              broker.respond(1, { requestId: event.request.requestId, result: lanesResult }),
            ),
          );
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      yield* broker.bind(threadId, 1);

      expect(yield* broker.invoke(threadId, { type: "lanes" })).toEqual(lanesResult);
      yield* Deferred.await(requestSeen);
    }),
  ),
);
