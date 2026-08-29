import {
  AgentBoardError,
  type AgentBoardClient,
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
  readonly client: AgentBoardClient;
  readonly queue: Queue.Queue<AgentBoardStreamEvent>;
}

interface Pending {
  readonly rpcClientId: number;
  readonly queue: Host["queue"];
  readonly deferred: Deferred.Deferred<AgentBoardResult, AgentBoardError>;
}

interface State {
  readonly hosts: ReadonlyMap<number, Host>;
  readonly rpcClientIdByStableId: ReadonlyMap<string, number>;
  readonly bindings: ReadonlyMap<ThreadId, number>;
  readonly pending: ReadonlyMap<string, Pending>;
  readonly turnOrigins: ReadonlyMap<
    CommandId,
    { readonly clientId: number; readonly accepted: boolean }
  >;
}

export interface BoardAgentBrokerShape {
  readonly connect: (
    rpcClientId: number,
    client: AgentBoardClient,
  ) => Effect.Effect<Stream.Stream<AgentBoardStreamEvent>>;
  readonly respond: (clientId: number, response: AgentBoardHostResponse) => Effect.Effect<void>;
  readonly listClients: () => Effect.Effect<ReadonlyArray<AgentBoardClient>>;
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
  readonly invokeClient: (
    clientId: string,
    threadId: ThreadId | undefined,
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
    rpcClientIdByStableId: new Map(),
    bindings: new Map(),
    pending: new Map(),
    turnOrigins: new Map(),
  });

  const disconnect = Effect.fn("BoardAgentBroker.disconnect")(function* (
    rpcClientId: number,
    queue: Host["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      const host = current.hosts.get(rpcClientId);
      if (host?.queue !== queue) return [[] as Array<Pending>, current] as const;
      const hosts = new Map(current.hosts);
      hosts.delete(rpcClientId);
      const rpcClientIdByStableId = new Map(current.rpcClientIdByStableId);
      if (rpcClientIdByStableId.get(host.client.clientId) === rpcClientId) {
        rpcClientIdByStableId.delete(host.client.clientId);
      }
      const pending = new Map(current.pending);
      const failures: Array<Pending> = [];
      for (const [requestId, entry] of current.pending) {
        if (entry.rpcClientId === rpcClientId && entry.queue === queue) {
          pending.delete(requestId);
          failures.push(entry);
        }
      }
      return [failures, { ...current, hosts, rpcClientIdByStableId, pending }] as const;
    });
    yield* Effect.forEach(
      disconnected,
      ({ deferred }) =>
        Deferred.fail(
          deferred,
          new AgentBoardError({
            message: "The selected board client disconnected; no other client was used.",
          }),
        ),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const connect: BoardAgentBrokerShape["connect"] = Effect.fn("BoardAgentBroker.connect")(
    (rpcClientId, client) =>
      Effect.succeed(
        Stream.unwrap(
          Effect.acquireRelease(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<AgentBoardStreamEvent>();
              const replaced = yield* SynchronizedRef.modify(state, (current) => {
                const hosts = new Map(current.hosts);
                const rpcClientIdByStableId = new Map(current.rpcClientIdByStableId);
                const replacedHosts = new Map<Queue.Queue<AgentBoardStreamEvent>, Host>();
                const oldForConnection = hosts.get(rpcClientId);
                if (oldForConnection) replacedHosts.set(oldForConnection.queue, oldForConnection);
                const oldRpcClientId = rpcClientIdByStableId.get(client.clientId);
                const oldForStableId =
                  oldRpcClientId === undefined ? undefined : hosts.get(oldRpcClientId);
                if (oldForStableId) replacedHosts.set(oldForStableId.queue, oldForStableId);
                for (const old of replacedHosts.values()) {
                  for (const [hostRpcClientId, host] of hosts) {
                    if (host.queue === old.queue) hosts.delete(hostRpcClientId);
                  }
                  if (rpcClientIdByStableId.get(old.client.clientId) !== undefined) {
                    rpcClientIdByStableId.delete(old.client.clientId);
                  }
                }
                const host = { client, queue } satisfies Host;
                hosts.set(rpcClientId, host);
                rpcClientIdByStableId.set(client.clientId, rpcClientId);
                const pending = new Map(current.pending);
                const disconnected: Array<Pending> = [];
                if (replacedHosts.size > 0) {
                  for (const [requestId, entry] of current.pending) {
                    if (replacedHosts.has(entry.queue)) {
                      pending.delete(requestId);
                      disconnected.push(entry);
                    }
                  }
                }
                return [
                  { old: [...replacedHosts.values()], disconnected },
                  { ...current, hosts, rpcClientIdByStableId, pending },
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
              yield* Effect.forEach(replaced.old, (host) => Queue.shutdown(host.queue), {
                discard: true,
              });
              yield* Queue.offer(queue, { type: "connected" });
              return queue;
            }),
            (queue) => disconnect(rpcClientId, queue),
          ).pipe(Effect.map(Stream.fromQueue)),
        ),
      ),
  );

  const respond: BoardAgentBrokerShape["respond"] = Effect.fn("BoardAgentBroker.respond")(
    function* (rpcClientId, response) {
      const entry = yield* SynchronizedRef.modify(state, (current) => {
        const pending = current.pending.get(response.requestId);
        if (!pending || pending.rpcClientId !== rpcClientId) return [undefined, current] as const;
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

  const listClients: BoardAgentBrokerShape["listClients"] = Effect.fn(
    "BoardAgentBroker.listClients",
  )(() =>
    SynchronizedRef.get(state).pipe(
      Effect.map((current) =>
        [...current.hosts.values()]
          .map((host) => host.client)
          .toSorted((left, right) => left.label.localeCompare(right.label)),
      ),
    ),
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

  const invokeResolved = Effect.fn("BoardAgentBroker.invokeResolved")(function* (
    threadId: ThreadId | undefined,
    command: AgentBoardCommand,
    select: (
      current: State,
    ) => { readonly rpcClientId: number; readonly connection: Host } | undefined,
    unavailableMessage: string,
  ) {
    const deferred = yield* Deferred.make<AgentBoardResult, AgentBoardError>();
    const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const host = yield* SynchronizedRef.modify(state, (current) => {
      const selected = select(current);
      if (!selected) return [undefined, current] as const;
      const pending = new Map(current.pending);
      pending.set(requestId, {
        rpcClientId: selected.rpcClientId,
        queue: selected.connection.queue,
        deferred,
      });
      return [selected, { ...current, pending }] as const;
    });
    if (!host) {
      return yield* new AgentBoardError({ message: unavailableMessage });
    }
    const offered = yield* Queue.offer(host.connection.queue, {
      type: "request",
      request: threadId === undefined ? { requestId, command } : { requestId, threadId, command },
    });
    if (!offered) {
      yield* SynchronizedRef.update(state, (current) => {
        const pending = new Map(current.pending);
        pending.delete(requestId);
        return { ...current, pending };
      });
      return yield* new AgentBoardError({
        message: "The selected board client disconnected before the command could be sent.",
      });
    }
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(
            new AgentBoardError({
              message: "The selected board client did not answer within 15 seconds.",
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
  });

  const invoke: BoardAgentBrokerShape["invoke"] = Effect.fn("BoardAgentBroker.invoke")(
    (threadId, command) =>
      invokeResolved(
        threadId,
        command,
        (current) => {
          const rpcClientId = current.bindings.get(threadId);
          const connection = rpcClientId === undefined ? undefined : current.hosts.get(rpcClientId);
          return rpcClientId === undefined || !connection ? undefined : { rpcClientId, connection };
        },
        "Board commands are unavailable because the client that started this turn is not connected with board support.",
      ),
  );

  const invokeClient: BoardAgentBrokerShape["invokeClient"] = Effect.fn(
    "BoardAgentBroker.invokeClient",
  )((clientId, threadId, command) =>
    invokeResolved(
      threadId,
      command,
      (current) => {
        const rpcClientId = current.rpcClientIdByStableId.get(clientId);
        const connection = rpcClientId === undefined ? undefined : current.hosts.get(rpcClientId);
        return rpcClientId === undefined || !connection ? undefined : { rpcClientId, connection };
      },
      `Board client ${clientId} is not connected to this server.`,
    ),
  );

  return {
    connect,
    respond,
    listClients,
    reserveTurnOrigin,
    cancelTurnOrigin,
    acceptTurnOrigin,
    invoke,
    invokeClient,
  } satisfies BoardAgentBrokerShape;
});

export const layer = Layer.effect(BoardAgentBroker, make);
