import {
  AgentBoardError,
  type CommandId,
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
  readonly queue: Host["queue"];
  readonly deferred: Deferred.Deferred<AgentBoardResult, AgentBoardError>;
}

interface State {
  readonly hosts: ReadonlyMap<number, Host>;
  readonly bindings: ReadonlyMap<ThreadId, number>;
  readonly pending: ReadonlyMap<string, Pending>;
  readonly turnOrigins: ReadonlyMap<
    CommandId,
    { readonly clientId: number; readonly accepted: boolean }
  >;
}

export interface BoardAgentBrokerShape {
  readonly connect: (clientId: number) => Effect.Effect<Stream.Stream<AgentBoardStreamEvent>>;
  readonly respond: (clientId: number, response: AgentBoardHostResponse) => Effect.Effect<void>;
  readonly reserveTurnOrigin: (commandId: CommandId, clientId: number) => Effect.Effect<void>;
  readonly cancelTurnOrigin: (commandId: CommandId, clientId: number) => Effect.Effect<void>;
  readonly acceptTurnOrigin: (
    commandId: CommandId | null,
    threadId: ThreadId,
  ) => Effect.Effect<void>;
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
    turnOrigins: new Map(),
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
        if (entry.clientId === clientId && entry.queue === queue) {
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
              const replaced = yield* SynchronizedRef.modify(state, (current) => {
                const hosts = new Map(current.hosts);
                const old = hosts.get(clientId);
                hosts.set(clientId, { queue });
                const pending = new Map(current.pending);
                const disconnected: Array<Pending> = [];
                if (old) {
                  for (const [requestId, entry] of current.pending) {
                    if (entry.queue === old.queue) {
                      pending.delete(requestId);
                      disconnected.push(entry);
                    }
                  }
                }
                return [
                  { old, disconnected },
                  { ...current, hosts, pending },
                ] as const;
              });
              yield* Effect.forEach(
                replaced.disconnected,
                ({ deferred }) =>
                  Deferred.fail(
                    deferred,
                    new AgentBoardError({
                      message:
                        "The client board host was replaced while the command was in flight.",
                    }),
                  ),
                { discard: true },
              );
              if (replaced.old) yield* Queue.shutdown(replaced.old.queue);
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

  const reserveTurnOrigin: BoardAgentBrokerShape["reserveTurnOrigin"] = Effect.fn(
    "BoardAgentBroker.reserveTurnOrigin",
  )((commandId, clientId) =>
    SynchronizedRef.update(state, (current) => {
      if (current.turnOrigins.has(commandId)) return current;
      const turnOrigins = new Map(current.turnOrigins);
      turnOrigins.set(commandId, { clientId, accepted: false });
      while (turnOrigins.size > 2_048) {
        const oldest = turnOrigins.keys().next().value;
        if (oldest === undefined) break;
        turnOrigins.delete(oldest);
      }
      return { ...current, turnOrigins };
    }),
  );

  const cancelTurnOrigin: BoardAgentBrokerShape["cancelTurnOrigin"] = Effect.fn(
    "BoardAgentBroker.cancelTurnOrigin",
  )((commandId, clientId) =>
    SynchronizedRef.update(state, (current) => {
      const origin = current.turnOrigins.get(commandId);
      if (!origin || origin.accepted || origin.clientId !== clientId) return current;
      const turnOrigins = new Map(current.turnOrigins);
      turnOrigins.delete(commandId);
      return { ...current, turnOrigins };
    }),
  );

  const acceptTurnOrigin: BoardAgentBrokerShape["acceptTurnOrigin"] = Effect.fn(
    "BoardAgentBroker.acceptTurnOrigin",
  )((commandId, threadId) =>
    SynchronizedRef.update(state, (current) => {
      if (commandId === null) return current;
      const origin = current.turnOrigins.get(commandId);
      if (!origin || origin.accepted) return current;
      const bindings = new Map(current.bindings);
      bindings.set(threadId, origin.clientId);
      const turnOrigins = new Map(current.turnOrigins);
      turnOrigins.set(commandId, { ...origin, accepted: true });
      while (turnOrigins.size > 2_048) {
        const oldest = turnOrigins.keys().next().value;
        if (oldest === undefined) break;
        turnOrigins.delete(oldest);
      }
      return { ...current, bindings, turnOrigins };
    }),
  );

  const invoke: BoardAgentBrokerShape["invoke"] = Effect.fn("BoardAgentBroker.invoke")(
    function* (threadId, command) {
      const deferred = yield* Deferred.make<AgentBoardResult, AgentBoardError>();
      const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const host = yield* SynchronizedRef.modify(state, (current) => {
        const clientId = current.bindings.get(threadId);
        const connection = clientId === undefined ? undefined : current.hosts.get(clientId);
        if (clientId === undefined || !connection) return [undefined, current] as const;
        const pending = new Map(current.pending);
        pending.set(requestId, { clientId, queue: connection.queue, deferred });
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

  return {
    connect,
    respond,
    reserveTurnOrigin,
    cancelTurnOrigin,
    acceptTurnOrigin,
    invoke,
  } satisfies BoardAgentBrokerShape;
});

export const layer = Layer.effect(BoardAgentBroker, make);
