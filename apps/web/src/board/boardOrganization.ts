import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { resolveThreadRuntimeState } from "../state/threadRuntimeState.ts";

export type BoardStateId = "draft" | "approval" | "input" | "failed" | "working" | "idle";

export interface BoardStateDescriptor {
  readonly id: BoardStateId;
  readonly label: string;
  readonly order: number;
}

export const BOARD_STATE_BY_ID = Object.freeze({
  draft: { id: "draft", label: "Draft", order: 0 },
  approval: { id: "approval", label: "Approval", order: 1 },
  input: { id: "input", label: "Input", order: 2 },
  failed: { id: "failed", label: "Failed", order: 3 },
  working: { id: "working", label: "Working", order: 4 },
  idle: { id: "idle", label: "Idle", order: 5 },
} satisfies Record<BoardStateId, BoardStateDescriptor>);

/** Stable presentation order shared by state columns and state rows. */
export const BOARD_STATES: ReadonlyArray<BoardStateDescriptor> = Object.freeze(
  Object.values(BOARD_STATE_BY_ID).toSorted((left, right) => left.order - right.order),
);

/**
 * The lifecycle projection is resolved separately because it needs the
 * board's wall clock, server capabilities, and change-request state.
 */
export type BoardThreadLifecycle = "visible" | "archived" | "snoozed" | "settled";

/**
 * Projects a server thread into one mutually-exclusive board presentation
 * state. This deliberately ignores per-client read state: completed and
 * acknowledged turns both rest in Idle.
 */
export function resolveBoardThreadState(
  thread: OrchestrationThreadShell,
  lifecycle: BoardThreadLifecycle,
): BoardStateId | null {
  if (lifecycle !== "visible") return null;

  const runtime = resolveThreadRuntimeState(thread);
  switch (runtime) {
    case "plan-ready":
      return "input";
    case "connecting":
    case "monitoring":
      return "working";
    default:
      return runtime;
  }
}

export type BoardFlatAttentionState = BoardStateId | "done" | "woke";

export function resolveBoardFlatAttentionState(input: {
  readonly boardStateId: BoardStateId;
  readonly hasUnseenCompletion: boolean;
  readonly isWoke: boolean;
}): BoardFlatAttentionState {
  if (
    input.boardStateId === "working" ||
    input.boardStateId === "approval" ||
    input.boardStateId === "input" ||
    input.boardStateId === "failed"
  ) {
    return input.boardStateId;
  }
  if (input.isWoke) return "woke";
  if (input.hasUnseenCompletion) return "done";
  return input.boardStateId;
}

export interface BoardFlatOrderedEntry {
  readonly key: string;
  readonly attentionState: BoardFlatAttentionState;
  readonly attentionAt: string;
}

const BOARD_FLAT_ATTENTION_TIER = Object.freeze({
  approval: 0,
  input: 0,
  failed: 0,
  done: 1,
  woke: 2,
  draft: 3,
  idle: 3,
  working: 4,
} satisfies Record<BoardFlatAttentionState, number>);

function compareFlatAttention(left: BoardFlatOrderedEntry, right: BoardFlatOrderedEntry): number {
  return (
    BOARD_FLAT_ATTENTION_TIER[left.attentionState] -
      BOARD_FLAT_ATTENTION_TIER[right.attentionState] ||
    right.attentionAt.localeCompare(left.attentionAt) ||
    left.key.localeCompare(right.key)
  );
}

/**
 * Orders the flat board as an attention queue until the user establishes a
 * global card sequence. New cards still surface ahead of the first manually
 * placed card in a lower-priority tier without disturbing that sequence.
 */
