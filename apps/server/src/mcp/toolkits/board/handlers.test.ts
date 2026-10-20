import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  AgentBoardError,
  type AgentBoardCommand,
  type AgentBoardLane,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as BoardAgentBroker from "../../../agentBoard/BoardAgentBroker.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("board-caller-thread");
const review: AgentBoardLane = { id: "review", name: "Review", description: "", order: 4 };
const desktop = { clientId: "desktop-1", label: "Desktop", kind: "desktop-renderer" as const };

const threadScope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration", "board"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("board-environment"),
  requestNamespace: "board-session",
  thread: {
    threadId,
    providerSessionId: "board-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(capabilities),
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "board-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "board-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// Effect returns a declared tool failure as `isError` with its encoded payload as JSON text.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const call = (
  name: string,
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  });

type Invocation = { readonly threadId: ThreadId; readonly command: AgentBoardCommand };

/** Runs the production board registration against a broker that records what it was asked. */
const withBoard = <A, E>(
  test: (invoked: ReadonlyArray<Invocation>) => Effect.Effect<A, E, McpServer.McpServer>,
  options: {
    readonly invoke?: BoardAgentBroker.BoardAgentBrokerShape["invoke"];
    readonly threads?: Layer.Layer<ThreadManagement.ThreadManagementService>;
  } = {},
) => {
  const invoked: Array<Invocation> = [];
  const invoke =
    options.invoke ??
    ((_, command) =>
      Effect.succeed({
        result:
          command.type === "lanes"
            ? { type: "lanes" as const, lanes: [review] }
            : { type: command.type, state: { overridden: true, lane: review } },
        client: desktop,
        routing: "origin" as const,
      }));
  return test(invoked).pipe(
    Effect.provide(
      McpHttpServer.layerBoardToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(options.threads ?? McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(BoardAgentBroker.BoardAgentBroker)({
            invoke: (target, command) =>
              Effect.sync(() => invoked.push({ threadId: target, command })).pipe(
                Effect.andThen(invoke(target, command)),
              ),
          }),
        ),
      ),
    ),
  );
};

it.effect("moves only the calling thread's card, whatever thread the input names", () =>
  withBoard((invoked) =>
    Effect.gen(function* () {
      const result = yield* call(
        "board_move",
        { lane: "review", threadId: "someone-elses-thread" },
        threadScope(),
      );

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        current: { overridden: true, lane: review },
        board: { label: "Desktop", kind: "desktop-renderer", routing: "origin" },
      });
      expect(invoked).toEqual([{ threadId, command: { type: "move", lane: "review" } }]);
    }),
  ),
);

it.effect("lists lanes and the calling thread's current lane", () =>
  withBoard((invoked) =>
    Effect.gen(function* () {
      const result = yield* call("board_lanes", {}, threadScope());

      expect(result.structuredContent).toEqual({
        lanes: [review],
        current: { overridden: true, lane: review },
        board: { label: "Desktop", kind: "desktop-renderer", routing: "origin" },
      });
      expect(invoked.map((entry) => entry.threadId)).toEqual([threadId, threadId]);
    }),
  ),
);

it.effect("refuses a credential without the board capability before reaching a board", () =>
  withBoard((invoked) =>
    Effect.gen(function* () {
      const lanes = yield* call("board_lanes", {}, threadScope(["orchestration"]));
      const moved = yield* call("board_move", { lane: "review" }, threadScope(["orchestration"]));

      expect(declaredFailure(lanes)).toMatchObject({ code: "capability_denied" });
      expect(declaredFailure(moved)).toMatchObject({ code: "capability_denied" });
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("refuses an MCP client that is not running inside a thread", () =>
  withBoard((invoked) =>
    Effect.gen(function* () {
      const outside: McpInvocationContext.McpInvocationScope = {
        ...threadScope(),
        thread: undefined,
        client: { sessionId: "client-1", label: "Outside agent", access: "full-access" },
      };
      const moved = yield* call("board_move", { lane: "review" }, outside);

      expect(declaredFailure(moved)).toMatchObject({ code: "thread_credential_required" });
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("refuses a move from a thread that no longer owns a live run", () =>
  withBoard(
    (invoked) =>
      Effect.gen(function* () {
        const moved = yield* call("board_move", { lane: "review" }, threadScope());

        expect(declaredFailure(moved)).toMatchObject({ code: "parent_not_active" });
        expect(invoked).toEqual([]);
      }),
    {
      threads: Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { activeRunId: null })),
      }),
    },
  ),
);

it.effect("returns the board's refusal as a tool failure", () =>
  withBoard(
    () =>
      Effect.gen(function* () {
        const moved = yield* call("board_move", { lane: "nowhere" }, threadScope());

        expect(declaredFailure(moved)).toEqual({
          _tag: "AgentBoardError",
          message: "No lane matches nowhere.",
        });
      }),
    { invoke: () => Effect.fail(new AgentBoardError({ message: "No lane matches nowhere." })) },
  ),
);
