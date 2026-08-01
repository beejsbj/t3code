import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  LaneId,
  type EnvironmentId,
  type LaneDefinition,
  type ScopedThreadRef,
  type WorkflowLane,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { resolveBoardPlacement, type BoardPlacement } from "../../board/boardLanes.ts";
import { useBoardCardStore } from "../../board/boardCardStore.ts";
import { useNowMinute } from "../../hooks/useNowMinute.ts";
import { useClientSettings } from "../../hooks/useSettings.ts";
import { useLaneRegistries, useProjects, useThreadShells } from "../../state/entities.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { cn } from "~/lib/utils";
import { BoardSessionCard } from "./BoardSessionCard.tsx";

interface PlacedThread {
  readonly ref: ScopedThreadRef;
  readonly key: string;
  readonly thread: SidebarThreadSummary;
  readonly placement: BoardPlacement;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly projectTitle: string;
}

interface BoardLaneColumn {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly lane: LaneDefinition;
}

const NEEDS_YOU_LANE = LaneId.make("needs-you");
const NEEDS_YOU_DROPPABLE_ID = "board:needs-you";

function laneColumnKey(environmentId: EnvironmentId, laneId: WorkflowLane): string {
  return JSON.stringify([environmentId, laneId]);
}

export function SessionBoard() {
  const threads = useThreadShells();
  const projects = useProjects();
  const laneRegistries = useLaneRegistries();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const nowMinute = useNowMinute();
  const focusedThreadKey = useBoardCardStore((state) => state.focusedThreadKey);
  const clearFocus = useBoardCardStore((state) => state.clearFocus);
  const setWorkflowLane = useAtomCommand(threadEnvironment.setWorkflowLane, {
    reportFailure: false,
  });
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [snoozeWakeTick, setSnoozeWakeTick] = useState(0);

  useEffect(() => {
    const nowMs = Date.now();
    let nextWakeAtMs = Number.POSITIVE_INFINITY;
    for (const thread of threads) {
      if (thread.snoozedUntil == null) continue;
      const wakeAtMs = Date.parse(thread.snoozedUntil);
      if (wakeAtMs > nowMs && wakeAtMs < nextWakeAtMs) nextWakeAtMs = wakeAtMs;
    }
    if (!Number.isFinite(nextWakeAtMs)) return;

    const delayMs = Math.min(Math.max(0, nextWakeAtMs - nowMs) + 50, 2_147_483_647);
    const id = window.setTimeout(() => setSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozeWakeTick, threads]);

  const projectTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(`${project.environmentId}:${project.id}`, project.title);
    }
    return map;
  }, [projects]);

  const boardLanes = useMemo<ReadonlyArray<BoardLaneColumn>>(
    () =>
      [...laneRegistries.entries()].flatMap(([environmentId, lanes]) =>
        lanes
          .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
          .map((lane) => ({
            key: laneColumnKey(environmentId, lane.id),
            environmentId,
            lane,
          })),
      ),
    [laneRegistries],
  );

  const placed = useMemo<ReadonlyArray<PlacedThread>>(() => {
    void nowMinute;
    void snoozeWakeTick;
    const now = new Date().toISOString();
    return threads
      .filter((thread) => thread.archivedAt === null)
      .map<PlacedThread | null>((thread) => {
        const ref = scopeThreadRef(thread.environmentId, thread.id);
        const lanes = laneRegistries.get(thread.environmentId) ?? [];
        const placement = resolveBoardPlacement(thread, { now, autoSettleAfterDays, lanes });
        if (placement === null) return null;
        return {
          ref,
          key: scopedThreadKey(ref),
          thread,
          placement,
          lanes,
          projectTitle:
            projectTitleById.get(`${thread.environmentId}:${thread.projectId}`) ?? "Project",
        };
      })
      .filter((entry): entry is PlacedThread => entry !== null)
      .toSorted((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
  }, [autoSettleAfterDays, laneRegistries, nowMinute, projectTitleById, snoozeWakeTick, threads]);

  const byLane = useMemo(() => {
    const map = new Map<string, Array<PlacedThread>>();
    for (const column of boardLanes) map.set(column.key, []);
    for (const entry of placed) {
      if (entry.placement.lane === null || entry.placement.source === "attention") continue;
      map.get(laneColumnKey(entry.ref.environmentId, entry.placement.lane))?.push(entry);
    }
    return map;
  }, [boardLanes, placed]);

  const needsYou = useMemo(
    () => placed.filter((entry) => entry.placement.source === "attention"),
    [placed],
  );

  const sensors = useSensors(
    // Matches the sidebar's project-reorder sensor so a drag feels the same
    // everywhere in the app, and so a click on a card control is never
    // swallowed by an accidental drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // Pointer-only, with no nearest-target fallback. A board drop writes a
  // persisted session field, so "released somewhere that isn't a lane" must
  // mean *nothing happened* — snapping to the closest lane would silently
  // re-file a session because the user let go over a gutter or the header.
  const collisionDetection = useCallback<CollisionDetection>((args) => pointerWithin(args), []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingKey(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingKey(null);
      const { active, over } = event;
      if (!over) return;

      const entry = placed.find((candidate) => candidate.key === String(active.id));
      if (!entry) return;

      const target = boardLanes.find((column) => column.key === String(over.id));
      if (!target || target.environmentId !== entry.ref.environmentId) return;
      const targetLaneId = target.lane.id;

      // Drag/drop moves the *session-owned* field only. It never touches the
      // runtime attention that may currently be displacing the card, so
      // dropping a working session into "Ready" records the intent and the
      // card stays visibly held in "Active" until the run finishes.
      if (entry.placement.assignedLane === targetLaneId) return;

      void setWorkflowLane({
        environmentId: entry.ref.environmentId,
        input: { threadId: entry.ref.threadId, workflowLane: targetLaneId },
      });
    },
    [boardLanes, placed, setWorkflowLane],
  );

  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="text-sm font-medium">Session board</h1>
        <p className="hidden text-xs text-muted-foreground/70 sm:block">
          Every card is the live session itself. Drag to set its lane; a session that needs you
          moves itself until it doesn&apos;t.
        </p>
        <div className="ml-auto flex items-center gap-2">
          {focusedThreadKey !== null ? (
            <button
              type="button"
              onClick={clearFocus}
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              Collapse focused card
            </button>
          ) : null}
          <Link
            to="/"
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            Back to chat
          </Link>
        </div>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDraggingKey(null)}
      >
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {boardLanes.map((column) => (
            <LaneColumn
              key={column.key}
              droppableId={column.key}
              laneId={column.lane.id}
              label={column.lane.name}
              hint={column.lane.description}
              entries={byLane.get(column.key) ?? []}
              draggingKey={draggingKey}
            />
          ))}
          <LaneColumn
            droppableId={NEEDS_YOU_DROPPABLE_ID}
            laneId={NEEDS_YOU_LANE}
            label="Needs you"
            hint="Temporary attention grouping; P6b replaces this"
            entries={needsYou}
            draggingKey={draggingKey}
            droppable={false}
          />
        </div>
      </DndContext>
    </div>
  );
}

function LaneColumn({
  droppableId,
  laneId,
  label,
  hint,
  entries,
  draggingKey,
  droppable = true,
}: {
  readonly droppableId: string;
  readonly laneId: WorkflowLane;
  readonly label: string;
  readonly hint: string;
  readonly entries: ReadonlyArray<PlacedThread>;
  readonly draggingKey: string | null;
  readonly droppable?: boolean;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: droppableId, disabled: !droppable });

  return (
    <section
      ref={setNodeRef}
      data-lane={laneId}
      className={cn(
        "flex min-w-[212px] flex-1 basis-0 flex-col rounded-lg border border-border/70 bg-card/20",
        isOver && "border-primary/60 bg-accent/40",
      )}
    >
      <header className="shrink-0 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{label}</span>
          <span className="ml-auto text-[11px] text-muted-foreground/70">{entries.length}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground/60">{hint}</p>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {entries.map((entry) => (
          <BoardSessionCard
            key={entry.key}
            cardKey={entry.key}
            threadRef={entry.ref}
            thread={entry.thread}
            placement={entry.placement}
            lanes={entry.lanes}
            projectTitle={entry.projectTitle}
            isDragging={draggingKey === entry.key}
          />
        ))}
      </div>
    </section>
  );
}
