import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { BoardLane } from "./boardLaneStore.ts";
import {
  localLaneChoiceQuery,
  resolveLocalBoardCommand,
  workflowBoardLanes,
} from "./localBoardCommands.ts";

const threadRef = scopeThreadRef("env-a" as EnvironmentId, ThreadId.make("thread-1"));
const lanes: ReadonlyArray<BoardLane> = [
  { id: "triage", name: "Triage", description: "", order: 0 },
  { id: "in-progress", name: "In Progress", description: "", order: 2 },
  { id: "review", name: "Review", description: "", order: 3 },
  { id: "second-review", name: "Review", description: "", order: 4 },
  { id: "snoozed", name: "Snoozed", description: "", order: 5 },
  { id: "settled", name: "Settled", description: "", order: 6 },
];

describe("resolveLocalBoardCommand", () => {
  it("recognizes only standalone local namespaces", () => {
    expect(resolveLocalBoardCommand(" /BOARD ", lanes, threadRef)).toEqual({
      type: "command",
      command: { type: "open-board" },
    });
    expect(resolveLocalBoardCommand("/board show review", lanes, threadRef)).toEqual({
      type: "not-local",
    });
    expect(resolveLocalBoardCommand("Please /lane review", lanes, threadRef)).toEqual({
      type: "not-local",
    });
  });

  it("resolves lane IDs before names and supports names with spaces", () => {
    expect(resolveLocalBoardCommand("/lane in-progress", lanes, threadRef)).toEqual({
      type: "command",
      command: { type: "place", laneId: "in-progress" },
    });
    expect(resolveLocalBoardCommand("/lane In Progress", lanes, threadRef)).toEqual({
      type: "command",
      command: { type: "place", laneId: "in-progress" },
    });
  });

  it("reports ambiguous and missing names with a deterministic recovery", () => {
    expect(resolveLocalBoardCommand("/lane review", lanes, threadRef)).toEqual({
      type: "command",
      command: { type: "place", laneId: "review" },
    });

    const duplicateNames = lanes.map((lane) =>
      lane.id === "review" ? { ...lane, id: "first-review" } : lane,
    );
    expect(resolveLocalBoardCommand("/lane review", duplicateNames, threadRef)).toEqual({
      type: "error",
      message: "More than one lane is named “review”. Use a lane ID: first-review, second-review.",
    });
    expect(resolveLocalBoardCommand("/lane missing", lanes, threadRef)).toEqual({
      type: "error",
      message: "No workflow lane matches “missing”. Type /lane to choose from current lanes.",
    });
  });

  it("supports unplacing and rejects draft-thread placement", () => {
    expect(resolveLocalBoardCommand("/lane unplace", lanes, threadRef)).toEqual({
      type: "command",
      command: { type: "unplace" },
    });
    expect(resolveLocalBoardCommand("/lane ready", lanes, null)).toEqual({
      type: "error",
      message: "Open an existing thread before placing it in a board lane.",
    });
  });

  it("derives current choices and excludes lifecycle lanes", () => {
    expect(workflowBoardLanes(lanes).map((lane) => lane.id)).toEqual([
      "triage",
      "in-progress",
      "review",
      "second-review",
    ]);
    expect(localLaneChoiceQuery("lane ")).toBe("");
    expect(localLaneChoiceQuery("lane in p")).toBe("in p");
    expect(localLaneChoiceQuery("lan")).toBeNull();
  });
});
