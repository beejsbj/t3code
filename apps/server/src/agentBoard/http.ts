import {
  AgentBoardCommand,
  AgentBoardManualCommandRequest,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as BoardAgentBroker from "./BoardAgentBroker.ts";

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );

const decodeAgentBoardCommand = Schema.decodeUnknownEffect(AgentBoardCommand);
const decodeManualBoardCommand = Schema.decodeUnknownEffect(AgentBoardManualCommandRequest);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const broker = yield* BoardAgentBroker.BoardAgentBroker;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;

    const authenticateManual = Effect.fn("agentBoard.authenticateManual")(function* (
      request: HttpServerRequest.HttpServerRequest,
      scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
    ) {
      const session = yield* environmentAuth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None") return undefined;
      return session.value.scopes.includes(scope) ? session.value : null;
    });

    return Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/agent/board",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorization = request.headers.authorization;
          const token = authorization?.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length).trim()
            : "";
          const scope = yield* registry.resolve(token);
          if (!scope || !scope.capabilities.has("board")) {
            return jsonError(401, "A valid provider-scoped board credential is required.");
          }
          const raw = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
          const command = yield* decodeAgentBoardCommand(raw).pipe(Effect.option);
          if (command._tag === "None") return jsonError(400, "Invalid board command.");
          return yield* broker.invoke(scope.threadId, command.value).pipe(
            Effect.map((result) =>
              HttpServerResponse.jsonUnsafe(result, {
                headers: { "cache-control": "no-store" },
              }),
            ),
            Effect.catch((error) => Effect.succeed(jsonError(409, error.message))),
          );
        }),
      ),
      HttpRouter.add(
        "GET",
        "/api/board/clients",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* authenticateManual(request, AuthOrchestrationReadScope);
          if (session === undefined) return jsonError(401, "A valid T3 session is required.");
          if (session === null) return jsonError(403, "The orchestration:read scope is required.");
          return HttpServerResponse.jsonUnsafe(
            { clients: yield* broker.listClients() },
            { headers: { "cache-control": "no-store" } },
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        "/api/board",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* authenticateManual(request, AuthOrchestrationOperateScope);
          if (session === undefined) return jsonError(401, "A valid T3 session is required.");
          if (session === null)
            return jsonError(403, "The orchestration:operate scope is required.");
          const raw = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
          const input = yield* decodeManualBoardCommand(raw).pipe(Effect.option);
          if (input._tag === "None") return jsonError(400, "Invalid manual board command.");
          if (input.value.command.type !== "lanes" && input.value.threadId === undefined) {
            return jsonError(400, "A thread ID is required for lane and move commands.");
          }
          return yield* broker
            .invokeClient(input.value.clientId, input.value.threadId, input.value.command)
            .pipe(
              Effect.map((result) =>
                HttpServerResponse.jsonUnsafe(result, {
                  headers: { "cache-control": "no-store" },
                }),
              ),
              Effect.catch((error) => Effect.succeed(jsonError(409, error.message))),
            );
        }),
      ),
    );
  }),
);
