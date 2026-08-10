import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { EnvironmentId } from "@t3tools/contracts";

import { resolveStorage } from "../lib/storage";

const BOARD_LANE_STORAGE_KEY = "t3code:board-lanes:v1";
const BOARD_LANE_STORAGE_VERSION = 1;

export const BOARD_LANE_MIN_WIDTH = 260;
export const BOARD_LANE_MAX_WIDTH = 720;
export const BOARD_LANE_DEFAULT_WIDTH = 380;

export interface BoardLaneState {
  readonly widthPx: number;
}

interface BoardLaneStoreState {
  readonly byLaneColumnKey: Record<string, BoardLaneState>;
  readonly groupByProject: boolean;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly setWidth: (laneColumnKey: string, widthPx: number) => void;
  readonly removeLane: (laneColumnKey: string) => void;
  readonly setGroupByProject: (groupByProject: boolean) => void;
  readonly setSelectedEnvironmentId: (environmentId: EnvironmentId | null) => void;
}

export function clampBoardLaneWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return BOARD_LANE_DEFAULT_WIDTH;
  return Math.min(BOARD_LANE_MAX_WIDTH, Math.max(BOARD_LANE_MIN_WIDTH, Math.round(widthPx)));
}

function normalizePersistedByLaneColumnKey(
  persistedState: unknown,
): Record<string, BoardLaneState> {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  const source = (persistedState as { byLaneColumnKey?: unknown }).byLaneColumnKey;
  if (typeof source !== "object" || source === null) return {};
  const byLaneColumnKey: Record<string, BoardLaneState> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const width = (value as { widthPx?: unknown } | null)?.widthPx;
    if (typeof width === "number") {
      byLaneColumnKey[key] = { widthPx: clampBoardLaneWidth(width) };
    }
  }
  return byLaneColumnKey;
}

export const useBoardLaneStore = create<BoardLaneStoreState>()(
  persist(
    (set) => ({
      byLaneColumnKey: {},
      groupByProject: true,
      selectedEnvironmentId: null,
      setWidth: (laneColumnKey, widthPx) =>
        set((state) => {
          const next = clampBoardLaneWidth(widthPx);
          if (state.byLaneColumnKey[laneColumnKey]?.widthPx === next) return state;
          return {
            byLaneColumnKey: {
              ...state.byLaneColumnKey,
              [laneColumnKey]: { widthPx: next },
            },
          };
        }),
      removeLane: (laneColumnKey) =>
        set((state) => {
          if (!(laneColumnKey in state.byLaneColumnKey)) return state;
          const { [laneColumnKey]: _removed, ...byLaneColumnKey } = state.byLaneColumnKey;
          return { byLaneColumnKey };
        }),
      setGroupByProject: (groupByProject) =>
        set((state) => (state.groupByProject === groupByProject ? state : { groupByProject })),
      setSelectedEnvironmentId: (selectedEnvironmentId) =>
        set((state) =>
          state.selectedEnvironmentId === selectedEnvironmentId ? state : { selectedEnvironmentId },
        ),
    }),
    {
      name: BOARD_LANE_STORAGE_KEY,
      version: BOARD_LANE_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byLaneColumnKey: state.byLaneColumnKey,
        groupByProject: state.groupByProject,
        selectedEnvironmentId: state.selectedEnvironmentId,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        byLaneColumnKey: normalizePersistedByLaneColumnKey(persistedState),
        groupByProject:
          typeof (persistedState as { groupByProject?: unknown } | null)?.groupByProject ===
          "boolean"
            ? (persistedState as { groupByProject: boolean }).groupByProject
            : currentState.groupByProject,
        selectedEnvironmentId:
          typeof (persistedState as { selectedEnvironmentId?: unknown } | null)
            ?.selectedEnvironmentId === "string"
            ? (persistedState as { selectedEnvironmentId: EnvironmentId }).selectedEnvironmentId
            : currentState.selectedEnvironmentId,
      }),
    },
  ),
);

export function selectBoardLaneWidth(
  byLaneColumnKey: Record<string, BoardLaneState>,
  laneColumnKey: string,
): number {
  return byLaneColumnKey[laneColumnKey]?.widthPx ?? BOARD_LANE_DEFAULT_WIDTH;
}
