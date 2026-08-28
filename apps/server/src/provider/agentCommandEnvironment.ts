import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";

let runtimeBinDir: string | undefined;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const ensureRuntimeBin = Effect.gen(function* () {
  if (runtimeBinDir) return runtimeBinDir;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectory({ prefix: "t3-agent-bin-" });
  const executable = yield* HostProcessExecutablePath;
  const entrypoint = (yield* HostProcessArguments)[1];
  if (!entrypoint) return yield* Effect.die("T3 agent CLI entrypoint is unavailable.");
  const posix = path.join(directory, "t3");
  yield* fs.writeFileString(
    posix,
    `#!/bin/sh\nexec ${shellQuote(executable)} ${shellQuote(entrypoint)} "$@"\n`,
  );
  yield* fs.chmod(posix, 0o755);
  yield* fs.writeFileString(
    path.join(directory, "t3.cmd"),
    `@"${executable.replaceAll('"', '""')}" "${entrypoint.replaceAll('"', '""')}" %*\r\n`,
  );
  runtimeBinDir = directory;
  return directory;
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

/** Environment shared by every local provider process for the opt-in `t3 board` CLI. */
export const agentCommandEnvironment = Effect.fn("provider.agentCommandEnvironment")(function* (
  session: McpProviderSessionConfig | undefined,
  base?: NodeJS.ProcessEnv,
) {
  const environment = base ?? (yield* HostProcessEnvironment);
  if (!session) return environment;
  const separator = (yield* HostProcessPlatform) === "win32" ? ";" : ":";
  return {
    ...environment,
    PATH: `${yield* ensureRuntimeBin}${separator}${environment.PATH ?? ""}`,
    T3_AGENT_ENDPOINT: session.agentEndpoint,
    T3_AGENT_BEARER_TOKEN: session.authorizationHeader.replace(/^Bearer\s+/, ""),
  } satisfies NodeJS.ProcessEnv;
});
