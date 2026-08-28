import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createBoardLaneController } from "./boardLaneController.ts";
import {
  DEFAULT_BOARD_LANES,
  DEFAULT_BOARD_ORGANIZATION,
  useBoardLaneStore,
} from "./boardLaneStore.ts";
import { boardLaneForPlacementAction } from "./boardPlacementMenu.ts";
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
    expect(controller.place(firstThread, "Queued")).toEqual({
      type: "placed",
      placement: {
        explicit: true,
        lane: expect.objectContaining({ id: "ready", name: "Queued" }),
      },
    });

    useBoardLaneStore.getState().archiveLane("ready");
    expect(controller.place(firstThread, "Queued")).toEqual({
      type: "error",
      message: "No workflow lane matches “Queued”. Type /lane to choose from current lanes.",
    });
  });

  it("keeps same-ID threads in different environments scoped", () => {
    controller.placeInLane(firstThread, "ready");
    controller.placeInLane(sameIdElsewhere, "review");

    expect(controller.placement(firstThread).lane?.id).toBe("ready");
    expect(controller.placement(sameIdElsewhere).lane?.id).toBe("review");
    expect(controller.unplace(firstThread)).toEqual({
      explicit: false,
      lane: expect.objectContaining({ id: "triage" }),
    });
    expect(controller.placement(sameIdElsewhere).lane?.id).toBe("review");
  });

  it("converges menu, /lane, and agent-style exact-name placement on one transition", () => {
    const menuLane = boardLaneForPlacementAction(
      "place-in-lane:in-progress",
      useBoardLaneStore.getState().lanes,
    );
    expect(menuLane).toBe("in-progress");
    controller.placeInLane(firstThread, menuLane!);
    expect(controller.placement(firstThread).lane?.id).toBe("in-progress");

    const composer = resolveLocalBoardCommand(
      "/lane Review",
      useBoardLaneStore.getState().lanes,
      firstThread,
    );
    expect(composer.type).toBe("command");
    if (composer.type === "command" && composer.command.type === "place") {
      controller.placeInLane(firstThread, composer.command.laneId);
    }
    expect(controller.placement(firstThread).lane?.id).toBe("review");

    controller.place(firstThread, "ready");
    expect(controller.placement(firstThread).lane?.id).toBe("ready");
  });
});
