// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { boardSkillFiles } from "./boardSkill.ts";

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

/** Runs `effect` with the agent board variables set (or cleared), restoring them afterwards. */
const withAgentEnvironment = <A, E, R>(
  environment: { readonly endpoint?: string; readonly token?: string },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const previousEndpoint = process.env.T3_AGENT_ENDPOINT;
    const previousToken = process.env.T3_AGENT_BEARER_TOKEN;
    const assign = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    assign("T3_AGENT_ENDPOINT", environment.endpoint);
    assign("T3_AGENT_BEARER_TOKEN", environment.token);
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          assign("T3_AGENT_ENDPOINT", previousEndpoint);
          assign("T3_AGENT_BEARER_TOKEN", previousToken);
        }),
      ),
    );
  });

describe("t3 board", () => {
  it.effect("exposes the opt-in board command surface", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["board", "--help"]));

      assert.include(output, "client-local board lanes");
      assert.include(output, "clients");
      assert.include(output, "lanes");
      assert.include(output, "lane");
      assert.include(output, "move");
      assert.include(output, "skill");
      assert.notInclude(output, "unplace");
    }),
  );

  it.effect("rejects board commands outside a scoped agent turn", () =>
    Effect.gen(function* () {
      const error = yield* withAgentEnvironment({}, runCli(["board", "lanes"])).pipe(Effect.flip);

      assert.include(error.message, "No agent turn is active");
    }),
  );

  it.effect("requires an exact client and thread together for manual board moves", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["board", "move", "review", "--client", "client-1"]).pipe(
        Effect.flip,
      );

      assert.include(error.message, "require both `--client` and `--thread`");
    }),
  );

  it.effect("reports when no local server is available for manual board client discovery", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-board-cli-test-"));
      const error = yield* withAgentEnvironment(
        {},
        runCli(["board", "clients", "--base-dir", baseDir]),
      ).pipe(Effect.flip);

      assert.include(error.message, "No running T3 server was found");
    }),
  );

  it.effect("prevents an agent-scoped process from entering manual board mode", () =>
    Effect.gen(function* () {
      const error = yield* withAgentEnvironment(
        { endpoint: "http://127.0.0.1/agent/board", token: "scoped-token" },
        runCli(["board", "move", "review", "--client", "client-2", "--thread", "other-thread"]),
      ).pipe(Effect.flip);

      assert.include(error.message, "unavailable inside a T3 agent turn");
    }),
  );

  it.effect("installs the opt-in board skill into an explicit project directory", () =>
    Effect.gen(function* () {
      const projectDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-board-skill-test-"),
      );
      const checkedInSkillDirectory = NodePath.join(
        import.meta.dirname,
        "../../../../.agents/skills/t3-board",
      );
      assert.equal(
        boardSkillFiles["SKILL.md"],
        NodeFS.readFileSync(NodePath.join(checkedInSkillDirectory, "SKILL.md"), "utf8"),
      );
      assert.equal(
        boardSkillFiles["agents/openai.yaml"],
        NodeFS.readFileSync(NodePath.join(checkedInSkillDirectory, "agents/openai.yaml"), "utf8"),
      );
      yield* runCli(["board", "skill", "install", "--directory", projectDirectory]);

      const skillDirectory = NodePath.join(projectDirectory, ".agents", "skills", "t3-board");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(skillDirectory, "SKILL.md"), "utf8"),
        boardSkillFiles["SKILL.md"],
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(skillDirectory, "agents", "openai.yaml"), "utf8"),
        boardSkillFiles["agents/openai.yaml"],
      );

      yield* runCli(["board", "skill", "install", "--directory", projectDirectory]);
    }),
  );

  it.effect("does not partially overwrite a conflicting board skill", () =>
    Effect.gen(function* () {
      const projectDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-board-skill-conflict-test-"),
      );
      const metadataPath = NodePath.join(
        projectDirectory,
        ".agents",
        "skills",
        "t3-board",
        "agents",
        "openai.yaml",
      );
      NodeFS.mkdirSync(NodePath.dirname(metadataPath), { recursive: true });
      NodeFS.writeFileSync(metadataPath, "user-owned metadata\n");

      const error = yield* runCli([
        "board",
        "skill",
        "install",
        "--directory",
        projectDirectory,
      ]).pipe(Effect.flip);

      assert.include(error.message, "Refusing to overwrite");
      assert.equal(
        NodeFS.existsSync(
          NodePath.join(projectDirectory, ".agents", "skills", "t3-board", "SKILL.md"),
        ),
        false,
      );
    }),
  );
});
