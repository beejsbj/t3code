// @effect-diagnostics nodeBuiltinImport:off - Launcher integration exercises Node process and filesystem boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { agentCommandEnvironment } from "./agentCommandEnvironment.ts";
import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";

const session: McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:43123/mcp",
  agentEndpoint: "http://127.0.0.1:43123/agent/board",
  authorizationHeader: "Bearer board-token",
  capabilities: new Set(["board"]),
};

it.effect("leaves t3 on PATH and delegates scoped board commands through t3-board", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;

    const fixtureDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-agent-board-launcher-test-"),
    );
    const existingBin = NodePath.join(fixtureDirectory, "existing-bin");
    const entrypoint = NodePath.join(fixtureDirectory, "runtime.mjs");
    NodeFS.mkdirSync(existingBin);
    NodeFS.writeFileSync(NodePath.join(existingBin, "t3"), "#!/bin/sh\nprintf 'global t3\\n'\n");
    NodeFS.chmodSync(NodePath.join(existingBin, "t3"), 0o755);
    NodeFS.writeFileSync(
      entrypoint,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );

    const environment = yield* agentCommandEnvironment(session, { PATH: existingBin }).pipe(
      Effect.provideService(HostProcessExecutablePath, process.execPath),
      Effect.provideService(HostProcessArguments, [process.execPath, entrypoint]),
    );
    const commandEnvironment = { ...process.env, PATH: environment.PATH };
    const t3 = NodeChildProcess.spawnSync("t3", [], {
      encoding: "utf8",
      env: commandEnvironment,
    });
    const board = NodeChildProcess.spawnSync("t3-board", ["move", "review"], {
      encoding: "utf8",
      env: commandEnvironment,
    });
    const unsupported = NodeChildProcess.spawnSync("t3-board", ["clients"], {
      encoding: "utf8",
      env: commandEnvironment,
    });

    expect(t3.status).toBe(0);
    expect(t3.stdout).toBe("global t3\n");
    expect(board.status).toBe(0);
    expect(board.stdout).toBe('["board","move","review"]');
    expect(unsupported.status).toBe(2);
    expect(unsupported.stderr).toContain("supports only");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("injects scoped board credentials and a dedicated t3-board launcher", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* agentCommandEnvironment(session, { PATH: "existing-bin" });
    const separator = (yield* HostProcessPlatform) === "win32" ? ";" : ":";
    const launcherDirectory = environment.PATH!.split(separator)[0]!;

    expect(environment.T3_AGENT_ENDPOINT).toBe("http://127.0.0.1:43123/agent/board");
    expect(environment.T3_AGENT_BEARER_TOKEN).toBe("board-token");
    expect(environment.PATH).toContain(`existing-bin`);
    expect(yield* fs.exists(path.join(launcherDirectory, "t3"))).toBe(false);
    expect(yield* fs.exists(path.join(launcherDirectory, "t3-board"))).toBe(true);
    expect(yield* fs.exists(path.join(launcherDirectory, "t3-board.cmd"))).toBe(true);
    expect(yield* fs.readFileString(path.join(launcherDirectory, "t3-board"))).toContain(
      "lanes:1|lane:1|move:2",
    );
    expect(yield* fs.readFileString(path.join(launcherDirectory, "t3-board.cmd"))).toContain(
      '"move"',
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("leaves provider environments untouched without a scoped session", () =>
  Effect.gen(function* () {
    const base = { PATH: "existing-bin", CUSTOM: "value" };
    expect(yield* agentCommandEnvironment(undefined, base)).toBe(base);
  }),
);
