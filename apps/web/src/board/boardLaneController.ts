import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  selectBoardPlacement,
  useBoardLaneStore,
  type BoardLane,
  type BoardLaneId,
} from "./boardLaneStore.ts";
import { resolveBoardLane, resolveWorkflowBoardLane, workflowBoardLanes } from "./boardLanes.ts";

export interface BoardLanePlacement {
  readonly explicit: boolean;
  readonly lane: BoardLane | null;
}

export type BoardLanePlacementResult =
  | { readonly type: "placed"; readonly placement: BoardLanePlacement }
  | { readonly type: "error"; readonly message: string };

type BoardLaneStoreApi = Pick<typeof useBoardLaneStore, "getState">;

export function createBoardLaneController(store: BoardLaneStoreApi) {
  const list = (): ReadonlyArray<BoardLane> => workflowBoardLanes(store.getState().lanes);

  const placement = (ref: ScopedThreadRef): BoardLanePlacement => {
    const state = store.getState();
    const explicitLaneId = selectBoardPlacement(state.placementByThreadKey, ref);
    const effectiveLaneId = resolveBoardLane(explicitLaneId, state.lanes);
    return {
      explicit: explicitLaneId !== undefined,
      lane: state.lanes.find((lane) => lane.id === effectiveLaneId) ?? null,
    };
  };

  const place = (ref: ScopedThreadRef, laneIdOrExactName: string): BoardLanePlacementResult => {
    const resolved = resolveWorkflowBoardLane(store.getState().lanes, laneIdOrExactName);
    if (resolved.type === "error") return resolved;
    store.getState().setPlacement(ref, resolved.lane.id);
    return { type: "placed", placement: placement(ref) };
  };

  const placeInLane = (ref: ScopedThreadRef, laneId: BoardLaneId): BoardLanePlacementResult =>
    place(ref, laneId);

  const unplace = (ref: ScopedThreadRef): BoardLanePlacement => {
    store.getState().clearPlacement(ref);
    return placement(ref);
  };

  return { list, placement, place, placeInLane, unplace } as const;
}

/** One client-local API shared by board UI, composer commands, and agent requests. */
export const boardLaneController = createBoardLaneController(useBoardLaneStore);
