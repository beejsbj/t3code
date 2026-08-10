import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  BOARD_LANE_DEFAULT_WIDTH,
  BOARD_LANE_MAX_WIDTH,
  BOARD_LANE_MIN_WIDTH,
  selectBoardLaneWidth,
  useBoardLaneStore,
} from "./boardLaneStore.ts";

const laneA = JSON.stringify(["env-1", "triage"]);
const laneB = JSON.stringify(["env-1", "ready"]);

beforeEach(() => {
  useBoardLaneStore.setState({
    byLaneColumnKey: {},
    groupByProject: true,
    selectedEnvironmentId: null,
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

  it("selectBoardLaneWidth defaults to the workflow lane width", () => {
    expect(selectBoardLaneWidth(useBoardLaneStore.getState().byLaneColumnKey, laneB)).toBe(
      BOARD_LANE_DEFAULT_WIDTH,
    );
  });

  it("removeLane clears persisted state", () => {
    useBoardLaneStore.getState().setWidth(laneA, 420);
    useBoardLaneStore.getState().removeLane(laneA);
    expect(selectBoardLaneWidth(useBoardLaneStore.getState().byLaneColumnKey, laneA)).toBe(
      BOARD_LANE_DEFAULT_WIDTH,
    );
    expect(useBoardLaneStore.getState().byLaneColumnKey).toEqual({});
  });

  it("persists the project-grouping preference", () => {
    useBoardLaneStore.getState().setGroupByProject(false);
    expect(useBoardLaneStore.getState().groupByProject).toBe(false);

    const persisted = useBoardLaneStore.persist
      .getOptions()
      .partialize?.(useBoardLaneStore.getState()) as { groupByProject?: boolean };
    expect(persisted.groupByProject).toBe(false);
  });

  it("persists the selected board environment", () => {
    useBoardLaneStore.getState().setSelectedEnvironmentId("env-2" as EnvironmentId);
    expect(useBoardLaneStore.getState().selectedEnvironmentId).toBe("env-2");

    const persisted = useBoardLaneStore.persist
      .getOptions()
      .partialize?.(useBoardLaneStore.getState()) as { selectedEnvironmentId?: string };
    expect(persisted.selectedEnvironmentId).toBe("env-2");
  });

  it("clamps out-of-range persisted widths on rehydrate", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        byLaneColumnKey: {
          [laneA]: { widthPx: BOARD_LANE_MAX_WIDTH + 1000 },
          [laneB]: { widthPx: BOARD_LANE_MIN_WIDTH - 1000 },
        },
      },
      useBoardLaneStore.getInitialState(),
    );

    expect(mergedState.byLaneColumnKey).toEqual({
      [laneA]: { widthPx: BOARD_LANE_MAX_WIDTH },
      [laneB]: { widthPx: BOARD_LANE_MIN_WIDTH },
    });
    expect(mergedState.groupByProject).toBe(true);
    expect(mergedState.selectedEnvironmentId).toBeNull();
  });

  it("rehydrates a persisted project-grouping preference", () => {
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
      .merge({ groupByProject: false }, useBoardLaneStore.getInitialState());
    expect(mergedState.groupByProject).toBe(false);
  });

  it("rehydrates a persisted board environment", () => {
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
      .merge({ selectedEnvironmentId: "env-2" }, useBoardLaneStore.getInitialState());
    expect(mergedState.selectedEnvironmentId).toBe("env-2");
  });

  it("drops malformed persisted entries on rehydrate", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };

    expect(
      persistApi.getOptions().merge(null, useBoardLaneStore.getInitialState()).byLaneColumnKey,
    ).toEqual({});
    expect(
      persistApi
        .getOptions()
        .merge(
          { byLaneColumnKey: { [laneA]: { widthPx: "wide" } } },
          useBoardLaneStore.getInitialState(),
        ).byLaneColumnKey,
    ).toEqual({});
  });
});
