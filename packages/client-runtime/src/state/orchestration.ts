import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  archiveLane,
  createLane,
  type ArchiveLaneInput,
  type CreateLaneInput,
  type UpdateLaneInput,
  updateLane,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type { ArchiveLaneInput, CreateLaneInput, UpdateLaneInput } from "../operations/commands.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const laneScheduler = createAtomCommandScheduler();
  const laneConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    createLane: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:lane:create",
      execute: (input: CreateLaneInput) => createLane(input),
      scheduler: laneScheduler,
      concurrency: laneConcurrency,
    }),
    updateLane: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:lane:update",
      execute: (input: UpdateLaneInput) => updateLane(input),
      scheduler: laneScheduler,
      concurrency: laneConcurrency,
    }),
    archiveLane: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:lane:archive",
      execute: (input: ArchiveLaneInput) => archiveLane(input),
      scheduler: laneScheduler,
      concurrency: laneConcurrency,
    }),
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
  };
}
