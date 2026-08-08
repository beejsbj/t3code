import { LaneId, type LaneDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectSwimlanes,
  boardLaneHeaderDroppableId,
  groupEntriesByLane,
  laneArchiveIntent,
  laneColumnKeyFromSwimlaneDroppableId,
  laneIdForName,
  nextLaneOrder,
  reorderLaneUpdates,
  resolveBoardLaneDrop,
  resolveBoardFocusAction,
  shouldHideSwimlaneProjectHeader,
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

    const swimlanes = buildProjectSwimlanes(entries, null);

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

    const swimlanes = buildProjectSwimlanes(entries, "env:alpha");

    expect(swimlanes).toHaveLength(1);
    expect(swimlanes[0]?.projectKey).toBe("env:alpha");
  });

  it("uses one nullable project scope for filtering and project headers", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-b", "2026-01-02T00:00:00.000Z"),
    ];

    expect(buildProjectSwimlanes(entries, null)).toHaveLength(2);
    expect(buildProjectSwimlanes(entries, "env:alpha")).toHaveLength(1);
    expect(shouldHideSwimlaneProjectHeader(null)).toBe(false);
    expect(shouldHideSwimlaneProjectHeader("env:alpha")).toBe(true);
  });
});

describe("groupEntriesByLane", () => {
  it("keeps lane column order identical for every swimlane", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-c", "2026-01-01T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-a", "2026-01-02T00:00:00.000Z"),
    ];

    for (const swimlane of buildProjectSwimlanes(entries, null)) {
      expect([...groupEntriesByLane(swimlane.entries, laneKeys).keys()]).toEqual([...laneKeys]);
    }
  });
});

describe("swimlaneColumnDroppableId", () => {
  it("round-trips lane column keys for drag and drop targets", () => {
    const droppableId = swimlaneColumnDroppableId("env:alpha", laneKeys[1]);
    expect(laneColumnKeyFromSwimlaneDroppableId(droppableId)).toBe(laneKeys[1]);
  });

  it("makes the continuous lane header a real drop target", () => {
    const droppableId = boardLaneHeaderDroppableId(laneKeys[1]);
    expect(laneColumnKeyFromSwimlaneDroppableId(droppableId)).toBe(laneKeys[1]);
  });
});

describe("resolveBoardLaneDrop", () => {
  const entries = [
    { key: "env-a:thread-1", environmentId: "env-a" },
    { key: "env-b:thread-2", environmentId: "env-b" },
  ];
  const columns = [
    { key: laneKeys[0], environmentId: "env-a" },
    { key: laneKeys[1], environmentId: "env-b" },
  ];

  it("resolves a same-environment drop from its active card and target id", () => {
    expect(
      resolveBoardLaneDrop({
        activeId: entries[0]!.key,
        overId: boardLaneHeaderDroppableId(columns[0]!.key),
        entries,
        columns,
      }),
    ).toEqual({ entry: entries[0], target: columns[0] });
  });

  it("rejects a visible lane owned by another environment", () => {
    expect(
      resolveBoardLaneDrop({
        activeId: entries[0]!.key,
        overId: swimlaneColumnDroppableId("project", columns[1]!.key),
        entries,
        columns,
      }),
    ).toBeNull();
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