export function orderFlatBoardEntries<T extends BoardFlatOrderedEntry>(
  entries: ReadonlyArray<T>,
  flatOrder: ReadonlyArray<string>,
): ReadonlyArray<T> {
  const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const seenListedKeys = new Set<string>();
  const listed = flatOrder.flatMap((key) => {
    const entry = entryByKey.get(key);
    if (entry === undefined || seenListedKeys.has(key)) return [];
    seenListedKeys.add(key);
    return [entry];
  });
  const listedKeys = new Set(listed.map((entry) => entry.key));
  const unlisted = entries
    .filter((entry) => !listedKeys.has(entry.key))
    .toSorted(compareFlatAttention);

  if (listed.length === 0) return unlisted;

  const insertions = Array.from({ length: listed.length + 1 }, () => [] as T[]);
  for (const entry of unlisted) {
    const tier = BOARD_FLAT_ATTENTION_TIER[entry.attentionState];
    const beforeIndex = listed.findIndex(
      (listedEntry) => BOARD_FLAT_ATTENTION_TIER[listedEntry.attentionState] > tier,
    );
    insertions[beforeIndex === -1 ? listed.length : beforeIndex]?.push(entry);
  }

  return listed
    .flatMap((entry, index) => [...(insertions[index] ?? []), entry])
    .concat(insertions[listed.length] ?? []);
}

export type BoardOrganizationDimension = "workflow" | "state" | "project";
export type BoardRowGrouping = "none" | Extract<BoardOrganizationDimension, "state" | "project">;

/** Dimension qualification keeps identical project, lane, and state ids distinct. */
export function boardDimensionKey(dimension: BoardOrganizationDimension, value: string): string {
  return JSON.stringify(["board-dimension", dimension, value]);
}

export function boardStateDimensionKey(stateId: BoardStateId): string {
  return boardDimensionKey("state", stateId);
}

export function boardProjectDimensionKey(projectKey: string): string {
  return boardDimensionKey("project", projectKey);
}

export function boardWorkflowDimensionKey(laneId: string): string {
  return boardDimensionKey("workflow", laneId);
}

export interface BoardOrganizationEntry {
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly boardStateId: BoardStateId;
}

export interface BoardRow<T extends BoardOrganizationEntry> {
  readonly key: string;
  readonly grouping: BoardRowGrouping;
  readonly value: string;
  readonly label: string;
  readonly entryCount: number;
  readonly entries: ReadonlyArray<T>;
}

export const BOARD_UNGROUPED_ROW_KEY = JSON.stringify(["board-row", "none", "all"]);

/**
 * Applies project scope before grouping, then builds deterministic rows for
 * the chosen presentation dimension. State rows follow BOARD_STATES rather
 * than first-seen thread order.
 */
export function buildBoardRows<T extends BoardOrganizationEntry>(
  entries: ReadonlyArray<T>,
  grouping: BoardRowGrouping,
  projectScopeKey: string | null,
): ReadonlyArray<BoardRow<T>> {
  const scopedEntries =
    projectScopeKey === null
      ? entries
      : entries.filter((entry) => entry.projectKey === projectScopeKey);

  if (grouping === "none") {
    return [
      {
        key: BOARD_UNGROUPED_ROW_KEY,
        grouping,
        value: "all",
        label: "All",
        entryCount: scopedEntries.length,
        entries: scopedEntries,
      },
    ];
  }

  if (grouping === "state") {
    const byState = new Map<BoardStateId, Array<T>>();
    for (const entry of scopedEntries) {
      const stateEntries = byState.get(entry.boardStateId) ?? [];
      stateEntries.push(entry);
      byState.set(entry.boardStateId, stateEntries);
    }
    // State is a spatial map, so empty rows remain mounted. A row disappearing
    // when its last card moves would make every state below it jump.
    return BOARD_STATES.map((state) => {
      const stateEntries = byState.get(state.id) ?? [];
      return {
        key: boardStateDimensionKey(state.id),
        grouping,
        value: state.id,
        label: state.label,
        entryCount: stateEntries.length,
        entries: stateEntries,
      };
    });
  }

  const byProject = new Map<string, Array<T>>();
  for (const entry of scopedEntries) {
    const projectEntries = byProject.get(entry.projectKey) ?? [];
    projectEntries.push(entry);
    byProject.set(entry.projectKey, projectEntries);
  }
  return [...byProject.entries()]
    .map(([projectKey, projectEntries]) => ({
      key: boardProjectDimensionKey(projectKey),
      grouping,
      value: projectKey,
      label: projectEntries[0]?.projectTitle ?? "Project",
      entryCount: projectEntries.length,
      entries: projectEntries,
    }))
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label, undefined, { sensitivity: "base", numeric: true }) ||
        left.value.localeCompare(right.value),
    );
}
