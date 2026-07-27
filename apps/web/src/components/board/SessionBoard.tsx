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
import type { ScopedThreadRef, WorkflowLane } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  BOARD_LANES,
  isWorkflowLane,
  resolveBoardPlacement,
  type BoardPlacement,
} from "../../board/boardLanes.ts";
import { useBoardCardStore } from "../../board/boardCardStore.ts";
import { useProjects, useThreadShells } from "../../state/entities.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { cn } from "~/lib/utils";
import { BoardSessionCard } from "./BoardSessionCard.tsx";

const INBOX_DROPPABLE_ID = "board-inbox";

interface PlacedThread {
  readonly ref: ScopedThreadRef;
  readonly key: string;
  readonly thread: SidebarThreadSummary;
  readonly placement: BoardPlacement;
  readonly projectTitle: string;
}

export function SessionBoard() {
  const threads = useThreadShells();
  const projects = useProjects();
  const focusedThreadKey = useBoardCardStore((state) => state.focusedThreadKey);
  const clearFocus = useBoardCardStore((state) => state.clearFocus);
  const setWorkflowLane = useAtomCommand(threadEnvironment.setWorkflowLane, {
    reportFailure: false,
  });
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  const projectTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(`${project.environmentId}:${project.id}`, project.title);
    }
    return map;
  }, [projects]);

  const placed = useMemo<ReadonlyArray<PlacedThread>>(() => {
    return threads
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => {
        const ref = scopeThreadRef(thread.environmentId, thread.id);
        return {
          ref,
          key: scopedThreadKey(ref),
          thread,
          placement: resolveBoardPlacement(thread),
          projectTitle:
            projectTitleById.get(`${thread.environmentId}:${thread.projectId}`) ?? "Project",
        };
      })
      .toSorted((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
  }, [projectTitleById, threads]);

  const inbox = useMemo(() => placed.filter((entry) => entry.placement.lane === null), [placed]);
  const byLane = useMemo(() => {
    const map = new Map<WorkflowLane, Array<PlacedThread>>();
    for (const lane of BOARD_LANES) map.set(lane.id, []);
    for (const entry of placed) {
      if (entry.placement.lane === null) continue;
      map.get(entry.placement.lane)?.push(entry);
    }
    return map;
  }, [placed]);

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

      const overId = String(over.id);
      if (overId !== INBOX_DROPPABLE_ID && !isWorkflowLane(overId)) return;
      const nextLane: WorkflowLane | null = overId === INBOX_DROPPABLE_ID ? null : overId;

      // Drag/drop moves the *session-owned* field only. It never touches the
      // runtime attention that may currently be displacing the card, so
      // dropping a working session into "Ready" records the intent and the
      // card stays visibly held in "Active" until the run finishes.
      if (entry.placement.assignedLane === nextLane) return;

      void setWorkflowLane({
        environmentId: entry.ref.environmentId,
        input: { threadId: entry.ref.threadId, workflowLane: nextLane },
      });
    },
    [placed, setWorkflowLane],
  );

  return (
    <div className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
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
        <div className="flex min-h-0 flex-1">
          <InboxRail entries={inbox} draggingKey={draggingKey} />
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
            {BOARD_LANES.map((lane) => (
              <LaneColumn
                key={lane.id}
                laneId={lane.id}
                label={lane.label}
                hint={lane.hint}
                entries={byLane.get(lane.id) ?? []}
                draggingKey={draggingKey}
              />
            ))}
          </div>
        </div>
      </DndContext>
    </div>
  );
}

function InboxRail({
  entries,
  draggingKey,
}: {
  readonly entries: ReadonlyArray<PlacedThread>;
  readonly draggingKey: string | null;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: INBOX_DROPPABLE_ID });

  return (
    <aside
      ref={setNodeRef}
      className={cn(
        "flex w-[264px] shrink-0 flex-col border-r border-border bg-card/20",
        isOver && "bg-accent/40",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <InboxIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Inbox</span>
        <span className="ml-auto text-[11px] text-muted-foreground/70">{entries.length}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {entries.length === 0 ? (
          <p className="px-1 py-6 text-center text-[11px] text-muted-foreground/60">
            Every session has been placed. Drop one back here to unassign it.
          </p>
        ) : (
          entries.map((entry) => (
            <BoardSessionCard
              key={entry.key}
              cardKey={entry.key}
              threadRef={entry.ref}
              thread={entry.thread}
              placement={entry.placement}
              projectTitle={entry.projectTitle}
              isDragging={draggingKey === entry.key}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function LaneColumn({
  laneId,
  label,
  hint,
  entries,
  draggingKey,
}: {
  readonly laneId: WorkflowLane;
  readonly label: string;
  readonly hint: string;
  readonly entries: ReadonlyArray<PlacedThread>;
  readonly draggingKey: string | null;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: laneId });

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
            projectTitle={entry.projectTitle}
            isDragging={draggingKey === entry.key}
          />
        ))}
      </div>
    </section>
  );
}
