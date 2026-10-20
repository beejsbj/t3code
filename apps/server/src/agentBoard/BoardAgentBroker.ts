import {
  AgentBoardError,
  type AgentBoardClient,
  type AgentBoardCommand,
  type AgentBoardHostResponse,
  type AgentBoardResult,
  type AgentBoardStreamEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
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

const REQUEST_EXECUTION_WINDOW_MS = 12_000;
const MAX_REMEMBERED_ORIGINS = 2_048;

interface State {
  readonly hosts: ReadonlyMap<number, Host>;
  readonly rpcClientIdByStableId: ReadonlyMap<string, number>;
  /** Board client id (one per page load, kept across socket reconnects) that last messaged each thread. */
  readonly origins: ReadonlyMap<ThreadId, string>;
  readonly pending: ReadonlyMap<string, Pending>;
}

/**
 * `origin`: the board client that last sent a message to the thread.
 * `only-client`: that client is unknown or gone, and exactly one board client
 * is connected, so it was used instead.
 */
export type AgentBoardRouting = "origin" | "only-client";

export interface AgentBoardRoutedResult {
  readonly result: AgentBoardResult;
  readonly client: AgentBoardClient;
  readonly routing: AgentBoardRouting;
}

interface Selected {
  readonly rpcClientId: number;
  readonly connection: Host;
  readonly routing: AgentBoardRouting;
}

export interface BoardAgentBrokerShape {
  readonly connect: (
    rpcClientId: number,
    client: AgentBoardClient,
  ) => Effect.Effect<Stream.Stream<AgentBoardStreamEvent>>;
  readonly respond: (clientId: number, response: AgentBoardHostResponse) => Effect.Effect<void>;
  readonly listClients: () => Effect.Effect<ReadonlyArray<AgentBoardClient>>;
  /**
   * Records that the websocket client `rpcClientId` sent a message to
   * `threadId`. A connection that is not hosting a board (mobile, a client that
   * has not subscribed yet) leaves the thread's previous origin in place.
   */
  readonly recordOrigin: (rpcClientId: number, threadId: ThreadId) => Effect.Effect<void>;
  /** Runs a board command for `threadId` on the board that thread's user is looking at. */
  readonly invoke: (
    threadId: ThreadId,
    command: AgentBoardCommand,
  ) => Effect.Effect<AgentBoardRoutedResult, AgentBoardError>;
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
    origins: new Map(),
    pending: new Map(),
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

  const recordOrigin: BoardAgentBrokerShape["recordOrigin"] = Effect.fn(
    "BoardAgentBroker.recordOrigin",
  )((rpcClientId, threadId) =>
    SynchronizedRef.update(state, (current) => {
      const host = current.hosts.get(rpcClientId);
      if (!host) return current;
      const origins = new Map(current.origins);
      // Re-inserting keeps the map in recency order, so trimming drops the stalest thread.
      origins.delete(threadId);
      origins.set(threadId, host.client.clientId);
      while (origins.size > MAX_REMEMBERED_ORIGINS) {
        const oldest = origins.keys().next().value;
        if (oldest === undefined) break;
        origins.delete(oldest);
      }
      return { ...current, origins };
    }),
  );

  const invokeResolved = Effect.fn("BoardAgentBroker.invokeResolved")(function* (
    threadId: ThreadId | undefined,
    command: AgentBoardCommand,
    select: (current: State) => Selected | string,
  ) {
    const deferred = yield* Deferred.make<AgentBoardResult, AgentBoardError>();
    const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    // Leave time for the receipt to cross the socket before the broker's
    // 15-second response timeout.
    const expiresAtMs = (yield* Clock.currentTimeMillis) + REQUEST_EXECUTION_WINDOW_MS;
    const host = yield* SynchronizedRef.modify(
      state,
      (current): readonly [Selected | string, State] => {
        const selected = select(current);
        if (typeof selected === "string") return [selected, current] as const;
        const pending = new Map(current.pending);
        pending.set(requestId, {
          rpcClientId: selected.rpcClientId,
          queue: selected.connection.queue,
          deferred,
        });
        return [selected, { ...current, pending }] as const;
      },
    );
    if (typeof host === "string") {
      return yield* new AgentBoardError({ message: host });
    }
    const offered = yield* Queue.offer(host.connection.queue, {
      type: "request",
      request:
        threadId === undefined
          ? { requestId, expiresAtMs, command }
          : { requestId, expiresAtMs, threadId, command },
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
    const result = yield* Deferred.await(deferred).pipe(
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
    return {
      result,
      client: host.connection.client,
      routing: host.routing,
    } satisfies AgentBoardRoutedResult;
  });

  /**
   * Board lanes live in each browser or desktop window, so a command has to
   * reach the board the user is looking at. That is the window that last sent
   * a message to the thread. When that window is unknown (the thread was
   * started by an agent, a schedule, or mobile, or the server restarted) or has
   * disconnected, a lone connected board is unambiguous and is used instead;
   * with several connected boards the command fails rather than guess, because
   * each window keeps its own lanes and the agent would report the wrong move.
   */
  const selectForThread =
    (threadId: ThreadId) =>
    (current: State): Selected | string => {
      const originClientId = current.origins.get(threadId);
      const originRpcClientId =
        originClientId === undefined
          ? undefined
          : current.rpcClientIdByStableId.get(originClientId);
      const origin =
        originRpcClientId === undefined ? undefined : current.hosts.get(originRpcClientId);
      if (originRpcClientId !== undefined && origin) {
        return { rpcClientId: originRpcClientId, connection: origin, routing: "origin" };
      }
      const lone = current.hosts.size === 1 ? [...current.hosts][0] : undefined;
      if (lone !== undefined) {
        const [rpcClientId, connection] = lone;
        return { rpcClientId, connection, routing: "only-client" };
      }
      if (current.hosts.size === 0) {
        return "No T3 Code web or desktop window is connected to this server, so there is no board to update. Nothing was changed.";
      }
      const why =
        originClientId === undefined
          ? "No T3 Code window with a board has sent a message to this thread"
          : "The T3 Code window that last sent a message to this thread is no longer connected";
      return `${why}, and ${current.hosts.size} windows with boards are open, so the board to use is ambiguous. Nothing was changed. Ask the user to send a message to this thread from the window whose board should change.`;
    };

  const invoke: BoardAgentBrokerShape["invoke"] = Effect.fn("BoardAgentBroker.invoke")(
    (threadId, command) => invokeResolved(threadId, command, selectForThread(threadId)),
  );

  const invokeClient: BoardAgentBrokerShape["invokeClient"] = Effect.fn(
    "BoardAgentBroker.invokeClient",
  )((clientId, threadId, command) =>
    invokeResolved(threadId, command, (current) => {
      const rpcClientId = current.rpcClientIdByStableId.get(clientId);
      const connection = rpcClientId === undefined ? undefined : current.hosts.get(rpcClientId);
      return rpcClientId === undefined || !connection
        ? `Board client ${clientId} is not connected to this server.`
        : { rpcClientId, connection, routing: "origin" };
    }).pipe(Effect.map(({ result }) => result)),
  );

  return {
    connect,
    respond,
    listClients,
    recordOrigin,
    invoke,
    invokeClient,
  } satisfies BoardAgentBrokerShape;
});

export const layer = Layer.effect(BoardAgentBroker, make);
