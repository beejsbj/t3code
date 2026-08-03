import { LaneId, type LaneDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProjectFilterToggle,
  buildProjectSwimlanes,
  groupEntriesByLane,
  isProjectFilterChecked,
  laneArchiveIntent,
  laneColumnKeyFromSwimlaneDroppable,
  laneIdForName,
  listProjectsWithSessions,
  nextLaneOrder,
  reorderLaneUpdates,
  swimlaneLaneDroppableId,
} from "./SessionBoard.logic.ts";

type TestPlacement = {
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly laneColumnKey: string;
  readonly updatedAt: string;
};

const laneKeys = ["lane-a", "lane-b", "lane-c"] as const;

function placement(
  projectKey: string,
  projectTitle: string,
  laneColumnKey: string,
  updatedAt: string,
): TestPlacement {
  return { projectKey, projectTitle, laneColumnKey, updatedAt };
}

const lanes: ReadonlyArray<LaneDefinition> = [
  {
    id: LaneId.make("shaping"),
    name: "Shaping",
    description: "Work out the shape",
    order: 0,
  },
  {
    id: LaneId.make("ready"),
    name: "Ready",
    description: "Ready to start",
    order: 10,
  },
  {
    id: LaneId.make("done"),
    name: "Done",
    description: "Finished work",
    order: 20,
  },
];

describe("laneIdForName", () => {
  it("creates a readable unique lane id without exposing id as an authoring field", () => {
    expect(laneIdForName("To Review", lanes)).toBe("to-review");
    expect(laneIdForName("Ready", lanes)).toBe("ready-2");
  });
});

describe("nextLaneOrder", () => {
  it("places a new lane after the highest existing order", () => {
    expect(nextLaneOrder(lanes)).toBe(21);
  });
});

describe("reorderLaneUpdates", () => {
  it("swaps neighbouring lanes", () => {
    expect(reorderLaneUpdates(lanes, LaneId.make("ready"), "up")).toEqual([
      { laneId: LaneId.make("ready"), order: 0 },
      { laneId: LaneId.make("shaping"), order: 10 },
    ]);
    expect(reorderLaneUpdates(lanes, LaneId.make("done"), "down")).toEqual([]);
  });
});

describe("buildProjectSwimlanes", () => {
  it("groups threads under the right project", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-b", "2026-01-02T00:00:00.000Z"),
      placement("env:alpha", "Alpha", "lane-c", "2026-01-01T00:00:00.000Z"),
    ];

    const swimlanes = buildProjectSwimlanes(entries, new Set());

    expect(swimlanes).toHaveLength(2);
    expect(swimlanes[0]?.projectKey).toBe("env:alpha");
    expect(swimlanes[0]?.sessionCount).toBe(2);
    expect(swimlanes[1]?.projectKey).toBe("env:beta");
    expect(swimlanes[1]?.sessionCount).toBe(1);
  });

  it("omits projects with no visible sessions after filtering", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-b", "2026-01-02T00:00:00.000Z"),
    ];

    const swimlanes = buildProjectSwimlanes(entries, new Set(["env:alpha"]));

    expect(swimlanes).toHaveLength(1);
    expect(swimlanes[0]?.projectKey).toBe("env:alpha");
  });

  it("uses an empty selection to mean all projects", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-b", "2026-01-02T00:00:00.000Z"),
    ];

    expect(buildProjectSwimlanes(entries, new Set())).toHaveLength(2);
    expect(isProjectFilterChecked(new Set(), "env:alpha")).toBe(true);
    expect(isProjectFilterChecked(new Set(), "env:beta")).toBe(true);
  });
});

describe("groupEntriesByLane", () => {
  it("keeps lane column order identical for every swimlane", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-c", "2026-01-01T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-a", "2026-01-02T00:00:00.000Z"),
    ];

    for (const swimlane of buildProjectSwimlanes(entries, new Set())) {
      expect([...groupEntriesByLane(swimlane.entries, laneKeys).keys()]).toEqual([...laneKeys]);
    }
  });
});

describe("applyProjectFilterToggle", () => {
  it("narrows the board to the selected projects", () => {
    const all = new Set(["env:alpha", "env:beta"]);
    const narrowed = applyProjectFilterToggle(new Set(), "env:alpha", false, all);

    expect([...narrowed]).toEqual(["env:beta"]);
    expect(isProjectFilterChecked(narrowed, "env:alpha")).toBe(false);
    expect(isProjectFilterChecked(narrowed, "env:beta")).toBe(true);
  });
});

describe("listProjectsWithSessions", () => {
  it("lists only projects that currently have sessions", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:alpha", "Alpha", "lane-b", "2026-01-02T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-c", "2026-01-01T00:00:00.000Z"),
    ];

    expect(listProjectsWithSessions(entries)).toEqual([
      { projectKey: "env:alpha", projectTitle: "Alpha" },
      { projectKey: "env:beta", projectTitle: "Beta" },
    ]);
  });
});

describe("swimlaneLaneDroppableId", () => {
  it("round-trips lane column keys for drag and drop targets", () => {
    const droppableId = swimlaneLaneDroppableId("env:alpha", laneKeys[1]);
    expect(laneColumnKeyFromSwimlaneDroppable(droppableId)).toBe(laneKeys[1]);
  });
});

describe("laneArchiveIntent", () => {
  it("requires member-aware confirmation before archiving a populated lane", () => {
    expect(laneArchiveIntent(LaneId.make("ready"), 3)).toEqual({
      kind: "confirm",
      memberCount: 3,
      explanation:
        "Archive this lane? Its 3 sessions will become unplaced and keep a lane removed note.",
    });
  });

  it("allows an empty lane to be archived immediately", () => {
    expect(laneArchiveIntent(LaneId.make("done"), 0)).toEqual({ kind: "archive" });
  });
});
