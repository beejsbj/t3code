import {
  CommandId,
  LaneId,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-07-28T12:00:00.000Z";

type Decided = Effect.Success<ReturnType<typeof decideOrchestrationCommand>>;
type EventType = OrchestrationEvent["type"];
type PlannedEventOf<T extends EventType> = Omit<
  Extract<OrchestrationEvent, { type: T }>,
  "sequence"
>;

function expectEvent<T extends EventType>(result: Decided, type: T): PlannedEventOf<T> {
  if (Array.isArray(result)) throw new Error("Expected one orchestration event");
  const event = result as Exclude<Decided, ReadonlyArray<unknown>>;
  if (event.type !== type) throw new Error(`Expected ${type}, received ${event.type}`);
  return event as unknown as PlannedEventOf<T>;
}

function thread(workflowLane: OrchestrationThread["workflowLane"] = null): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    workflowLane,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function readModel(currentThread = thread()): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    lanes: [],
    threads: [currentThread],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("workflow lane decider", (it) => {
  it.effect("rejects an agent placement over a user placement", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.workflow-lane.set",
          commandId: CommandId.make("cmd-agent-over-user"),
          threadId: ThreadId.make("thread-1"),
          workflowLane: LaneId.make("ready"),
          placedBy: "agent",
        },
        readModel: readModel({
          ...thread(LaneId.make("shaping")),
          workflowLanePlacedBy: "user",
          workflowLanePlacedAt: NOW,
        }),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag !== "OrchestrationCommandInvariantError") {
        return yield* Effect.die("Expected an orchestration invariant error");
      }
      expect(error.detail).toContain("user placement");
    }),
  );

  it.effect("accepts agent placements over null and prior agent placements", () =>
    Effect.gen(function* () {
      for (const current of [
        thread(),
        {
          ...thread(LaneId.make("shaping")),
          workflowLanePlacedBy: "agent" as const,
          workflowLanePlacedAt: NOW,
        },
      ]) {
        const event = expectEvent(
          yield* decideOrchestrationCommand({
            command: {
              type: "thread.workflow-lane.set",
              commandId: CommandId.make(`cmd-agent-${current.workflowLane ?? "null"}`),
              threadId: ThreadId.make("thread-1"),
              workflowLane: LaneId.make("ready"),
              placedBy: "agent",
            },
            readModel: readModel(current),
          }),
          "thread.workflow-lane-set",
        );
        expect(event.payload.placedBy).toBe("agent");
      }
    }),
  );

  it.effect("always accepts user placement and stamps user", () =>
    Effect.gen(function* () {
      const event = expectEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.workflow-lane.set",
            commandId: CommandId.make("cmd-user"),
            threadId: ThreadId.make("thread-1"),
            workflowLane: LaneId.make("done"),
          },
          readModel: readModel({
            ...thread(LaneId.make("ready")),
            workflowLanePlacedBy: "agent",
            workflowLanePlacedAt: NOW,
          }),
        }),
        "thread.workflow-lane-set",
      );
      expect(event.payload.placedBy).toBe("user");
    }),
  );

  it.effect("creates, updates, and archives a lane through the read model", () =>
    Effect.gen(function* () {
      let model = readModel();
      const created = expectEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "lane.create",
            commandId: CommandId.make("cmd-lane-create"),
            lane: {
              id: LaneId.make("on-deck"),
              name: "On deck",
              description: "Queued for the next work session",
              order: 3,
              interrupt: "move",
            },
          },
          readModel: model,
        }),
        "lane.created",
      );
      model = yield* projectEvent(model, { ...created, sequence: 1 });
      expect(model.lanes).toHaveLength(1);

      const updated = expectEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "lane.update",
            commandId: CommandId.make("cmd-lane-update"),
            laneId: LaneId.make("on-deck"),
            name: "Up next",
            interrupt: "badge",
          },
          readModel: model,
        }),
        "lane.updated",
      );
      model = yield* projectEvent(model, { ...updated, sequence: 2 });
      expect(model.lanes[0]?.name).toBe("Up next");
      expect(model.lanes[0]?.interrupt).toBe("badge");

      const archived = expectEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "lane.archive",
            commandId: CommandId.make("cmd-lane-archive"),
            laneId: LaneId.make("on-deck"),
          },
          readModel: model,
        }),
        "lane.archived",
      );
      model = yield* projectEvent(model, { ...archived, sequence: 3 });
      expect(model.lanes).toEqual([]);
    }),
  );
});
