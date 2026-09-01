import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";

const agentBoardCommand = "t3-board";

// Provider children use this directory for their whole lifetime, so it must
// remain available until the server process exits.
let runtimeBinDir: string | undefined;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const ensureRuntimeBin = Effect.gen(function* () {
  if (runtimeBinDir) return runtimeBinDir;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectory({ prefix: "t3-agent-board-bin-" });
  const executable = yield* HostProcessExecutablePath;
  const entrypoint = (yield* HostProcessArguments)[1];
  if (!entrypoint) return yield* Effect.die("T3 agent CLI entrypoint is unavailable.");
  const posix = path.join(directory, agentBoardCommand);
  yield* fs.writeFileString(
    posix,
    `#!/bin/sh
case "$1:$#" in
  lanes:1|lane:1|move:2) ;;
  *)
    echo "The scoped T3 board launcher supports only: t3-board lanes, t3-board lane, and t3-board move <lane>." >&2
    exit 2
    ;;
esac
exec ${shellQuote(executable)} ${shellQuote(entrypoint)} board "$@"
`,
  );
  yield* fs.chmod(posix, 0o755);
  yield* fs.writeFileString(
    path.join(directory, `${agentBoardCommand}.cmd`),
    [
      "@echo off",
      'if /I "%~1"=="lanes" if "%~2"=="" goto run',
      'if /I "%~1"=="lane" if "%~2"=="" goto run',
      'if /I "%~1"=="move" if not "%~2"=="" if "%~3"=="" goto run',
      "echo The scoped T3 board launcher supports only: t3-board lanes, t3-board lane, and t3-board move ^<lane^>. 1>&2",
      "exit /b 2",
      ":run",
      `@"${executable.replaceAll('"', '""')}" "${entrypoint.replaceAll('"', '""')}" board %*`,
      "",
    ].join("\r\n"),
  );
  runtimeBinDir = directory;
  return directory;
}).pipe(Effect.provide(NodeServices.layer));

/** Environment shared by every local provider process for the opt-in `t3-board` CLI. */
export const agentCommandEnvironment = Effect.fn("provider.agentCommandEnvironment")(function* (
  session: McpProviderSessionConfig | undefined,
  base?: NodeJS.ProcessEnv,
) {
  const environment = base ?? (yield* HostProcessEnvironment);
  if (!session) return environment;
  const separator = (yield* HostProcessPlatform) === "win32" ? ";" : ":";
  const launcherDirectory = yield* ensureRuntimeBin.pipe(
    Effect.map(Option.some),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not create the scoped T3 board launcher.", { cause }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );
  return {
    ...environment,
    ...(Option.isSome(launcherDirectory)
      ? { PATH: `${launcherDirectory.value}${separator}${environment.PATH ?? ""}` }
      : {}),
    T3_AGENT_ENDPOINT: session.agentEndpoint,
    T3_AGENT_BEARER_TOKEN: session.authorizationHeader.replace(/^Bearer\s+/, ""),
  } satisfies NodeJS.ProcessEnv;
});
