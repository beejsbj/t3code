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
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { resolveBoardPlacement, type BoardPlacement } from "../../board/boardLanes.ts";
import { useBoardCardStore } from "../../board/boardCardStore.ts";
import { useNowMinute } from "../../hooks/useNowMinute.ts";
import { useClientSettings } from "../../hooks/useSettings.ts";
import { useLaneRegistries, useProjects, useThreadShells } from "../../state/entities.ts";
import { orchestrationEnvironment } from "../../state/orchestration.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import { useThreadChangeRequestStateStore } from "../../threadChangeRequestStateStore.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover.tsx";
import { Switch } from "../ui/switch.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { cn } from "~/lib/utils";
import { BoardSessionCard } from "./BoardSessionCard.tsx";
import {
  laneArchiveIntent,
  laneIdForName,
  nextLaneOrder,
  reorderLaneUpdates,
} from "./SessionBoard.logic.ts";

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

interface LaneDraft {
  readonly name: string;
  readonly description: string;
  readonly order: number;
  readonly interrupt: "move" | "badge";
}

const DONE_LANE = LaneId.make("done");
const DEFAULT_DONE_LANE: LaneDefinition = {
  id: DONE_LANE,
  name: "Done",
  description: "Settled sessions drain here",
  order: Number.MAX_SAFE_INTEGER,
  interrupt: "move",
};

function laneColumnKey(environmentId: EnvironmentId, laneId: WorkflowLane): string {
  return JSON.stringify([environmentId, laneId]);
}

