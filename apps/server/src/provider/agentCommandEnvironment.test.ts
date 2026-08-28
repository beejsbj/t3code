import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { agentCommandEnvironment } from "./agentCommandEnvironment.ts";

it.effect("injects scoped board credentials and an exact t3 launcher", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* agentCommandEnvironment(
      {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        agentEndpoint: "http://127.0.0.1:43123/agent/board",
        authorizationHeader: "Bearer board-token",
        capabilities: new Set(["board"]),
      },
      { PATH: "existing-bin" },
    );
    const separator = (yield* HostProcessPlatform) === "win32" ? ";" : ":";
    const launcherDirectory = environment.PATH!.split(separator)[0]!;

    expect(environment.T3_AGENT_ENDPOINT).toBe("http://127.0.0.1:43123/agent/board");
    expect(environment.T3_AGENT_BEARER_TOKEN).toBe("board-token");
    expect(environment.PATH).toContain(`existing-bin`);
    expect(yield* fs.exists(path.join(launcherDirectory, "t3"))).toBe(true);
    expect(yield* fs.exists(path.join(launcherDirectory, "t3.cmd"))).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("leaves provider environments untouched without a scoped session", () =>
  Effect.gen(function* () {
    const base = { PATH: "existing-bin", CUSTOM: "value" };
    expect(yield* agentCommandEnvironment(undefined, base)).toBe(base);
  }),
);
