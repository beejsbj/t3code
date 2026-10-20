import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId, type AgentBoardHostRequest, type AgentBoardResult } from "@t3tools/contracts";
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

/**
 * Connects a board host for `stableId` on websocket client `rpcClientId` that
 * answers every request with `lanesResult` and records which host served it.
 * Returns once the host is connected; interrupting the fiber disconnects it.
 */
const connectHost = (
  broker: BoardAgentBroker.BoardAgentBrokerShape,
  routedTo: Ref.Ref<ReadonlyArray<number>>,
  rpcClientId: number,
  stableId = rpcClientId,
  answer: (request: AgentBoardHostRequest) => Effect.Effect<void> = (request) =>
    broker.respond(rpcClientId, { requestId: request.requestId, result: lanesResult }),
) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const fiber = yield* Stream.runForEach(
      yield* broker.connect(rpcClientId, client(stableId)),
      (event) =>
        event.type === "connected"
          ? Deferred.succeed(ready, undefined)
          : Ref.update(routedTo, (hosts) => [...hosts, rpcClientId]).pipe(
              Effect.andThen(answer(event.request)),
            ),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    return fiber;
  });

it.effect("routes to the board window that last sent a message to the thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      yield* connectHost(broker, routedTo, 1);
      yield* connectHost(broker, routedTo, 2);

      yield* broker.recordOrigin(2, threadId);
      const first = yield* broker.invoke(threadId, { type: "lanes" });
      yield* broker.recordOrigin(1, threadId);
      const second = yield* broker.invoke(threadId, { type: "lanes" });

      expect(yield* Ref.get(routedTo)).toEqual([2, 1]);
      expect(first).toEqual({ result: lanesResult, client: client(2), routing: "origin" });
      expect(second.routing).toBe("origin");
      expect(second.client).toEqual(client(1));
    }),
  ),
);

it.effect("keeps the origin when a connection without a board sends a message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      yield* connectHost(broker, routedTo, 1);
      yield* connectHost(broker, routedTo, 2);

      yield* broker.recordOrigin(1, threadId);
      // Websocket client 9 (for example mobile) hosts no board.
      yield* broker.recordOrigin(9, threadId);
      yield* broker.invoke(threadId, { type: "lanes" });

      expect(yield* Ref.get(routedTo)).toEqual([1]);
    }),
  ),
);

it.effect("uses the only connected board when the thread has no known origin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      yield* connectHost(broker, routedTo, 1);

      const routed = yield* broker.invoke(threadId, { type: "lanes" });

      expect(routed.routing).toBe("only-client");
      expect(routed.client).toEqual(client(1));
      expect(yield* Ref.get(routedTo)).toEqual([1]);
    }),
  ),
);

it.effect("falls back to the one remaining board after the origin window closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      const origin = yield* connectHost(broker, routedTo, 1);
      yield* connectHost(broker, routedTo, 2);
      yield* broker.recordOrigin(1, threadId);
      yield* Fiber.interrupt(origin);

      const routed = yield* broker.invoke(threadId, { type: "lane" });

      expect(routed.routing).toBe("only-client");
      expect(yield* Ref.get(routedTo)).toEqual([2]);
    }),
  ),
);

it.effect("refuses to guess between several boards when the origin window is gone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      const origin = yield* connectHost(broker, routedTo, 1);
      yield* connectHost(broker, routedTo, 2);
      yield* connectHost(broker, routedTo, 3);
      yield* broker.recordOrigin(1, threadId);
      yield* Fiber.interrupt(origin);

      const gone = yield* Effect.flip(broker.invoke(threadId, { type: "move", lane: "review" }));
      const unknown = yield* Effect.flip(
        broker.invoke(ThreadId.make("thread-unknown"), { type: "lanes" }),
      );

      expect(gone.message).toContain("no longer connected");
      expect(gone.message).toContain("Nothing was changed");
      expect(unknown.message).toContain("has sent a message to this thread");
      expect(yield* Ref.get(routedTo)).toEqual([]);
    }),
  ),
);

it.effect("fails clearly when no board window is connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;

      const error = yield* Effect.flip(broker.invoke(threadId, { type: "lanes" }));

      expect(error.message).toContain("No T3 Code web or desktop window is connected");
    }),
  ),
);

it.effect("restores the origin when the same window reconnects on a new socket", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      const first = yield* connectHost(broker, routedTo, 1);
      yield* connectHost(broker, routedTo, 2);
      yield* broker.recordOrigin(1, threadId);
      yield* Fiber.interrupt(first);
      yield* connectHost(broker, routedTo, 3, 1);

      const routed = yield* broker.invoke(threadId, { type: "lanes" });

      expect(routed.routing).toBe("origin");
      expect(yield* Ref.get(routedTo)).toEqual([3]);
    }),
  ),
);

it.effect("ignores a response sent by a different websocket client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      const spoofed = yield* Deferred.make<void>();
      yield* connectHost(broker, routedTo, 1, 1, (request) =>
        broker
          .respond(2, { requestId: request.requestId, error: "spoofed" })
          .pipe(
            Effect.andThen(Deferred.succeed(spoofed, undefined)),
            Effect.andThen(
              broker.respond(1, { requestId: request.requestId, result: lanesResult }),
            ),
          ),
      );

      expect((yield* broker.invoke(threadId, { type: "lanes" })).result).toEqual(lanesResult);
      yield* Deferred.await(spoofed);
    }),
  ),
);

it.effect("fails in-flight commands when the same client replaces its host stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      const requestSeen = yield* Deferred.make<void>();
      yield* connectHost(broker, routedTo, 1, 1, () => Deferred.succeed(requestSeen, undefined));
      yield* broker.recordOrigin(1, threadId);
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
      const routedTo = yield* Ref.make<ReadonlyArray<number>>([]);
      yield* connectHost(broker, routedTo, 1);
      yield* connectHost(broker, routedTo, 2);

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
