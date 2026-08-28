import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  selectBoardPlacement,
  useBoardLaneStore,
  type BoardLane,
  type BoardLaneId,
} from "./boardLaneStore.ts";
import { resolveBoardLane, resolveWorkflowBoardLane, workflowBoardLanes } from "./boardLanes.ts";

export interface BoardLaneState {
  readonly overridden: boolean;
  readonly lane: BoardLane | null;
}

export type BoardLaneMoveResult =
  | { readonly type: "moved"; readonly state: BoardLaneState }
  | { readonly type: "error"; readonly message: string };

type BoardLaneStoreApi = Pick<typeof useBoardLaneStore, "getState">;

export function createBoardLaneController(store: BoardLaneStoreApi) {
  const list = (): ReadonlyArray<BoardLane> => workflowBoardLanes(store.getState().lanes);

  const current = (ref: ScopedThreadRef): BoardLaneState => {
    const state = store.getState();
    const laneOverride = selectBoardPlacement(state.placementByThreadKey, ref);
    const effectiveLaneId = resolveBoardLane(laneOverride, state.lanes);
    return {
      overridden: laneOverride !== undefined,
      lane: state.lanes.find((lane) => lane.id === effectiveLaneId) ?? null,
    };
  };

  const move = (ref: ScopedThreadRef, laneIdOrExactName: string): BoardLaneMoveResult => {
    const state = store.getState();
    const resolved = resolveWorkflowBoardLane(state.lanes, laneIdOrExactName);
    if (resolved.type === "error") return resolved;
    const defaultLaneId = resolveBoardLane(undefined, state.lanes);
    if (resolved.lane.id === defaultLaneId) state.clearPlacement(ref);
    else state.setPlacement(ref, resolved.lane.id);
    return { type: "moved", state: current(ref) };
  };

  const moveToLane = (ref: ScopedThreadRef, laneId: BoardLaneId): BoardLaneMoveResult =>
    move(ref, laneId);

  return { list, current, move, moveToLane } as const;
}

/** One client-local API shared by board UI, composer commands, and agent requests. */
export const boardLaneController = createBoardLaneController(useBoardLaneStore);
