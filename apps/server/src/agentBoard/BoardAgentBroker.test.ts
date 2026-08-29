import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, ThreadId, type AgentBoardResult } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as BoardAgentBroker from "./BoardAgentBroker.ts";

const makeBroker = BoardAgentBroker.make.pipe(Effect.provide(NodeServices.layer));
const threadId = ThreadId.make("thread-1");
const lanesResult: AgentBoardResult = { type: "lanes", lanes: [] };
const client = (clientId: number) => ({
  clientId: `client-${clientId}`,
  label: `Client ${clientId}`,
  kind: "web" as const,
});
const acceptOrigin = (
  broker: BoardAgentBroker.BoardAgentBrokerShape,
  clientId: number,
  suffix: string,
) => {
  const commandId = CommandId.make(`command-${suffix}`);
  return broker
    .reserveTurnOrigin(commandId, clientId)
    .pipe(Effect.andThen(broker.acceptTurnOrigin(commandId, threadId)));
};

it.effect("routes only to the exact client bound by the accepted turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const aReady = yield* Deferred.make<void>();
      const bReady = yield* Deferred.make<void>();
      const bRequests = yield* Ref.make(0);
      yield* Stream.runForEach(yield* broker.connect(1, client(1)), (event) => {
        if (event.type === "connected") return Deferred.succeed(aReady, undefined);
        return broker.respond(1, { requestId: event.request.requestId, result: lanesResult });
      }).pipe(Effect.forkScoped);
      yield* Stream.runForEach(yield* broker.connect(2, client(2)), (event) => {
        if (event.type === "connected") return Deferred.succeed(bReady, undefined);
        return Ref.update(bRequests, (count) => count + 1);
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(aReady);
      yield* Deferred.await(bReady);
      yield* acceptOrigin(broker, 1, "routes");

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
      const aFiber = yield* Stream.runForEach(yield* broker.connect(1, client(1)), (event) =>
        event.type === "connected" ? Deferred.succeed(aReady, undefined) : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(yield* broker.connect(2, client(2)), (event) => {
        if (event.type === "connected") return Deferred.succeed(bReady, undefined);
        return Ref.update(bRequests, (count) => count + 1);
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(aReady);
      yield* Deferred.await(bReady);
      yield* acceptOrigin(broker, 1, "disconnect");
      yield* Fiber.interrupt(aFiber);

      const result = yield* Effect.flip(broker.invoke(threadId, { type: "lane" }));
      expect(result.message).toContain("not connected");
      expect(yield* Ref.get(bRequests)).toBe(0);
    }),
  ),
);

it.effect("restores an active binding when the same renderer reconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const firstReady = yield* Deferred.make<void>();
      const reconnected = yield* Deferred.make<void>();
      const firstHost = yield* Stream.runForEach(yield* broker.connect(1, client(1)), (event) =>
        event.type === "connected" ? Deferred.succeed(firstReady, undefined) : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReady);
      yield* acceptOrigin(broker, 1, "reconnect");
      yield* Fiber.interrupt(firstHost);

      yield* Stream.runForEach(yield* broker.connect(3, client(1)), (event) => {
        if (event.type === "connected") return Deferred.succeed(reconnected, undefined);
        return broker.respond(3, { requestId: event.request.requestId, result: lanesResult });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(reconnected);

      expect(yield* broker.invoke(threadId, { type: "lanes" })).toEqual(lanesResult);
    }),
  ),
);

it.effect("ignores a response sent by a different websocket client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requestSeen = yield* Deferred.make<void>();
      const connected = yield* Deferred.make<void>();
      yield* Stream.runForEach(yield* broker.connect(1, client(1)), (event) => {
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
      yield* acceptOrigin(broker, 1, "spoof");

      expect(yield* broker.invoke(threadId, { type: "lanes" })).toEqual(lanesResult);
      yield* Deferred.await(requestSeen);
    }),
  ),
);

it.effect("does not move an active binding until the queued turn is accepted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const aReady = yield* Deferred.make<void>();
      const bReady = yield* Deferred.make<void>();
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      for (const [clientId, ready] of [
        [1, aReady],
        [2, bReady],
      ] as const) {
        yield* Stream.runForEach(yield* broker.connect(clientId, client(clientId)), (event) => {
          if (event.type === "connected") return Deferred.succeed(ready, undefined);
          return Ref.update(routedTo, (clients) => [...clients, clientId]).pipe(
            Effect.andThen(
              broker.respond(clientId, {
                requestId: event.request.requestId,
                result: lanesResult,
              }),
            ),
          );
        }).pipe(Effect.forkScoped);
      }
      yield* Deferred.await(aReady);
      yield* Deferred.await(bReady);
      yield* acceptOrigin(broker, 1, "active-a");
      const queuedCommandId = CommandId.make("command-queued-b");
      yield* broker.reserveTurnOrigin(queuedCommandId, 2);

      yield* broker.invoke(threadId, { type: "lanes" });
      yield* broker.acceptTurnOrigin(queuedCommandId, threadId);
      yield* broker.invoke(threadId, { type: "lanes" });

      expect(yield* Ref.get(routedTo)).toEqual([1, 2]);
    }),
  ),
);

it.effect("fails in-flight commands when the same client replaces its host stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const connected = yield* Deferred.make<void>();
      const requestSeen = yield* Deferred.make<void>();
      yield* Stream.runForEach(yield* broker.connect(1, client(1)), (event) =>
        event.type === "connected"
          ? Deferred.succeed(connected, undefined)
          : Deferred.succeed(requestSeen, undefined),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      yield* acceptOrigin(broker, 1, "replacement");
      const invocation = yield* broker.invoke(threadId, { type: "lanes" }).pipe(Effect.forkScoped);
      yield* Deferred.await(requestSeen);
      yield* Stream.runDrain(yield* broker.connect(1, client(1))).pipe(Effect.forkScoped);

      const error = yield* Fiber.join(invocation).pipe(Effect.flip);
      expect(error.message).toContain("replaced");
    }),
  ),
);

it.effect("lists stable clients and manually routes only to the selected client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const aReady = yield* Deferred.make<void>();
      const bReady = yield* Deferred.make<void>();
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      for (const [rpcClientId, ready] of [
        [1, aReady],
        [2, bReady],
      ] as const) {
        yield* Stream.runForEach(
          yield* broker.connect(rpcClientId, client(rpcClientId)),
          (event) => {
            if (event.type === "connected") return Deferred.succeed(ready, undefined);
            return Ref.update(routedTo, (clients) => [...clients, rpcClientId]).pipe(
              Effect.andThen(
                broker.respond(rpcClientId, {
                  requestId: event.request.requestId,
                  result: lanesResult,
                }),
              ),
            );
          },
        ).pipe(Effect.forkScoped);
      }
      yield* Deferred.await(aReady);
      yield* Deferred.await(bReady);

      expect(yield* broker.listClients()).toEqual([client(1), client(2)]);
      expect(yield* broker.invokeClient("client-2", undefined, { type: "lanes" })).toEqual(
        lanesResult,
      );
      expect(yield* Ref.get(routedTo)).toEqual([2]);

      const error = yield* Effect.flip(
        broker.invokeClient("missing-client", undefined, { type: "lanes" }),
      );
      expect(error.message).toContain("missing-client");
      expect(yield* Ref.get(routedTo)).toEqual([2]);
    }),
  ),
);
