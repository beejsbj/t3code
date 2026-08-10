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
  it.effect("sets workflow lane on a thread", () =>
    Effect.gen(function* () {
      const event = expectEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.workflow-lane.set",
            commandId: CommandId.make("cmd-user"),
            threadId: ThreadId.make("thread-1"),
            workflowLane: LaneId.make("ready"),
          },
          readModel: readModel(),
        }),
        "thread.workflow-lane-set",
      );
      expect(event.payload.workflowLane).toBe("ready");
      expect(event.payload.threadId).toBe("thread-1");
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
          },
          readModel: model,
        }),
        "lane.updated",
      );
      model = yield* projectEvent(model, { ...updated, sequence: 2 });
      expect(model.lanes[0]?.name).toBe("Up next");

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

  it.effect("rejects archiving a lane with assigned non-deleted threads", () =>
    Effect.gen(function* () {
      const lane = {
        id: LaneId.make("ready"),
        name: "Ready",
        description: "Ready to work",
        order: 1,
      };
      const command = {
        type: "lane.archive" as const,
        commandId: CommandId.make("cmd-lane-archive-assigned"),
        laneId: lane.id,
      };
      const assignedThread = thread(lane.id);
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: {
          ...readModel(assignedThread),
          lanes: [lane],
        },
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("1 assigned thread");

      const archived = expectEvent(
        yield* decideOrchestrationCommand({
          command,
          readModel: {
            ...readModel({ ...assignedThread, deletedAt: NOW }),
            lanes: [lane],
          },
        }),
        "lane.archived",
      );
      expect(archived.payload.laneId).toBe(lane.id);
    }),
  );
});
