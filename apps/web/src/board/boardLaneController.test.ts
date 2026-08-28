import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createBoardLaneController } from "./boardLaneController.ts";
import {
  DEFAULT_BOARD_LANES,
  DEFAULT_BOARD_ORGANIZATION,
  useBoardLaneStore,
} from "./boardLaneStore.ts";
import { boardLaneForMoveAction } from "./boardPlacementMenu.ts";
import { resolveLocalBoardCommand } from "./localBoardCommands.ts";

const firstThread = scopeThreadRef("env-a" as EnvironmentId, ThreadId.make("thread-1"));
const sameIdElsewhere = scopeThreadRef("env-b" as EnvironmentId, ThreadId.make("thread-1"));
const controller = createBoardLaneController(useBoardLaneStore);

beforeEach(() => {
  useBoardLaneStore.setState({
    lanes: DEFAULT_BOARD_LANES,
    placementByThreadKey: {},
    laneEntryByThreadKey: {},
    orderByLaneId: {},
    byLaneColumnKey: {},
    collapsedLifecycleLaneIds: [],
    organization: DEFAULT_BOARD_ORGANIZATION,
  });
});

describe("boardLaneController", () => {
  it("lists and resolves the live lane registry", () => {
    expect(controller.list().map((lane) => lane.id)).toEqual([
      "triage",
      "blocked",
      "ready",
      "in-progress",
      "review",
    ]);

    useBoardLaneStore.getState().updateLane("ready", {
      name: "Queued",
      description: "Ready to start",
      order: 2,
    });
    expect(controller.move(firstThread, "Queued")).toEqual({
      type: "moved",
      state: {
        overridden: true,
        lane: expect.objectContaining({ id: "ready", name: "Queued" }),
      },
    });

    useBoardLaneStore.getState().archiveLane("ready");
    expect(controller.move(firstThread, "Queued")).toEqual({
      type: "error",
      message: "No workflow lane matches “Queued”. Type /lane to choose from current lanes.",
    });
  });

  it("keeps same-ID threads in different environments scoped", () => {
    controller.moveToLane(firstThread, "ready");
    controller.moveToLane(sameIdElsewhere, "review");

    expect(controller.current(firstThread).lane?.id).toBe("ready");
    expect(controller.current(sameIdElsewhere).lane?.id).toBe("review");
    expect(controller.move(firstThread, "triage")).toEqual({
      type: "moved",
      state: {
        overridden: false,
        lane: expect.objectContaining({ id: "triage" }),
      },
    });
    expect(controller.current(firstThread)).toEqual({
      overridden: false,
      lane: expect.objectContaining({ id: "triage" }),
    });
    expect(controller.current(sameIdElsewhere).lane?.id).toBe("review");
  });

  it("converges menu, /lane, and agent-style exact-name moves on one transition", () => {
    const menuLane = boardLaneForMoveAction(
      "move-to-lane:in-progress",
      useBoardLaneStore.getState().lanes,
    );
    expect(menuLane).toBe("in-progress");
    controller.moveToLane(firstThread, menuLane!);
    expect(controller.current(firstThread).lane?.id).toBe("in-progress");

    const composer = resolveLocalBoardCommand(
      "/lane Review",
      useBoardLaneStore.getState().lanes,
      firstThread,
    );
    expect(composer.type).toBe("command");
    if (composer.type === "command" && composer.command.type === "move") {
      controller.moveToLane(firstThread, composer.command.laneId);
    }
    expect(controller.current(firstThread).lane?.id).toBe("review");

    controller.move(firstThread, "ready");
    expect(controller.current(firstThread).lane?.id).toBe("ready");
  });
});
