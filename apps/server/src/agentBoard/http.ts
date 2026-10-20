import {
  AgentBoardManualCommandRequest,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as BoardAgentBroker from "./BoardAgentBroker.ts";

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );

const decodeManualBoardCommand = Schema.decodeUnknownEffect(AgentBoardManualCommandRequest);

/**
 * Routes for the human `t3 board` CLI, which names its target client and
 * thread explicitly. Agents use the `board_lanes` and `board_move` MCP tools.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* BoardAgentBroker.BoardAgentBroker;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;

    const authenticateManual = (request: HttpServerRequest.HttpServerRequest) =>
      environmentAuth.authenticateHttpRequest(request).pipe(Effect.option);

    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/api/board/clients",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* authenticateManual(request);
          if (session._tag === "None") return jsonError(401, "A valid T3 session is required.");
          if (!session.value.scopes.includes(AuthOrchestrationReadScope)) {
            return jsonError(403, "The orchestration:read scope is required.");
          }
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
          const session = yield* authenticateManual(request);
          if (session._tag === "None") return jsonError(401, "A valid T3 session is required.");
          const raw = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
          const input = yield* decodeManualBoardCommand(raw).pipe(Effect.option);
          if (input._tag === "None") return jsonError(400, "Invalid manual board command.");
          if (input.value.command.type !== "lanes" && input.value.threadId === undefined) {
            return jsonError(400, "A thread ID is required for lane and move commands.");
          }
          const requiredScope =
            input.value.command.type === "move"
              ? AuthOrchestrationOperateScope
              : AuthOrchestrationReadScope;
          if (!session.value.scopes.includes(requiredScope)) {
            return jsonError(403, `The ${requiredScope} scope is required.`);
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
