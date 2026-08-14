import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

const BOARD_LANE_STORAGE_KEY = "t3code:board-lanes:v1";
const BOARD_LANE_STORAGE_VERSION = 3;

export const BOARD_LANE_MIN_WIDTH = 260;
export const BOARD_LANE_MAX_WIDTH = 720;
export const BOARD_LANE_DEFAULT_WIDTH = 380;

export type BoardLaneId = string;

/**
 * A board lane belongs to the client surface, not to an environment. This is
 * intentionally a small local shape rather than an orchestration contract:
 * connected servers contribute sessions, while this browser or desktop window
 * decides where those sessions sit.
 */
export interface BoardLane {
  readonly id: BoardLaneId;
  readonly name: string;
  readonly description: string;
  readonly order: number;
}

export const DEFAULT_BOARD_LANES: ReadonlyArray<BoardLane> = Object.freeze([
  {
    id: "triage",
    name: "Triage",
    description: "New and unplaced sessions start here until you file them elsewhere",
    order: -1,
  },
  {
    id: "shaping",
    name: "Grilling / shaping",
    description: "Working out what this actually is",
    order: 0,
  },
  {
    id: "ready",
    name: "Ready",
    description: "Groomed and ready to pick up",
    order: 1,
  },
  {
    id: "done",
    name: "Done",
    description: "Finished work you want to keep visible on this board",
    order: 2,
  },
]);

export interface BoardLaneState {
  readonly widthPx: number;
}

export interface BoardLaneEntryState {
  readonly laneId: BoardLaneId;
  readonly enteredAt: string;
}

export interface BoardLaneDraft {
  readonly name: string;
  readonly description: string;
  readonly order: number;
}

interface BoardLaneStoreState {
  readonly lanes: ReadonlyArray<BoardLane>;
  /**
   * `undefined` means a session has never been placed and therefore falls
   * into the leftmost lane. `null` means it was explicitly removed from this
   * board. Keys are scoped so two environments may both contribute `thread-1`.
   */
  readonly placementByThreadKey: Record<string, BoardLaneId | null>;
  /** Explicit lane arrivals; implicit leftmost placement falls back to thread creation time. */
  readonly laneEntryByThreadKey: Record<string, BoardLaneEntryState>;
  /** Complete user-authored sequences. New arrivals not in a sequence sort above it. */
  readonly orderByLaneId: Record<BoardLaneId, ReadonlyArray<string>>;
  readonly byLaneColumnKey: Record<string, BoardLaneState>;
  readonly groupByProject: boolean;
  readonly setPlacement: (ref: ScopedThreadRef, laneId: BoardLaneId | null) => void;
  readonly setLaneOrder: (laneId: BoardLaneId, orderedThreadKeys: ReadonlyArray<string>) => void;
  readonly createLane: (lane: BoardLane) => void;
  readonly updateLane: (laneId: BoardLaneId, draft: BoardLaneDraft) => void;
  readonly archiveLane: (laneId: BoardLaneId) => void;
  readonly setWidth: (laneColumnKey: string, widthPx: number) => void;
  readonly removeLane: (laneColumnKey: string) => void;
  readonly setGroupByProject: (groupByProject: boolean) => void;
}

export function clampBoardLaneWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return BOARD_LANE_DEFAULT_WIDTH;
  return Math.min(BOARD_LANE_MAX_WIDTH, Math.max(BOARD_LANE_MIN_WIDTH, Math.round(widthPx)));
}

function normalizeLanes(value: unknown): ReadonlyArray<BoardLane> {
  if (!Array.isArray(value)) return DEFAULT_BOARD_LANES;
  const lanes: BoardLane[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, description, order } = entry as Partial<BoardLane>;
    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      ids.has(id) ||
      typeof name !== "string" ||
      name.trim() === "" ||
      typeof description !== "string" ||
      description.trim() === "" ||
      typeof order !== "number" ||
      !Number.isFinite(order)
    ) {
      continue;
    }
    ids.add(id);
    lanes.push({ id, name, description, order });
  }
  return lanes.length === 0 ? DEFAULT_BOARD_LANES : lanes;
}

function normalizePlacementByThreadKey(value: unknown): Record<string, BoardLaneId | null> {
  if (typeof value !== "object" || value === null) return {};
  const placementByThreadKey: Record<string, BoardLaneId | null> = {};
  for (const [threadKey, laneId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof laneId === "string" || laneId === null) placementByThreadKey[threadKey] = laneId;
  }
  return placementByThreadKey;
}

