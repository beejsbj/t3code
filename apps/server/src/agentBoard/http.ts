import { AgentBoardCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as BoardAgentBroker from "./BoardAgentBroker.ts";

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const broker = yield* BoardAgentBroker.BoardAgentBroker;
    return HttpRouter.add(
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
        const command = yield* Schema.decodeUnknownEffect(AgentBoardCommand)(raw).pipe(
          Effect.option,
        );
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
    );
  }),
);
