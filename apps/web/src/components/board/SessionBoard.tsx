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
  type EnvironmentId,
  type LaneDefinition,
  type ScopedThreadRef,
  type WorkflowLane,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  boardLaneCollapsedByDefault,
  isLifecycleBoardLane,
  resolveBoardLane,
  SETTLED_BOARD_LANE_ID,
  SNOOZED_BOARD_LANE_ID,
  type BoardLaneResolutionOptions,
} from "../../board/boardLanes.ts";
import { useThreadActions } from "../../hooks/useThreadActions.ts";
import { useNowMinute } from "../../hooks/useNowMinute.ts";
import {
  useLaneRegistries,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities.ts";
import { orchestrationEnvironment } from "../../state/orchestration.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import { useThreadChangeRequestStateStore } from "../../threadChangeRequestStateStore.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { resolveSnoozePresets } from "../Sidebar.snooze.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu.tsx";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { cn } from "~/lib/utils";
import { useClientSettings } from "~/hooks/useSettings";
import { BoardSessionCard } from "./BoardSessionCard.tsx";
import {
  applyProjectFilterToggle,
  boardProjectKey,
  buildProjectSwimlanes,
  groupEntriesByLane,
  isProjectFilterChecked,
  laneArchiveIntent,
  laneColumnKeyFromSwimlaneDroppable,
  laneIdForName,
  listProjectsWithSessions,
  nextLaneOrder,
  reorderLaneUpdates,
  shouldHideSwimlaneProjectHeader,
  swimlaneLaneDroppableId,
} from "./SessionBoard.logic.ts";

interface PlacedThread {
  readonly ref: ScopedThreadRef;
  readonly key: string;
  readonly thread: SidebarThreadSummary;
  readonly laneId: WorkflowLane | null;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly laneColumnKey: string;
  readonly updatedAt: string;
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
}

function laneColumnKey(environmentId: EnvironmentId, laneId: WorkflowLane): string {
  return JSON.stringify([environmentId, laneId]);
}

function laneColumnExpandKey(swimlaneProjectKey: string, laneColumnKeyValue: string): string {
  return `${swimlaneProjectKey}:${laneColumnKeyValue}`;
}

export function SessionBoard() {
  const threads = useThreadShells();
  const projects = useProjects();
  const laneRegistries = useLaneRegistries();
  const serverConfigs = useServerConfigs();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const nowMinute = useNowMinute();
  const changeRequestStateByKey = useThreadChangeRequestStateStore((state) => state.byThreadKey);
  const { settleThread, unsettleThread, snoozeThread, unsnoozeThread } = useThreadActions();
  const setWorkflowLane = useAtomCommand(threadEnvironment.setWorkflowLane, {
    reportFailure: false,
  });
  const createLane = useAtomCommand(orchestrationEnvironment.createLane);
  const updateLane = useAtomCommand(orchestrationEnvironment.updateLane);
  const archiveLane = useAtomCommand(orchestrationEnvironment.archiveLane);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [selectedProjectKeys, setSelectedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedLaneColumnKeys, setExpandedLaneColumnKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [snoozeWakeTick, setSnoozeWakeTick] = useState(0);

  const snoozeNow = useMemo(() => new Date().toISOString(), [nowMinute, snoozeWakeTick]);
  const settledNow = useMemo(() => `${nowMinute}:00.000Z`, [nowMinute]);

  const boardLaneBaseResolution = useMemo(
    (): Omit<BoardLaneResolutionOptions, "changeRequestState"> => ({
      now: snoozeNow,
      settledNow,
      autoSettleAfterDays,
    }),
    [autoSettleAfterDays, settledNow, snoozeNow],
  );

  const resolveThreadLane = useCallback(
    (thread: SidebarThreadSummary, lanes: ReadonlyArray<LaneDefinition>) => {
      const supportsSettlement =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
      const supportsSnooze =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return resolveBoardLane(thread, lanes, {
        ...boardLaneBaseResolution,
        supportsSettlement,
        supportsSnooze,
        changeRequestState: changeRequestStateByKey.get(threadKey) ?? null,
      });
    },
    [boardLaneBaseResolution, changeRequestStateByKey, serverConfigs],
  );

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

  const laneMemberCountByKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const lanes = laneRegistries.get(thread.environmentId) ?? [];
      const laneId = resolveThreadLane(thread, lanes);
      if (laneId === null) continue;
      const key = laneColumnKey(thread.environmentId, laneId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [laneRegistries, resolveThreadLane, threads]);

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
      if (intent.kind === "confirm" && !window.confirm(intent.explanation)) return false;
      const result = await archiveLane({ environmentId, input: { laneId } });
      return result._tag === "Success";
    },
    [archiveLane],
  );

  const placed = useMemo<ReadonlyArray<PlacedThread>>(() => {
    return threads
      .filter((thread) => thread.archivedAt === null)
      .map<PlacedThread | null>((thread) => {
        const ref = scopeThreadRef(thread.environmentId, thread.id);
        const key = scopedThreadKey(ref);
        const lanes = laneRegistries.get(thread.environmentId) ?? [];
        const laneId = resolveThreadLane(thread, lanes);
        if (laneId === null) return null;
        const columnKey = laneColumnKey(thread.environmentId, laneId);
        return {
          ref,
          key,
          thread,
          laneId,
          lanes,
          projectKey: boardProjectKey(thread.environmentId, thread.projectId),
          projectTitle:
            projectTitleById.get(`${thread.environmentId}:${thread.projectId}`) ?? "Project",
          laneColumnKey: columnKey,
          updatedAt: thread.updatedAt,
        };
      })
      .filter((entry): entry is PlacedThread => entry !== null)
      .toSorted((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
  }, [laneRegistries, projectTitleById, resolveThreadLane, threads]);

  const projectsWithSessions = useMemo(() => listProjectsWithSessions(placed), [placed]);

  const allProjectKeys = useMemo(
    () => new Set(projectsWithSessions.map((project) => project.projectKey)),
    [projectsWithSessions],
  );

  const swimlanes = useMemo(
    () => buildProjectSwimlanes(placed, selectedProjectKeys),
    [placed, selectedProjectKeys],
  );

  const hideSwimlaneProjectHeader = shouldHideSwimlaneProjectHeader(selectedProjectKeys);

  const projectFilterLabel = useMemo(() => {
    if (selectedProjectKeys.size === 0) return "All projects";
    if (selectedProjectKeys.size === 1) {
      const key = [...selectedProjectKeys][0];
      return (
        projectsWithSessions.find((project) => project.projectKey === key)?.projectTitle ??
        "1 project"
      );
    }
    return `${selectedProjectKeys.size} projects`;
  }, [projectsWithSessions, selectedProjectKeys]);

  const toggleProjectFilter = useCallback(
    (projectKey: string, checked: boolean) => {
      setSelectedProjectKeys((current) =>
        applyProjectFilterToggle(current, projectKey, checked, allProjectKeys),
      );
    },
    [allProjectKeys],
  );

  const toggleSwimlaneCollapsed = useCallback((projectKey: string) => {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  }, []);

  const toggleLaneColumnExpanded = useCallback((expandKey: string) => {
    setExpandedLaneColumnKeys((current) => {
      const next = new Set(current);
      if (next.has(expandKey)) next.delete(expandKey);
      else next.add(expandKey);
      return next;
    });
  }, []);

  const nextSnoozeWakeAtMs = useMemo(() => {
    let next = Number.NaN;
    for (const thread of threads) {
      if (thread.archivedAt !== null || thread.snoozedUntil == null) continue;
      const wake = Date.parse(thread.snoozedUntil);
      if (Number.isNaN(wake) || wake <= Date.now()) continue;
      if (Number.isNaN(next) || wake < next) next = wake;
    }
    return next;
  }, [snoozeWakeTick, threads]);

  useEffect(() => {
    if (Number.isNaN(nextSnoozeWakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, nextSnoozeWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => setSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [nextSnoozeWakeAtMs]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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

      const laneColumnKeyFromDrop = laneColumnKeyFromSwimlaneDroppable(String(over.id));
      if (laneColumnKeyFromDrop === null) return;

      const target = boardLanes.find((column) => column.key === laneColumnKeyFromDrop);
      if (!target || target.environmentId !== entry.ref.environmentId) return;
      const targetLaneId = target.lane.id;
      const sourceLaneId = entry.laneId;

      if (sourceLaneId === targetLaneId) {
        if (isLifecycleBoardLane(targetLaneId)) return;
        if (entry.thread.workflowLane === targetLaneId) return;
      }

      const applyDrop = async () => {
        const leavingSettled = sourceLaneId === SETTLED_BOARD_LANE_ID;
        const leavingSnoozed = sourceLaneId === SNOOZED_BOARD_LANE_ID;
        const enteringSettled = targetLaneId === SETTLED_BOARD_LANE_ID;
        const enteringSnoozed = targetLaneId === SNOOZED_BOARD_LANE_ID;

        if (leavingSettled) await unsettleThread(entry.ref);
        if (leavingSnoozed) await unsnoozeThread(entry.ref);

        if (enteringSettled) {
          await settleThread(entry.ref);
          return;
        }
        if (enteringSnoozed) {
          const preset = resolveSnoozePresets(new Date())[0];
          if (preset !== undefined) {
            await snoozeThread(entry.ref, preset.snoozedUntil);
          }
          return;
        }

        await setWorkflowLane({
          environmentId: entry.ref.environmentId,
          input: { threadId: entry.ref.threadId, workflowLane: targetLaneId },
        });
      };

      void applyDrop();
    },
    [
      boardLanes,
      placed,
      setWorkflowLane,
      settleThread,
      snoozeThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );

  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="text-sm font-medium">Session board</h1>
        <p className="hidden text-xs text-muted-foreground/70 sm:block">
          Every card is the live session itself. Drag to set its lane.
        </p>
        <div className="ml-auto flex items-center gap-2">
          {projectsWithSessions.length > 0 ? (
            <BoardProjectFilter
              label={projectFilterLabel}
              projects={projectsWithSessions}
              selectedProjectKeys={selectedProjectKeys}
              onToggle={toggleProjectFilter}
            />
          ) : null}
          {[...laneRegistries.entries()].map(([environmentId, lanes]) => (
            <NewLanePopover
              key={environmentId}
              environmentId={environmentId}
              lanes={lanes}
              showEnvironment={laneRegistries.size > 1}
              onCreate={handleCreateLane}
            />
          ))}
        </div>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDraggingKey(null)}
      >
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto p-3">
          <div className="flex min-w-max flex-col gap-4">
            {swimlanes.map((swimlane) => {
              const collapsed = collapsedProjectKeys.has(swimlane.projectKey);
              const bySwimlaneLane = groupEntriesByLane(
                swimlane.entries,
                boardLanes.map((column) => column.key),
              );

              return (
                <section key={swimlane.projectKey} className="flex flex-col gap-2">
                  {hideSwimlaneProjectHeader ? null : (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent/40"
                      onClick={() => toggleSwimlaneCollapsed(swimlane.projectKey)}
                    >
                      {collapsed ? (
                        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="text-xs font-medium">{swimlane.projectTitle}</span>
                      <span className="text-[11px] text-muted-foreground/70">
                        {swimlane.sessionCount}{" "}
                        {swimlane.sessionCount === 1 ? "session" : "sessions"}
                      </span>
                    </button>
                  )}
                  {collapsed && !hideSwimlaneProjectHeader ? null : (
                    <div className="flex flex-nowrap gap-3">
                      {boardLanes.map((column) => {
                        const expandKey = laneColumnExpandKey(swimlane.projectKey, column.key);
                        const collapsedByDefault = boardLaneCollapsedByDefault(column.lane.id);
                        const laneExpanded =
                          !collapsedByDefault || expandedLaneColumnKeys.has(expandKey);

                        return (
                          <LaneColumn
                            key={`${swimlane.projectKey}:${column.key}`}
                            droppableId={swimlaneLaneDroppableId(swimlane.projectKey, column.key)}
                            environmentId={column.environmentId}
                            lane={column.lane}
                            lanes={laneRegistries.get(column.environmentId) ?? []}
                            memberCount={laneMemberCountByKey.get(column.key) ?? 0}
                            entries={bySwimlaneLane.get(column.key) ?? []}
                            draggingKey={draggingKey}
                            cardsVisible={laneExpanded}
                            collapsedByDefault={collapsedByDefault}
                            onToggleExpanded={() => toggleLaneColumnExpanded(expandKey)}
                            onUpdate={handleUpdateLane}
                            onReorder={handleReorderLane}
                            onArchive={handleArchiveLane}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </DndContext>
    </div>
  );
}

function BoardProjectFilter({
  label,
  projects,
  selectedProjectKeys,
  onToggle,
}: {
  readonly label: string;
  readonly projects: ReadonlyArray<{ readonly projectKey: string; readonly projectTitle: string }>;
  readonly selectedProjectKeys: ReadonlySet<string>;
  readonly onToggle: (projectKey: string, checked: boolean) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" className="max-w-48" />}>
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-56">
        {projects.map((project) => (
          <MenuCheckboxItem
            key={project.projectKey}
            checked={isProjectFilterChecked(selectedProjectKeys, project.projectKey)}
            onCheckedChange={(checked) => onToggle(project.projectKey, checked === true)}
            closeOnClick={false}
          >
            {project.projectTitle}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
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

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setName("");
    setDescription("");
    setOrder(String(nextLaneOrder(lanes)));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericOrder = Number(order);
    if (name.trim() === "" || description.trim() === "" || !Number.isFinite(numericOrder)) return;
    const created = await onCreate(environmentId, lanes, {
      name: name.trim(),
      description: description.trim(),
      order: numericOrder,
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
            onNameChange={setName}
            onDescriptionChange={setDescription}
            onOrderChange={setOrder}
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
  const canMoveUp = reorderLaneUpdates(lanes, lane.id, "up").length > 0;
  const canMoveDown = reorderLaneUpdates(lanes, lane.id, "down").length > 0;

  useEffect(() => {
    setName(lane.name);
    setDescription(lane.description);
    setOrder(String(lane.order));
  }, [lane]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericOrder = Number(order);
    if (name.trim() === "" || description.trim() === "" || !Number.isFinite(numericOrder)) return;
    const updated = await onUpdate(environmentId, lane.id, {
      name: name.trim(),
      description: description.trim(),
      order: numericOrder,
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
            onNameChange={setName}
            onDescriptionChange={setDescription}
            onOrderChange={setOrder}
          />
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
          <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              size="xs"
              variant="destructive-outline"
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
  onNameChange,
  onDescriptionChange,
  onOrderChange,
}: {
  readonly name: string;
  readonly description: string;
  readonly order: string;
  readonly onNameChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onOrderChange: (value: string) => void;
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
          value={order}
          onChange={(event) => onOrderChange(event.target.value)}
        />
      </label>
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
  cardsVisible,
  collapsedByDefault,
  onToggleExpanded,
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
  readonly cardsVisible: boolean;
  readonly collapsedByDefault: boolean;
  readonly onToggleExpanded: () => void;
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
        "flex min-w-[380px] max-w-[380px] shrink-0 flex-col rounded-lg border border-border/70 bg-card/20",
        isOver && "border-primary/60 bg-accent/40",
      )}
    >
      <header className="shrink-0 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          {collapsedByDefault ? (
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-accent"
              onClick={onToggleExpanded}
              aria-expanded={cardsVisible}
            >
              {cardsVisible ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
              <span className="sr-only">
                {cardsVisible ? "Collapse" : "Expand"} {lane.name}
              </span>
            </button>
          ) : null}
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
      {cardsVisible ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {entries.map((entry) => (
            <BoardSessionCard
              key={entry.key}
              cardKey={entry.key}
              threadRef={entry.ref}
              thread={entry.thread}
              laneId={entry.laneId}
              lanes={entry.lanes}
              projectTitle={entry.projectTitle}
              isDragging={draggingKey === entry.key}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