function normalizeLaneEntryByThreadKey(value: unknown): Record<string, BoardLaneEntryState> {
  if (typeof value !== "object" || value === null) return {};
  const laneEntryByThreadKey: Record<string, BoardLaneEntryState> = {};
  for (const [threadKey, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { laneId, enteredAt } = entry as Partial<BoardLaneEntryState>;
    if (
      typeof laneId === "string" &&
      laneId.length > 0 &&
      typeof enteredAt === "string" &&
      Number.isFinite(Date.parse(enteredAt))
    ) {
      laneEntryByThreadKey[threadKey] = { laneId, enteredAt };
    }
  }
  return laneEntryByThreadKey;
}

function normalizeOrderByLaneId(value: unknown): Record<BoardLaneId, ReadonlyArray<string>> {
  if (typeof value !== "object" || value === null) return {};
  const orderByLaneId: Record<BoardLaneId, ReadonlyArray<string>> = {};
  for (const [laneId, order] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(order)) continue;
    orderByLaneId[laneId] = [
      ...new Set(order.filter((threadKey): threadKey is string => typeof threadKey === "string")),
    ];
  }
  return orderByLaneId;
}

function withoutThreadKey(
  orderByLaneId: Record<BoardLaneId, ReadonlyArray<string>>,
  threadKey: string,
): Record<BoardLaneId, ReadonlyArray<string>> {
  let changed = false;
  const next: Record<BoardLaneId, ReadonlyArray<string>> = {};
  for (const [laneId, order] of Object.entries(orderByLaneId)) {
    const filtered = order.filter((key) => key !== threadKey);
    if (filtered.length !== order.length) changed = true;
    if (filtered.length > 0) next[laneId] = filtered;
  }
  return changed ? next : orderByLaneId;
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
    if (typeof width === "number") byLaneColumnKey[key] = { widthPx: clampBoardLaneWidth(width) };
  }
  return byLaneColumnKey;
}

/**
 * The pre-local-board store only held column widths and an environment picker.
 * Preserve the harmless presentation preferences but intentionally discard the
 * picker and all server-owned lane placement state; importing either would
 * make this client surface look authoritative over another environment.
 */
function migrateBoardLaneState(persistedState: unknown, version: number): unknown {
  if (version >= BOARD_LANE_STORAGE_VERSION) return persistedState;
  const legacy = persistedState as {
    lanes?: unknown;
    placementByThreadKey?: unknown;
    groupByProject?: unknown;
    byLaneColumnKey?: unknown;
  } | null;
  const versionTwoState =
    version < 2
      ? {
          lanes: DEFAULT_BOARD_LANES,
          placementByThreadKey: {},
          byLaneColumnKey: legacy?.byLaneColumnKey,
          groupByProject: legacy?.groupByProject,
        }
      : legacy;
  return {
    ...versionTwoState,
    laneEntryByThreadKey: {},
    orderByLaneId: {},
  };
}

export interface BoardLaneOrderedEntry {
  readonly key: string;
  readonly laneId: BoardLaneId;
  readonly createdAt: string;
}

/**
 * Stable card order for every lane. Unknown entries are new arrivals and sit
 * above the last manual sequence; otherwise lane-entry time (or creation time
 * for implicit placement) is the default. Runtime activity never participates.
 */
export function orderBoardLaneEntries<T extends BoardLaneOrderedEntry>(
  entries: ReadonlyArray<T>,
  laneEntryByThreadKey: Readonly<Record<string, BoardLaneEntryState>>,
  orderByLaneId: Readonly<Record<BoardLaneId, ReadonlyArray<string>>>,
): ReadonlyArray<T> {
  const indexByLaneId = new Map<string, ReadonlyMap<string, number>>();
  for (const [laneId, order] of Object.entries(orderByLaneId)) {
    indexByLaneId.set(laneId, new Map(order.map((threadKey, index) => [threadKey, index])));
  }

  return entries.toSorted((left, right) => {
    const laneComparison = left.laneId.localeCompare(right.laneId);
    if (laneComparison !== 0) return laneComparison;

    const manualOrder = indexByLaneId.get(left.laneId);
    const leftIndex = manualOrder?.get(left.key);
    const rightIndex = manualOrder?.get(right.key);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex === undefined && rightIndex !== undefined) return -1;
    if (leftIndex !== undefined && rightIndex === undefined) return 1;

    const leftEntry = laneEntryByThreadKey[left.key];
    const rightEntry = laneEntryByThreadKey[right.key];
    const leftEnteredAt = leftEntry?.laneId === left.laneId ? leftEntry.enteredAt : left.createdAt;
    const rightEnteredAt =
      rightEntry?.laneId === right.laneId ? rightEntry.enteredAt : right.createdAt;
    return rightEnteredAt.localeCompare(leftEnteredAt) || left.key.localeCompare(right.key);
  });
}