export function SessionBoard() {
  const threads = useThreadShells();
  const projects = useProjects();
  const laneRegistries = useLaneRegistries();
  const changeRequestStateByThreadKey = useThreadChangeRequestStateStore(
    (state) => state.byThreadKey,
  );
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const nowMinute = useNowMinute();
  const focusedThreadKey = useBoardCardStore((state) => state.focusedThreadKey);
  const clearFocus = useBoardCardStore((state) => state.clearFocus);
  const setWorkflowLane = useAtomCommand(threadEnvironment.setWorkflowLane, {
    reportFailure: false,
  });
  const createLane = useAtomCommand(orchestrationEnvironment.createLane);
  const updateLane = useAtomCommand(orchestrationEnvironment.updateLane);
  const archiveLane = useAtomCommand(orchestrationEnvironment.archiveLane);
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
      [...laneRegistries.entries()].flatMap(([environmentId, lanes]) => {
        const orderedIntentLanes = lanes
          .filter((lane) => lane.id !== DONE_LANE)
          .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));
        const doneLane = lanes.find((lane) => lane.id === DONE_LANE) ?? DEFAULT_DONE_LANE;
        return [...orderedIntentLanes, doneLane].map((lane) => ({
          key: laneColumnKey(environmentId, lane.id),
          environmentId,
          lane,
        }));
      }),
    [laneRegistries],
  );

  const laneMemberCountByKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      if (thread.workflowLane == null) continue;
      const key = laneColumnKey(thread.environmentId, thread.workflowLane);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads]);

  const handleCreateLane = useCallback(
    async (
      environmentId: EnvironmentId,
      lanes: ReadonlyArray<LaneDefinition>,
      draft: LaneDraft,
    ) => {
      const result = await createLane({
        environmentId,
        input: { lane: { id: laneIdForName(draft.name, lanes), ...draft } },
      });
      return result._tag === "Success";
    },
    [createLane],
  );

  const handleUpdateLane = useCallback(
    async (environmentId: EnvironmentId, laneId: LaneDefinition["id"], draft: LaneDraft) => {
      const result = await updateLane({ environmentId, input: { laneId, ...draft } });
      return result._tag === "Success";
    },
    [updateLane],
  );

  const handleReorderLane = useCallback(
    async (
      environmentId: EnvironmentId,
      lanes: ReadonlyArray<LaneDefinition>,
      laneId: LaneDefinition["id"],
      direction: "up" | "down",
    ) => {
      for (const input of reorderLaneUpdates(lanes, laneId, direction)) {
        await updateLane({ environmentId, input });
      }
    },
    [updateLane],
  );

  const handleArchiveLane = useCallback(
    async (environmentId: EnvironmentId, laneId: LaneDefinition["id"], memberCount: number) => {
      const intent = laneArchiveIntent(laneId, memberCount);
      if (intent.kind === "blocked") return false;
      if (intent.kind === "confirm" && !window.confirm(intent.explanation)) return false;
      const result = await archiveLane({ environmentId, input: { laneId } });
      return result._tag === "Success";
    },
    [archiveLane],
  );

  const placed = useMemo<ReadonlyArray<PlacedThread>>(() => {
    void nowMinute;
    void snoozeWakeTick;
    const now = new Date().toISOString();
    return threads
      .filter((thread) => thread.archivedAt === null)
      .map<PlacedThread | null>((thread) => {
        const ref = scopeThreadRef(thread.environmentId, thread.id);
        const key = scopedThreadKey(ref);
        const lanes = laneRegistries.get(thread.environmentId) ?? [];
        const placement = resolveBoardPlacement(thread, {
          now,
          autoSettleAfterDays,
          changeRequestState: changeRequestStateByThreadKey.get(key) ?? null,
          lanes,
        });
        if (placement === null) return null;
        return {
          ref,
          key,
          thread,
          placement,
          lanes,
          projectTitle:
            projectTitleById.get(`${thread.environmentId}:${thread.projectId}`) ?? "Project",
        };
      })
      .filter((entry): entry is PlacedThread => entry !== null)
      .toSorted((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
  }, [
    autoSettleAfterDays,
    changeRequestStateByThreadKey,
    laneRegistries,
    nowMinute,
    projectTitleById,
    snoozeWakeTick,
    threads,
  ]);

  const byLane = useMemo(() => {
    const map = new Map<string, Array<PlacedThread>>();
    for (const column of boardLanes) map.set(column.key, []);
    for (const entry of placed) {
      if (entry.placement.lane === null || entry.placement.inNeedsYouRail) continue;
      map.get(laneColumnKey(entry.ref.environmentId, entry.placement.lane))?.push(entry);
    }
    return map;
  }, [boardLanes, placed]);

  const needsYou = useMemo(
    () => placed.filter((entry) => entry.placement.inNeedsYouRail),
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
      // card remains there with live working chrome until the run finishes.
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
          {[...laneRegistries.entries()].map(([environmentId, lanes]) => (
            <NewLanePopover
              key={environmentId}
              environmentId={environmentId}
              lanes={lanes}
              showEnvironment={laneRegistries.size > 1}
              onCreate={handleCreateLane}
            />
          ))}
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
          <NeedsYouRail entries={needsYou} draggingKey={draggingKey} />
          {boardLanes.map((column) => (
            <LaneColumn
              key={column.key}
              droppableId={column.key}
              environmentId={column.environmentId}
              lane={column.lane}
              lanes={laneRegistries.get(column.environmentId) ?? []}
              memberCount={laneMemberCountByKey.get(column.key) ?? 0}
              entries={byLane.get(column.key) ?? []}
              draggingKey={draggingKey}
              onUpdate={handleUpdateLane}
              onReorder={handleReorderLane}
              onArchive={handleArchiveLane}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}

function NewLanePopover({
  environmentId,
  lanes,
  showEnvironment,
  onCreate,
}: {
  readonly environmentId: EnvironmentId;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly showEnvironment: boolean;
  readonly onCreate: (
    environmentId: EnvironmentId,
    lanes: ReadonlyArray<LaneDefinition>,
    draft: LaneDraft,
  ) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [order, setOrder] = useState(() => String(nextLaneOrder(lanes)));
  const [interrupt, setInterrupt] = useState<"move" | "badge">("move");

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setName("");
    setDescription("");
    setOrder(String(nextLaneOrder(lanes)));
    setInterrupt("move");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericOrder = Number(order);
    if (name.trim() === "" || description.trim() === "" || !Number.isFinite(numericOrder)) return;
    const created = await onCreate(environmentId, lanes, {
      name: name.trim(),
      description: description.trim(),
      order: numericOrder,
      interrupt,
    });
    if (created) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={<Button size="xs" variant="outline" />}>
        New lane{showEnvironment ? ` · ${environmentId}` : ""}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80">
        <form className="space-y-3" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-1">
            <PopoverTitle className="text-sm">Create lane</PopoverTitle>
            <PopoverDescription className="text-xs">
              Add an intent column to this board.
            </PopoverDescription>
          </div>
          <LaneFields
            name={name}
            description={description}
            order={order}
            interrupt={interrupt}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            onOrderChange={setOrder}
            onInterruptChange={setInterrupt}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs">
              Create lane
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function LaneEditorPopover({
  environmentId,
  lane,
  lanes,
  memberCount,
  onUpdate,
  onReorder,
  onArchive,
}: {
  readonly environmentId: EnvironmentId;
  readonly lane: LaneDefinition;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly memberCount: number;
  readonly onUpdate: (
    environmentId: EnvironmentId,
    laneId: LaneDefinition["id"],
    draft: LaneDraft,
  ) => Promise<boolean>;
  readonly onReorder: (
    environmentId: EnvironmentId,
    lanes: ReadonlyArray<LaneDefinition>,
    laneId: LaneDefinition["id"],
    direction: "up" | "down",
  ) => Promise<void>;
  readonly onArchive: (
    environmentId: EnvironmentId,
    laneId: LaneDefinition["id"],
    memberCount: number,
  ) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(lane.name);
  const [description, setDescription] = useState(lane.description);
  const [order, setOrder] = useState(String(lane.order));
  const [interrupt, setInterrupt] = useState<"move" | "badge">(lane.interrupt);
  const isDone = lane.id === DONE_LANE;
  const archiveIntent = laneArchiveIntent(lane.id, memberCount);
  const canMoveUp = reorderLaneUpdates(lanes, lane.id, "up").length > 0;
  const canMoveDown = reorderLaneUpdates(lanes, lane.id, "down").length > 0;

  useEffect(() => {
    setName(lane.name);
    setDescription(lane.description);
    setOrder(String(lane.order));
    setInterrupt(lane.interrupt);
  }, [lane]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericOrder = isDone ? lane.order : Number(order);
    if (name.trim() === "" || description.trim() === "" || !Number.isFinite(numericOrder)) return;
    const updated = await onUpdate(environmentId, lane.id, {
      name: name.trim(),
      description: description.trim(),
      order: numericOrder,
      interrupt: isDone ? "move" : interrupt,
    });
    if (updated) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button type="button" className="rounded px-1 text-muted-foreground hover:bg-accent" />
        }
      >
        <span aria-hidden>•••</span>
        <span className="sr-only">Manage {lane.name} lane</span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <form className="space-y-3" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-1">
            <PopoverTitle className="text-sm">Manage lane</PopoverTitle>
            <PopoverDescription className="text-xs">Lane id: {lane.id}</PopoverDescription>
          </div>
          <LaneFields
            name={name}
            description={description}
            order={order}
            interrupt={isDone ? "move" : interrupt}
            orderDisabled={isDone}
            interruptDisabled={isDone}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            onOrderChange={setOrder}
            onInterruptChange={setInterrupt}
          />
          {isDone ? (
            <p className="rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
              {archiveIntent.kind === "blocked" ? archiveIntent.explanation : null}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Move column</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!canMoveUp}
                onClick={() => void onReorder(environmentId, lanes, lane.id, "up")}
              >
                Left
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!canMoveDown}
                onClick={() => void onReorder(environmentId, lanes, lane.id, "down")}
              >
                Right
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              size="xs"
              variant="destructive-outline"
              disabled={isDone}
              onClick={async () => {
                if (await onArchive(environmentId, lane.id, memberCount)) setOpen(false);
              }}
            >
              Archive lane
            </Button>
            <Button type="submit" size="xs">
              Save changes
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function LaneFields({
  name,
  description,
  order,
  interrupt,
  orderDisabled = false,
  interruptDisabled = false,
  onNameChange,
  onDescriptionChange,
  onOrderChange,
  onInterruptChange,
}: {
  readonly name: string;
  readonly description: string;
  readonly order: string;
  readonly interrupt: "move" | "badge";
  readonly orderDisabled?: boolean;
  readonly interruptDisabled?: boolean;
  readonly onNameChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onOrderChange: (value: string) => void;
  readonly onInterruptChange: (value: "move" | "badge") => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Name</span>
        <Input required value={name} onChange={(event) => onNameChange(event.target.value)} />
      </label>
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Description</span>
        <Textarea
          required
          size="sm"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
        <span className="block text-[11px] text-muted-foreground">
          Agents will use this description to understand where work belongs.
        </span>
      </label>
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Order</span>
        <Input
          nativeInput
          required
          type="number"
          step="any"
          disabled={orderDisabled}
          value={order}
          onChange={(event) => onOrderChange(event.target.value)}
        />
      </label>
      <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-2">
        <div>
          <p className="text-xs font-medium">Keep attention in this lane</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Keep cards here when they need you — for lanes you&apos;re already watching.
          </p>
        </div>
        <Switch
          aria-label="Keep cards in this lane when they need you"
          checked={interrupt === "badge"}
          disabled={interruptDisabled}
          onCheckedChange={(checked) => onInterruptChange(checked ? "badge" : "move")}
        />
      </div>
    </div>
  );
}

function LaneColumn({
  droppableId,
  environmentId,
  lane,
  lanes,
  memberCount,
  entries,
  draggingKey,
  onUpdate,
  onReorder,
  onArchive,
}: {
  readonly droppableId: string;
  readonly environmentId: EnvironmentId;
  readonly lane: LaneDefinition;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly memberCount: number;
  readonly entries: ReadonlyArray<PlacedThread>;
  readonly draggingKey: string | null;
  readonly onUpdate: (
    environmentId: EnvironmentId,
    laneId: LaneDefinition["id"],
    draft: LaneDraft,
  ) => Promise<boolean>;
  readonly onReorder: (
    environmentId: EnvironmentId,
    lanes: ReadonlyArray<LaneDefinition>,
    laneId: LaneDefinition["id"],
    direction: "up" | "down",
  ) => Promise<void>;
  readonly onArchive: (
    environmentId: EnvironmentId,
    laneId: LaneDefinition["id"],
    memberCount: number,
  ) => Promise<boolean>;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: droppableId });

  return (
    <section
      ref={setNodeRef}
      data-lane={lane.id}
      className={cn(
        "flex min-w-[212px] flex-1 basis-0 flex-col rounded-lg border border-border/70 bg-card/20",
        isOver && "border-primary/60 bg-accent/40",
      )}
    >
      <header className="shrink-0 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{lane.name}</span>
          <span className="ml-auto text-[11px] text-muted-foreground/70">{entries.length}</span>
          <LaneEditorPopover
            environmentId={environmentId}
            lane={lane}
            lanes={lanes}
            memberCount={memberCount}
            onUpdate={onUpdate}
            onReorder={onReorder}
            onArchive={onArchive}
          />
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground/60">{lane.description}</p>
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

function NeedsYouRail({
  entries,
  draggingKey,
}: {
  readonly entries: ReadonlyArray<PlacedThread>;
  readonly draggingKey: string | null;
}) {
  return (
    <section
      data-board-rail="needs-you"
      className="flex min-w-[232px] flex-1 basis-0 flex-col rounded-lg border border-slate-400/40 bg-slate-500/10 shadow-inner dark:border-slate-500/40 dark:bg-slate-400/[0.06]"
    >
      <header className="shrink-0 border-b border-slate-400/30 bg-slate-500/10 px-3 py-2 dark:border-slate-500/30 dark:bg-slate-400/[0.05]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">Needs you</span>
          <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
            {entries.length}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-500/90 dark:text-slate-400">
          Live attention, placed by the system
        </p>
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
