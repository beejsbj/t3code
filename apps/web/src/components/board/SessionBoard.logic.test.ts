import { LaneId, type LaneDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProjectFilterToggle,
  boardLaneGridTemplateColumns,
  buildProjectSwimlanes,
  groupEntriesByLane,
  isProjectFilterChecked,
  laneArchiveIntent,
  laneColumnKeyFromSwimlaneDroppableId,
  laneIdForName,
  listProjectsWithSessions,
  nextLaneOrder,
  reorderLaneUpdates,
  resolveBoardFocusAction,
  swimlaneColumnDroppableId,
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

describe("boardLaneGridTemplateColumns", () => {
  it("uses narrow rails for collapsed lifecycle lanes without changing workflow lanes", () => {
    const columns = [
      { key: "triage", laneId: LaneId.make("triage") },
      { key: "snoozed", laneId: LaneId.make("snoozed") },
      { key: "settled", laneId: LaneId.make("settled") },
    ];

    expect(boardLaneGridTemplateColumns(columns, new Set())).toBe("380px 112px 112px");
    expect(boardLaneGridTemplateColumns(columns, new Set(["snoozed"]))).toBe("380px 380px 112px");
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

describe("swimlaneColumnDroppableId", () => {
  it("round-trips lane column keys for drag and drop targets", () => {
    const droppableId = swimlaneColumnDroppableId("env:alpha", laneKeys[1]);
    expect(laneColumnKeyFromSwimlaneDroppableId(droppableId)).toBe(laneKeys[1]);
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

describe("resolveBoardFocusAction", () => {
  const viewport = { top: 0, bottom: 800, left: 0, right: 1200 };

  it("reveals a card that is not rendered at all", () => {
    expect(resolveBoardFocusAction({ card: null, viewport, forceOpen: false })).toBe("reveal");
  });

  it("reveals a card scrolled off the bottom", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 900, bottom: 1160, left: 0, right: 380 },
        viewport,
        forceOpen: false,
      }),
    ).toBe("reveal");
  });

  it("reveals a card in a column scrolled off to the right", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 100, bottom: 360, left: 1180, right: 1560 },
        viewport,
        forceOpen: false,
      }),
    ).toBe("reveal");
  });

  it("opens a card that is already on screen", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 100, bottom: 360, left: 20, right: 400 },
        viewport,
        forceOpen: false,
      }),
    ).toBe("open");
  });

  it("opens a card taller than the board once it fills the viewport", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: -100, bottom: 900, left: 20, right: 400 },
        viewport,
        forceOpen: false,
      }),
    ).toBe("open");
  });

  it("opens straight away when the request says so, wherever the card is", () => {
    expect(resolveBoardFocusAction({ card: null, viewport, forceOpen: true })).toBe("open");
  });
});
