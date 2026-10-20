// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { cli } from "../binCli.ts";

const isShowHelp = Schema.is(CliError.ShowHelp);

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { result, output };
  }).pipe(Effect.provide(Layer.mergeAll(layerCliRuntime, TestConsole.layer)));

describe("t3 board", () => {
  it.effect("exposes the manual board command surface", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["board", "--help"]));

      assert.include(output, "client-local board lanes");
      assert.include(output, "board_move");
      assert.include(output, "clients");
      assert.include(output, "lanes");
      assert.include(output, "lane");
      assert.include(output, "move");
      assert.notInclude(output, "skill");
    }),
  );

  it.effect("requires an exact client and thread for manual board moves", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["board", "move", "review", "--client", "client-1"]).pipe(
        Effect.flip,
      );

      assert.isTrue(
        isShowHelp(error) && error.errors.some((cause) => cause.message.includes("--thread")),
      );
    }),
  );

  it.effect("reports when no local server is available for manual board client discovery", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-board-cli-test-"));
      const error = yield* runCli(["board", "clients", "--base-dir", baseDir]).pipe(Effect.flip);

      assert.include(error.message, "No running T3 server was found");
    }),
  );
});
