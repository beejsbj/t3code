import {
  AgentBoardError,
  type AgentBoardCommand,
  type AgentBoardHostResponse,
  type AgentBoardResult,
  type AgentBoardStreamEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface Host {
  readonly queue: Queue.Queue<AgentBoardStreamEvent>;
}

interface Pending {
  readonly clientId: number;
  readonly deferred: Deferred.Deferred<AgentBoardResult, AgentBoardError>;
}

interface State {
  readonly hosts: ReadonlyMap<number, Host>;
  readonly bindings: ReadonlyMap<ThreadId, number>;
  readonly pending: ReadonlyMap<string, Pending>;
}

export interface BoardAgentBrokerShape {
  readonly connect: (clientId: number) => Effect.Effect<Stream.Stream<AgentBoardStreamEvent>>;
  readonly respond: (clientId: number, response: AgentBoardHostResponse) => Effect.Effect<void>;
  readonly bind: (threadId: ThreadId, clientId: number) => Effect.Effect<void>;
  readonly invoke: (
    threadId: ThreadId,
    command: AgentBoardCommand,
  ) => Effect.Effect<AgentBoardResult, AgentBoardError>;
}

export class BoardAgentBroker extends Context.Service<BoardAgentBroker, BoardAgentBrokerShape>()(
  "t3/agentBoard/BoardAgentBroker",
) {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<State>({
    hosts: new Map(),
    bindings: new Map(),
    pending: new Map(),
  });

  const disconnect = Effect.fn("BoardAgentBroker.disconnect")(function* (
    clientId: number,
    queue: Host["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      if (current.hosts.get(clientId)?.queue !== queue)
        return [[] as Array<Pending>, current] as const;
      const hosts = new Map(current.hosts);
      hosts.delete(clientId);
      const pending = new Map(current.pending);
      const failures: Array<Pending> = [];
      for (const [requestId, entry] of current.pending) {
        if (entry.clientId === clientId) {
          pending.delete(requestId);
          failures.push(entry);
        }
      }
      return [failures, { ...current, hosts, pending }] as const;
    });
    yield* Effect.forEach(
      disconnected,
      ({ deferred }) =>
        Deferred.fail(
          deferred,
          new AgentBoardError({
            message: "The client that started this turn disconnected; no other client was used.",
          }),
        ),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const connect: BoardAgentBrokerShape["connect"] = Effect.fn("BoardAgentBroker.connect")(
    (clientId) =>
      Effect.succeed(
        Stream.unwrap(
          Effect.acquireRelease(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<AgentBoardStreamEvent>();
              const previous = yield* SynchronizedRef.modify(state, (current) => {
                const hosts = new Map(current.hosts);
                const old = hosts.get(clientId);
                hosts.set(clientId, { queue });
                return [old, { ...current, hosts }] as const;
              });
              if (previous) yield* Queue.shutdown(previous.queue);
              yield* Queue.offer(queue, { type: "connected" });
              return queue;
            }),
            (queue) => disconnect(clientId, queue),
          ).pipe(Effect.map(Stream.fromQueue)),
        ),
      ),
  );

  const respond: BoardAgentBrokerShape["respond"] = Effect.fn("BoardAgentBroker.respond")(
    function* (clientId, response) {
      const entry = yield* SynchronizedRef.modify(state, (current) => {
        const pending = current.pending.get(response.requestId);
        if (!pending || pending.clientId !== clientId) return [undefined, current] as const;
        const next = new Map(current.pending);
        next.delete(response.requestId);
        return [pending, { ...current, pending: next }] as const;
      });
      if (!entry) return;
      if (response.result !== undefined) yield* Deferred.succeed(entry.deferred, response.result);
      else
        yield* Deferred.fail(
          entry.deferred,
          new AgentBoardError({
            message: response.error ?? "The client returned no board result.",
          }),
        );
    },
  );

  const bind: BoardAgentBrokerShape["bind"] = Effect.fn("BoardAgentBroker.bind")(
    (threadId, clientId) =>
      SynchronizedRef.update(state, (current) => {
        const bindings = new Map(current.bindings);
        bindings.set(threadId, clientId);
        return { ...current, bindings };
      }),
  );

  const invoke: BoardAgentBrokerShape["invoke"] = Effect.fn("BoardAgentBroker.invoke")(
    function* (threadId, command) {
      const deferred = yield* Deferred.make<AgentBoardResult, AgentBoardError>();
      const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const host = yield* SynchronizedRef.modify(state, (current) => {
        const clientId = current.bindings.get(threadId);
        const connection = clientId ? current.hosts.get(clientId) : undefined;
        if (!clientId || !connection) return [undefined, current] as const;
        const pending = new Map(current.pending);
        pending.set(requestId, { clientId, deferred });
        return [
          { clientId, connection },
          { ...current, pending },
        ] as const;
      });
      if (!host) {
        return yield* new AgentBoardError({
          message:
            "Board commands are unavailable because the client that started this turn is not connected with board support.",
        });
      }
      const offered = yield* Queue.offer(host.connection.queue, {
        type: "request",
        request: { requestId, threadId, command },
      });
      if (!offered) {
        yield* SynchronizedRef.update(state, (current) => {
          const pending = new Map(current.pending);
          pending.delete(requestId);
          return { ...current, pending };
        });
        return yield* new AgentBoardError({
          message: "The originating client disconnected before the board command could be sent.",
        });
      }
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(
              new AgentBoardError({
                message:
                  "The originating client did not answer the board command within 15 seconds.",
              }),
            ),
        }),
        Effect.ensuring(
          SynchronizedRef.update(state, (current) => {
            const pending = new Map(current.pending);
            pending.delete(requestId);
            return { ...current, pending };
          }),
        ),
      );
    },
  );

  return { connect, respond, bind, invoke } satisfies BoardAgentBrokerShape;
});

export const layer = Layer.effect(BoardAgentBroker, make);
