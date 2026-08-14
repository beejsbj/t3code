import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  BOARD_LANE_DEFAULT_WIDTH,
  BOARD_LANE_MAX_WIDTH,
  BOARD_LANE_MIN_WIDTH,
  DEFAULT_BOARD_LANES,
  orderBoardLaneEntries,
  selectBoardLaneWidth,
  selectBoardPlacement,
  useBoardLaneStore,
} from "./boardLaneStore.ts";

const laneA = "triage";
const laneB = "ready";
const firstThread = scopeThreadRef("env-a" as EnvironmentId, ThreadId.make("thread-1"));
const sameIdElsewhere = scopeThreadRef("env-b" as EnvironmentId, ThreadId.make("thread-1"));

beforeEach(() => {
  useBoardLaneStore.setState({
    lanes: DEFAULT_BOARD_LANES,
    placementByThreadKey: {},
    laneEntryByThreadKey: {},
    orderByLaneId: {},
    byLaneColumnKey: {},
    groupByProject: true,
  });
});

describe("boardLaneStore", () => {
  it("setWidth clamps to the min/max lane width", () => {
    useBoardLaneStore.getState().setWidth(laneA, BOARD_LANE_MIN_WIDTH - 100);
    expect(selectBoardLaneWidth(useBoardLaneStore.getState().byLaneColumnKey, laneA)).toBe(
      BOARD_LANE_MIN_WIDTH,
    );

    useBoardLaneStore.getState().setWidth(laneA, BOARD_LANE_MAX_WIDTH + 100);
    expect(selectBoardLaneWidth(useBoardLaneStore.getState().byLaneColumnKey, laneA)).toBe(
      BOARD_LANE_MAX_WIDTH,
    );
  });

  it("keeps placements scoped when environments reuse a thread id", () => {
    const store = useBoardLaneStore.getState();
    store.setPlacement(firstThread, "ready");
    store.setPlacement(sameIdElsewhere, "triage");

    expect(
      selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, firstThread),
    ).toBe("ready");
    expect(
      selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, sameIdElsewhere),
    ).toBe("triage");
  });

  it("records a fresh lane-entry time and removes stale manual order on placement", () => {
    useBoardLaneStore.setState({
      orderByLaneId: { triage: ["env-a:thread-1"] },
    });

    useBoardLaneStore.getState().setPlacement(firstThread, "ready");

    const state = useBoardLaneStore.getState();
    expect(state.laneEntryByThreadKey["env-a:thread-1"]?.laneId).toBe("ready");
    expect(Date.parse(state.laneEntryByThreadKey["env-a:thread-1"]?.enteredAt ?? "")).not.toBeNaN();
    expect(state.orderByLaneId).toEqual({});
  });

  it("stores a deduplicated manual sequence for a lane", () => {
    useBoardLaneStore
      .getState()
      .setLaneOrder("triage", ["env-a:thread-2", "env-a:thread-1", "env-a:thread-2"]);

    expect(useBoardLaneStore.getState().orderByLaneId).toEqual({
      triage: ["env-a:thread-2", "env-a:thread-1"],
    });
  });

  it("orders by lane entry until a manual sequence takes over", () => {
    const entries = [
      { key: "env-a:older", laneId: "triage", createdAt: "2026-01-01T00:00:00.000Z" },
      { key: "env-a:newer", laneId: "triage", createdAt: "2026-01-02T00:00:00.000Z" },
    ];

    expect(orderBoardLaneEntries(entries, {}, {}).map((entry) => entry.key)).toEqual([
      "env-a:newer",
      "env-a:older",
    ]);
    expect(
      orderBoardLaneEntries(
        entries,
        {
          "env-a:older": {
            laneId: "triage",
            enteredAt: "2026-01-03T00:00:00.000Z",
          },
        },
        {},
      ).map((entry) => entry.key),
    ).toEqual(["env-a:older", "env-a:newer"]);
    expect(
      orderBoardLaneEntries(entries, {}, { triage: ["env-a:older", "env-a:newer"] }).map(
        (entry) => entry.key,
      ),
    ).toEqual(["env-a:older", "env-a:newer"]);
  });

  it("ignores live activity timestamps when ordering cards", () => {
    const entries = [
      {
        key: "env-a:first",
        laneId: "triage",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-10T00:00:00.000Z",
      },
      {
        key: "env-a:second",
        laneId: "triage",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];

    expect(orderBoardLaneEntries(entries, {}, {}).map((entry) => entry.key)).toEqual([
      "env-a:second",
      "env-a:first",
    ]);
    expect(
      orderBoardLaneEntries(
        entries.map((entry) => ({ ...entry, updatedAt: "2026-12-31T00:00:00.000Z" })),
        {},
        {},
      ).map((entry) => entry.key),
    ).toEqual(["env-a:second", "env-a:first"]);
  });

  it("places arrivals above an existing manual sequence", () => {
    const entries = [
      { key: "env-a:first", laneId: "ready", createdAt: "2026-01-01T00:00:00.000Z" },
      { key: "env-a:second", laneId: "ready", createdAt: "2026-01-02T00:00:00.000Z" },
      { key: "env-a:new", laneId: "ready", createdAt: "2026-01-03T00:00:00.000Z" },
    ];

    expect(
      orderBoardLaneEntries(entries, {}, { ready: ["env-a:first", "env-a:second"] }).map(
        (entry) => entry.key,
      ),
    ).toEqual(["env-a:new", "env-a:first", "env-a:second"]);
  });

  it("retains explicit removal separately from an unplaced session", () => {
    useBoardLaneStore.getState().setPlacement(firstThread, null);
    expect(
      selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, firstThread),
    ).toBe(null);
    expect(
      selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, sameIdElsewhere),
    ).toBeUndefined();
  });

  it("archives a lane locally and returns its members to implicit placement", () => {
    const store = useBoardLaneStore.getState();
    store.createLane({ id: "ready", name: "Ready", description: "Ready", order: 2 });
    store.setPlacement(firstThread, "ready");
    store.archiveLane("ready");

    expect(useBoardLaneStore.getState().lanes.map((lane) => lane.id)).not.toContain("ready");
    expect(
      selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, firstThread),
    ).toBeUndefined();
  });

  it("keeps one lane so the local board cannot become unusable", () => {
    useBoardLaneStore.setState({
      lanes: [{ id: "only", name: "Only", description: "The final lane", order: 0 }],
    });

    useBoardLaneStore.getState().archiveLane("only");

    expect(useBoardLaneStore.getState().lanes).toEqual([
      { id: "only", name: "Only", description: "The final lane", order: 0 },
    ]);
  });

  it("persists local lanes, placements, widths, and project grouping", () => {
    const store = useBoardLaneStore.getState();
    store.setPlacement(firstThread, "triage");
    store.setWidth(laneA, 420);
    store.setGroupByProject(false);

    const persisted = useBoardLaneStore.persist
      .getOptions()
      .partialize?.(useBoardLaneStore.getState()) as {
      lanes?: unknown;
      placementByThreadKey?: unknown;
      laneEntryByThreadKey?: unknown;
      orderByLaneId?: unknown;
      groupByProject?: boolean;
    };
    expect(persisted.lanes).toEqual(DEFAULT_BOARD_LANES);
    expect(persisted.placementByThreadKey).toEqual({ "env-a:thread-1": "triage" });
    expect(persisted.laneEntryByThreadKey).toEqual({
      "env-a:thread-1": expect.objectContaining({ laneId: "triage" }),
    });
    expect(persisted.orderByLaneId).toEqual({});
    expect(persisted.groupByProject).toBe(false);
  });

  it("migrates the old environment-scoped store without importing server organization", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const migrated = persistApi.getOptions().migrate(
      {
        byLaneColumnKey: { '["env-a","triage"]': { widthPx: 460 } },
        selectedEnvironmentId: "env-a",
        groupByProject: false,
      },
      1,
    );
    const mergedState = persistApi
      .getOptions()
      .merge(migrated, useBoardLaneStore.getInitialState());

    expect(mergedState.lanes).toEqual(DEFAULT_BOARD_LANES);
    expect(mergedState.placementByThreadKey).toEqual({});
    expect(mergedState.laneEntryByThreadKey).toEqual({});
    expect(mergedState.orderByLaneId).toEqual({});
    expect(mergedState.groupByProject).toBe(false);
    expect(mergedState.byLaneColumnKey).toEqual({ '["env-a","triage"]': { widthPx: 460 } });
  });

  it("adds ordering state without discarding version two board placement", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
      };
    };
    const versionTwoState = {
      lanes: DEFAULT_BOARD_LANES,
      placementByThreadKey: { "env-a:thread-1": "ready" },
      byLaneColumnKey: { ready: { widthPx: 440 } },
      groupByProject: false,
    };

    expect(persistApi.getOptions().migrate(versionTwoState, 2)).toEqual({
      ...versionTwoState,
      laneEntryByThreadKey: {},
      orderByLaneId: {},
    });
  });

  it("clamps malformed persisted widths and defaults absent local lane data", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const mergedState = persistApi
      .getOptions()
      .merge(
        { byLaneColumnKey: { [laneB]: { widthPx: BOARD_LANE_MAX_WIDTH + 1000 } } },
        useBoardLaneStore.getInitialState(),
      );

    expect(mergedState.lanes).toEqual(DEFAULT_BOARD_LANES);
    expect(mergedState.byLaneColumnKey).toEqual({ [laneB]: { widthPx: BOARD_LANE_MAX_WIDTH } });
    expect(selectBoardLaneWidth(mergedState.byLaneColumnKey, "missing")).toBe(
      BOARD_LANE_DEFAULT_WIDTH,
    );
  });
});
