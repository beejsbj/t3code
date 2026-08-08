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
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { useBoardFocusStore } from "../../board/boardFocusStore.ts";
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
import { selectProjectGroupingSettings } from "../../logicalProject.ts";
import { ensureLocalApi } from "../../localApi.ts";
import { useProjectScopeStore } from "../../projectScopeStore.ts";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping.ts";
import { usePrimaryEnvironmentId } from "../../state/environments.ts";
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
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover.tsx";
import { SidebarInset } from "../ui/sidebar.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { cn } from "~/lib/utils";
import { useClientSettings } from "~/hooks/useSettings";
import { BoardSessionCard } from "./BoardSessionCard.tsx";
import {
  boardLaneGridTemplateColumns,
  boardLaneHeaderDroppableId,
  boardProjectKey,
  buildProjectSwimlanes,
  groupEntriesByLane,
  laneArchiveIntent,
  laneIdForName,
  nextLaneOrder,
  reorderLaneUpdates,
  resolveBoardLaneDrop,
  resolveBoardFocusAction,
  shouldHideSwimlaneProjectHeader,
  swimlaneColumnDroppableId,
} from "./SessionBoard.logic.ts";

/** Group bands stick directly under the lane header row. */
const BOARD_HEADER_HEIGHT = "3.25rem";
/** The rule that makes a lane read as one column down the whole scroll. */
const BOARD_COLUMN_RULE_CLASS = "border-l border-border/40 first:border-l-0";

interface PlacedThread {
  readonly ref: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
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

function findCardNode(scroller: HTMLElement | null, threadKey: string): HTMLElement | null {
  // Matched by dataset rather than an attribute selector: thread keys are
  // `environmentId:threadId` and are not guaranteed selector-safe.
  for (const node of scroller?.querySelectorAll<HTMLElement>("[data-board-card-key]") ?? []) {
    if (node.dataset.boardCardKey === threadKey) return node;
  }
  return null;
}

export function SessionBoard() {
  const threads = useThreadShells();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const laneRegistries = useLaneRegistries();
  const serverConfigs = useServerConfigs();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectScopeKey = useProjectScopeStore((state) => state.projectScopeKey);
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

  const projectGroupByPhysicalKey = useMemo(() => {
    const groups = buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const map = new Map<string, { readonly projectKey: string; readonly projectTitle: string }>();
    for (const group of groups) {
      for (const projectRef of group.memberProjectRefs) {
        map.set(boardProjectKey(projectRef.environmentId, projectRef.projectId), {
          projectKey: group.projectKey,
          projectTitle: group.displayName,
        });
      }
    }
    return map;
  }, [primaryEnvironmentId, projectGroupingSettings, projects]);

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

  const boardGridTemplateColumns = useMemo(
    () =>
      boardLaneGridTemplateColumns(
        boardLanes.map((column) => ({ key: column.key, laneId: column.lane.id })),
        expandedLaneColumnKeys,
      ),
    [boardLanes, expandedLaneColumnKeys],
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
      const result = await updateLane({
        environmentId,
        input: { laneId, ...draft },
      });
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
      if (
        intent.kind === "confirm" &&
        !(await ensureLocalApi().dialogs.confirm(intent.explanation))
      ) {
        return false;
      }
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
        const physicalProjectKey = boardProjectKey(thread.environmentId, thread.projectId);
        const projectGroup = projectGroupByPhysicalKey.get(physicalProjectKey);
        return {
          ref,
          environmentId: thread.environmentId,
          key,
          thread,
          laneId,
          lanes,
          projectKey: projectGroup?.projectKey ?? physicalProjectKey,
          projectTitle:
            projectGroup?.projectTitle ?? projectTitleById.get(physicalProjectKey) ?? "Project",
          laneColumnKey: columnKey,
          updatedAt: thread.updatedAt,
        };
      })
      .filter((entry): entry is PlacedThread => entry !== null)
      .toSorted((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
  }, [laneRegistries, projectGroupByPhysicalKey, projectTitleById, resolveThreadLane, threads]);

  const swimlanes = useMemo(
    () => buildProjectSwimlanes(placed, projectScopeKey),
    [placed, projectScopeKey],
  );

  const hideSwimlaneProjectHeader = shouldHideSwimlaneProjectHeader(projectScopeKey);

  const toggleSwimlaneCollapsed = useCallback((projectKey: string) => {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  }, []);

  const toggleLaneColumnExpanded = useCallback((laneColumnKeyValue: string) => {
    setExpandedLaneColumnKeys((current) => {
      const next = new Set(current);
      if (next.has(laneColumnKeyValue)) next.delete(laneColumnKeyValue);
      else next.add(laneColumnKeyValue);
      return next;
    });
  }, []);

