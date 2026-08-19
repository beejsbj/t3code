/**
 * PROTOTYPE — real T3 board sessions placed in a navigable spatial scene.
 *
 * WebGL draws the field while full session views remain live React DOM. This
 * keeps the existing T3 chat surface intact while the camera stays experimental.
 */

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";

import {
  selectBoardPlacement,
  useBoardLaneStore,
  type BoardLane,
  type BoardLaneId,
} from "../../board/boardLaneStore.ts";
import { boardLaneLabel, resolveBoardLane } from "../../board/boardLanes.ts";
import {
  BOARD_STATE_BY_ID,
  resolveBoardThreadState,
  type BoardStateId,
} from "../../board/boardOrganization.ts";
import { useClientSettings } from "../../hooks/useSettings.ts";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { useBoardFocusStore } from "../../board/boardFocusStore.ts";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider.tsx";
import { resolveBoardThreadVisibility } from "../board/SessionBoard.logic.ts";
import { SidebarInset } from "../ui/sidebar.tsx";
import { SpatialSessionScene } from "./SpatialSessionScene.tsx";
import { SpatialSessionSurface } from "./SpatialSessionSurface.tsx";

interface SpatialBoardSession {
  readonly cardKey: string;
  readonly threadRef: ReturnType<typeof scopeThreadRef>;
  readonly thread: SidebarThreadSummary;
  readonly laneId: BoardLaneId;
  readonly workflowLabel: string;
  readonly boardStateId: BoardStateId;
  readonly boardStateLabel: string;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly projectTitle: string;
}

function useRealBoardSessions(): ReadonlyArray<SpatialBoardSession> {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const lanes = useBoardLaneStore((state) => state.lanes);
  const placementByThreadKey = useBoardLaneStore((state) => state.placementByThreadKey);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((settings) => settings.sidebarAutoSettleOnMerge);

  return useMemo(() => {
    const projectTitleByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title] as const),
    );
    const now = new Date().toISOString();

    return threads
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .flatMap<SpatialBoardSession>((thread) => {
        const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
        const visibility = resolveBoardThreadVisibility(thread, {
          now,
          settlementNow: now,
          autoSettleAfterDays,
          autoSettleOnMerge,
          supportsSettlement: capabilities?.threadSettlement === true,
          supportsSnooze: capabilities?.threadSnooze === true,
          changeRequestState: null,
        });
        if (visibility === "archived") return [];

        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        const laneId = resolveBoardLane(
          selectBoardPlacement(placementByThreadKey, threadRef),
          lanes,
        );
        const boardStateId = resolveBoardThreadState(thread, visibility);
        if (laneId === null || boardStateId === null) return [];

        return [
          {
            cardKey: scopedThreadKey(threadRef),
            threadRef,
            thread,
            laneId,
            workflowLabel: boardLaneLabel(laneId, lanes),
            boardStateId,
            boardStateLabel: BOARD_STATE_BY_ID[boardStateId].label,
            lanes,
            projectTitle:
              projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? "Project",
          },
        ];
      });
  }, [
    autoSettleAfterDays,
    autoSettleOnMerge,
    lanes,
    placementByThreadKey,
    projects,
    serverConfigs,
    threads,
  ]);
}

export function SpatialBoardPrototype(): React.JSX.Element {
  const sessions = useRealBoardSessions();
  const focusedThreadKey = useBoardFocusStore((state) => state.focusedThreadKey);
  const focusedSession = sessions.find((session) => session.cardKey === focusedThreadKey) ?? null;

  return (
    <SidebarInset className="relative h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <header className="relative z-20 flex min-h-12 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-sm font-medium">Spatial session board</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            {sessions.length} full sessions · workflow, project, and state arranged in space
          </p>
        </div>
        <p className="ml-auto max-w-[55%] truncate text-[11px] text-muted-foreground">
          Board
          {focusedSession
            ? ` › ${focusedSession.workflowLabel} › ${focusedSession.projectTitle} › ${focusedSession.boardStateLabel} › ${focusedSession.thread.title}`
            : " › Overview"}
        </p>
      </header>

      <DiffWorkerPoolProvider>
        <SpatialSessionScene sessions={sessions}>
          {(session, state) => (
            <SpatialSessionSurface session={session} live={state.live} focused={state.focused} />
          )}
        </SpatialSessionScene>
      </DiffWorkerPoolProvider>
    </SidebarInset>
  );
}

export type { SpatialBoardSession };
