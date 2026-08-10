// Shared live/offline dispatch plumbing for orchestration-backed CLI surfaces
// (currently `t3 project` and `t3 board`). Both resolve a running server
// session when one is persisted and reachable, and otherwise fall back to an
// offline in-process runtime; the HTTP client, session handling, timeout, and
// that resolution logic are identical between the two, so they live here
// once. Nothing in this module is project- or lane-specific — each CLI
// composes its own domain errors on top of the transport error defined here.
import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export class OrchestrationCliCommandIdGenerationError extends Schema.TaggedErrorClass<OrchestrationCliCommandIdGenerationError>()(
  "OrchestrationCliCommandIdGenerationError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a command identifier.";
  }
}

export class OrchestrationCliLiveServerDeclaredResponseError extends Schema.TaggedErrorClass<OrchestrationCliLiveServerDeclaredResponseError>()(
  "OrchestrationCliLiveServerDeclaredResponseError",
  {
    operation: Schema.Literal("callLiveServer"),
    code: Schema.String,
    traceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed (${this.code}, trace ${this.traceId}).`;
  }
}

export class OrchestrationCliLiveServerUndeclaredStatusError extends Schema.TaggedErrorClass<OrchestrationCliLiveServerUndeclaredStatusError>()(
  "OrchestrationCliLiveServerUndeclaredStatusError",
  {
    operation: Schema.Literal("callLiveServer"),
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed with undeclared status ${this.status}.`;
  }
}

export class OrchestrationCliLiveServerRequestError extends Schema.TaggedErrorClass<OrchestrationCliLiveServerRequestError>()(
  "OrchestrationCliLiveServerRequestError",
  {
    operation: Schema.Literal("callLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to call the running server.";
  }
}

export type OrchestrationCliLiveServerError =
  | OrchestrationCliLiveServerDeclaredResponseError
  | OrchestrationCliLiveServerUndeclaredStatusError
  | OrchestrationCliLiveServerRequestError;

const isOrchestrationCliLiveServerDeclaredResponseError = Schema.is(
  Schema.toEncoded(OrchestrationCliLiveServerDeclaredResponseError),
);
const isOrchestrationCliLiveServerUndeclaredStatusError = Schema.is(
  Schema.toEncoded(OrchestrationCliLiveServerUndeclaredStatusError),
);
const isOrchestrationCliLiveServerRequestError = Schema.is(
  Schema.toEncoded(OrchestrationCliLiveServerRequestError),
);

// The transport-level errors every orchestration CLI command can fail with,
// regardless of the domain (project, lane, ...) it belongs to. Each CLI
// module unions this with its own domain errors as a peer, not a parent.
export const OrchestrationCliCommandError = Schema.Union([
  OrchestrationCliCommandIdGenerationError,
  OrchestrationCliLiveServerDeclaredResponseError,
  OrchestrationCliLiveServerUndeclaredStatusError,
  OrchestrationCliLiveServerRequestError,
]);
export type OrchestrationCliCommandError = typeof OrchestrationCliCommandError.Type;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export function orchestrationCliCommandErrorFromLiveServerRequest(
  cause: unknown,
): OrchestrationCliLiveServerError {
  if (isEnvironmentHttpCommonError(cause)) {
    return new OrchestrationCliLiveServerDeclaredResponseError({
      operation: "callLiveServer",
      code: cause.code,
      traceId: cause.traceId,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new OrchestrationCliLiveServerUndeclaredStatusError({
      operation: "callLiveServer",
      status: cause.response.status,
      cause,
    });
  }

  return new OrchestrationCliLiveServerRequestError({ operation: "callLiveServer", cause });
}

const isConnectionRefusedCause = (cause: unknown): boolean => {
  if (cause === null || typeof cause !== "object") {
    return false;
  }
  if ("code" in cause && cause.code === "ECONNREFUSED") {
    return true;
  }
  if ("cause" in cause) {
    return isConnectionRefusedCause(cause.cause);
  }
  return false;
};

export const isPersistedServerRuntimeUnreachable = (error: unknown): boolean => {
  if (isOrchestrationCliLiveServerDeclaredResponseError(error)) {
    return false;
  }
  if (isOrchestrationCliLiveServerUndeclaredStatusError(error)) {
    return false;
  }
  if (!isOrchestrationCliLiveServerRequestError(error)) {
    return false;
  }
  const cause = error.cause;
  if (HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError") {
    return isConnectionRefusedCause(cause.reason.cause);
  }
  return isConnectionRefusedCause(cause);
};

// `operation` is supplied by the caller so each CLI's tagged error carries a
// truthful label (e.g. "generateLaneCommandId" vs "generateProjectCommandId").
export const makeOrchestrationCliCommandId = (operation: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.mapError(
      (cause) =>
        new OrchestrationCliCommandIdGenerationError({
          operation,
          cause,
        }),
    ),
  );

export const OrchestrationCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const ORCHESTRATION_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(15);

export const withOrchestrationCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  sessionLabel: string,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: sessionLabel,
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withOrchestrationCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(ORCHESTRATION_CLI_LIVE_SERVER_TIMEOUT));

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

export const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    withOrchestrationCliLiveServerTimeout,
    Effect.mapError(orchestrationCliCommandErrorFromLiveServerRequest),
  );

export const dispatchLiveOrchestrationCommand = <Command extends ClientOrchestrationCommand>(
  origin: string,
  bearerToken: string,
  command: Command,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    // `command`'s type is a subset union of `ClientOrchestrationCommand` (e.g.
    // only the lane or only the project variants); TS cannot distribute that
    // union across `dispatch`'s per-variant overload-like parameter type, so
    // this narrows the same way the pre-extraction call sites did.
    yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(
    withOrchestrationCliLiveServerTimeout,
    Effect.mapError(orchestrationCliCommandErrorFromLiveServerRequest),
  );

export const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getSnapshot();
});

export const tryResolveLiveOrchestrationExecutionMode = Effect.fn(
  "tryResolveLiveOrchestrationExecutionMode",
)(function* (
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  config: ServerConfig.ServerConfig["Service"],
  options: {
    readonly sessionLabel: string;
    readonly connectFailureLogMessage: string;
  },
) {
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return Option.none<{ readonly origin: string }>();
  }

  const attempt = withOrchestrationCliSessionToken(environmentAuth, options.sessionLabel, (token) =>
    fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
      Effect.as({
        origin: runtimeState.value.origin,
      }),
    ),
  );

  const attempted = yield* Effect.result(attempt);
  if (attempted._tag === "Success") {
    return Option.some(attempted.success);
  }

  if (!isPersistedServerRuntimeUnreachable(attempted.failure)) {
    return yield* attempted.failure;
  }

  yield* Effect.logDebug(options.connectFailureLogMessage, {
    origin: runtimeState.value.origin,
    cause: attempted.failure,
  });
  yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
  return Option.none<{ readonly origin: string }>();
});