  // Focus requests come from the sidebar, which cannot see this viewport. The
  // board answers them: scroll the card into view, or open it when it is
  // already on screen (the second click on a row you just jumped to).
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const focusRequest = useBoardFocusStore((state) => state.request);
  const setFocusedThreadKey = useBoardFocusStore((state) => state.setFocused);
  const setExpandedThreadKey = useBoardFocusStore((state) => state.setExpanded);
  const placedRef = useRef(placed);
  placedRef.current = placed;

  useEffect(() => {
    if (focusRequest === null) return;
    const entry = placedRef.current.find((candidate) => candidate.key === focusRequest.threadKey);
    // A session that is not on the board (archived mid-click) has nothing to
    // focus; leaving the request unanswered is better than a blind scroll.
    if (entry === undefined) return;

    const scroller = scrollerRef.current;
    const node = findCardNode(scroller, entry.key);
    const action = resolveBoardFocusAction({
      card: node?.getBoundingClientRect() ?? null,
      viewport: scroller?.getBoundingClientRect() ?? { top: 0, bottom: 0, left: 0, right: 0 },
      forceOpen: focusRequest.open,
    });

    setFocusedThreadKey(entry.key);

    // The card can be hidden rather than merely off screen — behind a collapsed
    // group or lane. Undo whichever applies either way: an opened card still
    // has to exist behind its sheet.
    setCollapsedProjectKeys((current) => {
      if (!current.has(entry.projectKey)) return current;
      const next = new Set(current);
      next.delete(entry.projectKey);
      return next;
    });
    setExpandedLaneColumnKeys((current) => {
      if (entry.laneId === null || !boardLaneCollapsedByDefault(entry.laneId)) return current;
      if (current.has(entry.laneColumnKey)) return current;
      return new Set(current).add(entry.laneColumnKey);
    });

    if (action === "open") {
      setExpandedThreadKey(entry.key);
      return;
    }

    // Scroll only once the reveal above has laid out.
    const frame = requestAnimationFrame(() => {
      findCardNode(scrollerRef.current, entry.key)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, setExpandedThreadKey, setFocusedThreadKey]);

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

      const drop = resolveBoardLaneDrop({
        activeId: String(active.id),
        overId: String(over.id),
        entries: placed,
        columns: boardLanes,
      });
      if (drop === null) return;
      const { entry, target } = drop;
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
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="text-sm font-medium">Session board</h1>
        <p className="hidden text-xs text-muted-foreground/70 sm:block">
          Every card is the live session itself. Drag to set its lane.
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
        </div>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDraggingKey(null)}
      >
        {/*
          One board, not one per project. The lane header row and every group's
          cells share a single column grid, so a lane reads as one continuous
          column all the way down and project grouping is only a divider across
          it — the Linear scroll, rather than stacked mini-boards.
        */}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
          <div className="w-max min-w-full">
            <div
              className="sticky top-0 z-20 grid border-b border-border bg-background"
              style={{
                gridTemplateColumns: boardGridTemplateColumns,
                height: BOARD_HEADER_HEIGHT,
              }}
            >
              {boardLanes.map((column) => (
                <LaneHeaderCell
                  key={column.key}
                  droppableId={boardLaneHeaderDroppableId(column.key)}
                  environmentId={column.environmentId}
                  lane={column.lane}
                  lanes={laneRegistries.get(column.environmentId) ?? []}
                  memberCount={laneMemberCountByKey.get(column.key) ?? 0}
                  cardsVisible={
                    !boardLaneCollapsedByDefault(column.lane.id) ||
                    expandedLaneColumnKeys.has(column.key)
                  }
                  collapsedByDefault={boardLaneCollapsedByDefault(column.lane.id)}
                  onToggleExpanded={() => toggleLaneColumnExpanded(column.key)}
                  onUpdate={handleUpdateLane}
                  onReorder={handleReorderLane}
                  onArchive={handleArchiveLane}
                />
              ))}
            </div>

            {swimlanes.map((swimlane) => {
              const collapsed = collapsedProjectKeys.has(swimlane.projectKey);
              const bySwimlaneLaneColumn = groupEntriesByLane(
                swimlane.entries,
                boardLanes.map((column) => column.key),
              );

              return (
                <Fragment key={swimlane.projectKey}>
                  {hideSwimlaneProjectHeader ? null : (
                    <button
                      type="button"
                      // Opaque, not translucent: it sticks over live cards, and
                      // a blurred strip would repaint them on every scroll tick.
                      className="sticky z-10 flex w-full items-center gap-2 border-b border-border/50 bg-muted px-3 py-1.5 text-left hover:bg-accent"
                      style={{ top: BOARD_HEADER_HEIGHT }}
                      onClick={() => toggleSwimlaneCollapsed(swimlane.projectKey)}
                    >
                      {collapsed ? (
                        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="text-xs font-medium">{swimlane.projectTitle}</span>
                      <span className="text-[11px] text-muted-foreground/70">
                        {swimlane.sessionCount}{" "}
                        {swimlane.sessionCount === 1 ? "session" : "sessions"}
                      </span>
                    </button>
                  )}
                  {collapsed && !hideSwimlaneProjectHeader ? null : (
                    <div
                      className="grid"
                      style={{
                        gridTemplateColumns: boardGridTemplateColumns,
                      }}
                    >
                      {boardLanes.map((column) => (
                        <LaneDropCell
                          key={`${swimlane.projectKey}:${column.key}`}
                          droppableId={swimlaneColumnDroppableId(swimlane.projectKey, column.key)}
                          lane={column.lane}
                          entries={bySwimlaneLaneColumn.get(column.key) ?? []}
                          draggingKey={draggingKey}
                          cardsVisible={
                            !boardLaneCollapsedByDefault(column.lane.id) ||
                            expandedLaneColumnKeys.has(column.key)
                          }
                        />
                      ))}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      </DndContext>
    </SidebarInset>
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
        render={<Button size="icon-xs" variant="ghost" aria-label={`Manage ${lane.name} lane`} />}
      >
        <EllipsisIcon className="size-3.5" />
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

/**
 * The single header for a lane. There is one per lane for the whole board, not
 * one per project group, so the count it shows is the lane's total and the
 * collapse it offers applies to the column everywhere it appears.
 */
function LaneHeaderCell({
  droppableId,
  environmentId,
  lane,
  lanes,
  memberCount,
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
  const lifecycleLane = isLifecycleBoardLane(lane.id);
  const snoozedLane = lane.id === SNOOZED_BOARD_LANE_ID;

  return (
    <div
      ref={setNodeRef}
      data-lane={lane.id}
      className={cn(
        "flex min-w-0 flex-col justify-center px-3 py-2",
        BOARD_COLUMN_RULE_CLASS,
        // Settled and Snoozed are lifecycle terminals, not workflow stages.
        lifecycleLane && "bg-muted/35",
        snoozedLane && "bg-blue-500/5 dark:bg-blue-400/10",
        lifecycleLane && !cardsVisible && "px-2",
        isOver && "bg-accent/40",
      )}
    >
      <div className={cn("flex items-center", cardsVisible ? "gap-2" : "gap-1")}>
        {collapsedByDefault ? (
          <button
            type="button"
            className={cn(
              "rounded p-0.5 text-muted-foreground hover:bg-accent",
              snoozedLane && "text-blue-600 dark:text-blue-400",
            )}
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
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs font-medium",
            lifecycleLane && "text-muted-foreground/60",
            snoozedLane && "text-blue-600 dark:text-blue-400",
            !cardsVisible && "text-[11px]",
          )}
          title={lane.name}
        >
          {lane.name}
        </span>
        <span
          className={cn(
            "ml-auto text-[11px] text-muted-foreground/70",
            snoozedLane && "text-blue-600/80 dark:text-blue-400/80",
          )}
        >
          {memberCount}
        </span>
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
      {cardsVisible ? (
        <p className="truncate text-[11px] text-muted-foreground/60" title={lane.description}>
          {lane.description}
        </p>
      ) : null}
    </div>
  );
}

/** One lane's slice of one project group: the drop target and its cards. */
function LaneDropCell({
  droppableId,
  lane,
  entries,
  draggingKey,
  cardsVisible,
}: {
  readonly droppableId: string;
  readonly lane: LaneDefinition;
  readonly entries: ReadonlyArray<PlacedThread>;
  readonly draggingKey: string | null;
  readonly cardsVisible: boolean;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: droppableId });
  const lifecycleLane = isLifecycleBoardLane(lane.id);
  const snoozedLane = lane.id === SNOOZED_BOARD_LANE_ID;

  return (
    // Not a bounded scroll region: this cell sits in a content-sized grid row
    // inside the board's own scroller, so it never receives a height shorter
    // than its content.
    <div
      ref={setNodeRef}
      data-lane={lane.id}
      className={cn(
        "min-h-16 min-w-0 space-y-2 p-2",
        BOARD_COLUMN_RULE_CLASS,
        lifecycleLane && "bg-muted/35",
        snoozedLane && "bg-blue-500/5 dark:bg-blue-400/10",
        lifecycleLane && !cardsVisible && "p-0",
        isOver && "bg-accent/40",
      )}
    >
      {cardsVisible
        ? entries.map((entry) => (
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
          ))
        : null}
    </div>
  );
}