export const useBoardLaneStore = create<BoardLaneStoreState>()(
  persist(
    (set) => ({
      lanes: DEFAULT_BOARD_LANES,
      placementByThreadKey: {},
      laneEntryByThreadKey: {},
      orderByLaneId: {},
      byLaneColumnKey: {},
      groupByProject: true,
      setPlacement: (ref, laneId) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (state.placementByThreadKey[threadKey] === laneId) return state;
          const laneEntryByThreadKey = { ...state.laneEntryByThreadKey };
          if (laneId === null) delete laneEntryByThreadKey[threadKey];
          else laneEntryByThreadKey[threadKey] = { laneId, enteredAt: new Date().toISOString() };
          return {
            placementByThreadKey: {
              ...state.placementByThreadKey,
              [threadKey]: laneId,
            },
            laneEntryByThreadKey,
            orderByLaneId: withoutThreadKey(state.orderByLaneId, threadKey),
          };
        }),
      setLaneOrder: (laneId, orderedThreadKeys) =>
        set((state) => {
          const order = [...new Set(orderedThreadKeys)];
          const current = state.orderByLaneId[laneId] ?? [];
          if (
            current.length === order.length &&
            current.every((key, index) => key === order[index])
          ) {
            return state;
          }
          return { orderByLaneId: { ...state.orderByLaneId, [laneId]: order } };
        }),
      createLane: (lane) =>
        set((state) => {
          if (state.lanes.some((existing) => existing.id === lane.id)) return state;
          return { lanes: [...state.lanes, lane] };
        }),
      updateLane: (laneId, draft) =>
        set((state) => {
          let changed = false;
          const lanes = state.lanes.map((lane) => {
            if (lane.id !== laneId) return lane;
            changed =
              lane.name !== draft.name ||
              lane.description !== draft.description ||
              lane.order !== draft.order;
            return changed ? { ...lane, ...draft } : lane;
          });
          return changed ? { lanes } : state;
        }),
      archiveLane: (laneId) =>
        set((state) => {
          if (state.lanes.length <= 1 || !state.lanes.some((lane) => lane.id === laneId)) {
            return state;
          }
          const lanes = state.lanes.filter((lane) => lane.id !== laneId);
          const placementByThreadKey = { ...state.placementByThreadKey };
          const laneEntryByThreadKey = { ...state.laneEntryByThreadKey };
          for (const [threadKey, placement] of Object.entries(placementByThreadKey)) {
            // An archived lane turns cards back into implicit-leftmost placement.
            if (placement === laneId) {
              delete placementByThreadKey[threadKey];
              delete laneEntryByThreadKey[threadKey];
            }
          }
          const { [laneId]: _removedWidth, ...byLaneColumnKey } = state.byLaneColumnKey;
          const { [laneId]: _removedOrder, ...orderByLaneId } = state.orderByLaneId;
          return {
            lanes,
            placementByThreadKey,
            laneEntryByThreadKey,
            orderByLaneId,
            byLaneColumnKey,
          };
        }),
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
    }),
    {
      name: BOARD_LANE_STORAGE_KEY,
      version: BOARD_LANE_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      migrate: migrateBoardLaneState,
      partialize: (state) => ({
        lanes: state.lanes,
        placementByThreadKey: state.placementByThreadKey,
        laneEntryByThreadKey: state.laneEntryByThreadKey,
        orderByLaneId: state.orderByLaneId,
        byLaneColumnKey: state.byLaneColumnKey,
        groupByProject: state.groupByProject,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        lanes: normalizeLanes((persistedState as { lanes?: unknown } | null)?.lanes),
        placementByThreadKey: normalizePlacementByThreadKey(
          (persistedState as { placementByThreadKey?: unknown } | null)?.placementByThreadKey,
        ),
        laneEntryByThreadKey: normalizeLaneEntryByThreadKey(
          (persistedState as { laneEntryByThreadKey?: unknown } | null)?.laneEntryByThreadKey,
        ),
        orderByLaneId: normalizeOrderByLaneId(
          (persistedState as { orderByLaneId?: unknown } | null)?.orderByLaneId,
        ),
        byLaneColumnKey: normalizePersistedByLaneColumnKey(persistedState),
        groupByProject:
          typeof (persistedState as { groupByProject?: unknown } | null)?.groupByProject ===
          "boolean"
            ? (persistedState as { groupByProject: boolean }).groupByProject
            : currentState.groupByProject,
      }),
    },
  ),
);

// A board is local to this browser profile, not to one tab. Rehydrate when a
// sibling tab saves so later edits do not write an arbitrarily stale snapshot.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === BOARD_LANE_STORAGE_KEY) void useBoardLaneStore.persist.rehydrate();
  });
}

export function selectBoardLaneWidth(
  byLaneColumnKey: Record<string, BoardLaneState>,
  laneColumnKey: string,
): number {
  return byLaneColumnKey[laneColumnKey]?.widthPx ?? BOARD_LANE_DEFAULT_WIDTH;
}

export function selectBoardPlacement(
  placementByThreadKey: Record<string, BoardLaneId | null>,
  ref: ScopedThreadRef,
): BoardLaneId | null | undefined {
  return placementByThreadKey[scopedThreadKey(ref)];
}
