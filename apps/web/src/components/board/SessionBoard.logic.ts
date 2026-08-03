import { LaneId, type LaneDefinition } from "@t3tools/contracts";

export function boardProjectKey(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

export interface BoardThreadPlacement {
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly laneColumnKey: string;
  readonly updatedAt: string;
}

export interface ProjectSwimlane<T extends BoardThreadPlacement> {
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly sessionCount: number;
  readonly entries: ReadonlyArray<T>;
}

export interface ProjectWithSessions {
  readonly projectKey: string;
  readonly projectTitle: string;
}

export function groupEntriesByLane<T extends BoardThreadPlacement>(
  entries: ReadonlyArray<T>,
  laneColumnKeys: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const map = new Map<string, Array<T>>();
  for (const key of laneColumnKeys) map.set(key, []);
  for (const entry of entries) {
    map.get(entry.laneColumnKey)?.push(entry);
  }
  return map;
}

export function buildProjectSwimlanes<T extends BoardThreadPlacement>(
  entries: ReadonlyArray<T>,
  selectedProjectKeys: ReadonlySet<string>,
): ReadonlyArray<ProjectSwimlane<T>> {
  const filtered =
    selectedProjectKeys.size === 0
      ? entries
      : entries.filter((entry) => selectedProjectKeys.has(entry.projectKey));

  const byProject = new Map<string, Array<T>>();
  for (const entry of filtered) {
    const list = byProject.get(entry.projectKey) ?? [];
    list.push(entry);
    byProject.set(entry.projectKey, list);
  }

  const swimlanes: Array<ProjectSwimlane<T>> = [];
  for (const [projectKey, projectEntries] of byProject) {
    const projectTitle = projectEntries[0]?.projectTitle ?? "Project";
    swimlanes.push({
      projectKey,
      projectTitle,
      sessionCount: projectEntries.length,
      entries: projectEntries,
    });
  }

  return swimlanes.toSorted((left, right) => {
    const leftNewest = left.entries.reduce(
      (newest, entry) => (entry.updatedAt > newest ? entry.updatedAt : newest),
      "",
    );
    const rightNewest = right.entries.reduce(
      (newest, entry) => (entry.updatedAt > newest ? entry.updatedAt : newest),
      "",
    );
    return rightNewest.localeCompare(leftNewest);
  });
}

export function listProjectsWithSessions<T extends BoardThreadPlacement>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<ProjectWithSessions> {
  const byKey = new Map<string, string>();
  for (const entry of entries) {
    if (!byKey.has(entry.projectKey)) {
      byKey.set(entry.projectKey, entry.projectTitle);
    }
  }
  return [...byKey.entries()]
    .map(([projectKey, projectTitle]) => ({ projectKey, projectTitle }))
    .toSorted((left, right) => left.projectTitle.localeCompare(right.projectTitle));
}

export function isProjectFilterChecked(
  selectedProjectKeys: ReadonlySet<string>,
  projectKey: string,
): boolean {
  return selectedProjectKeys.size === 0 || selectedProjectKeys.has(projectKey);
}

export function applyProjectFilterToggle(
  selectedProjectKeys: ReadonlySet<string>,
  projectKey: string,
  checked: boolean,
  allProjectKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const effectiveSelected =
    selectedProjectKeys.size === 0 ? new Set(allProjectKeys) : new Set(selectedProjectKeys);

  if (checked) {
    effectiveSelected.add(projectKey);
  } else {
    effectiveSelected.delete(projectKey);
  }

  if (effectiveSelected.size === 0 || effectiveSelected.size === allProjectKeys.size) {
    return new Set();
  }
  return effectiveSelected;
}

export function shouldHideSwimlaneProjectHeader(selectedProjectKeys: ReadonlySet<string>): boolean {
  return selectedProjectKeys.size === 1;
}

export function swimlaneLaneDroppableId(projectKey: string, laneColumnKey: string): string {
  return JSON.stringify(["board-swimlane", projectKey, laneColumnKey]);
}

export function laneColumnKeyFromSwimlaneDroppable(droppableId: string): string | null {
  try {
    const parsed: unknown = JSON.parse(droppableId);
    if (
      Array.isArray(parsed) &&
      parsed[0] === "board-swimlane" &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string"
    ) {
      return parsed[2];
    }
  } catch {
    return null;
  }
  return null;
}

export type LaneArchiveIntent =
  | { readonly kind: "archive" }
  | { readonly kind: "confirm"; readonly memberCount: number; readonly explanation: string };

export function laneIdForName(
  name: string,
  lanes: ReadonlyArray<LaneDefinition>,
): LaneDefinition["id"] {
  const base =
    name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lane";
  const existingIds = new Set(lanes.map((lane) => lane.id));
  if (!existingIds.has(LaneId.make(base))) return LaneId.make(base);

  let suffix = 2;
  while (existingIds.has(LaneId.make(`${base}-${suffix}`))) suffix += 1;
  return LaneId.make(`${base}-${suffix}`);
}

export function nextLaneOrder(lanes: ReadonlyArray<LaneDefinition>): number {
  return lanes.length === 0 ? 0 : Math.max(...lanes.map((lane) => lane.order)) + 1;
}

export function reorderLaneUpdates(
  lanes: ReadonlyArray<LaneDefinition>,
  laneId: LaneDefinition["id"],
  direction: "up" | "down",
): ReadonlyArray<{ readonly laneId: LaneDefinition["id"]; readonly order: number }> {
  const ordered = lanes.toSorted(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  const laneIndex = ordered.findIndex((lane) => lane.id === laneId);
  const neighbourIndex = laneIndex + (direction === "up" ? -1 : 1);
  const lane = ordered[laneIndex];
  const neighbour = ordered[neighbourIndex];
  if (lane === undefined || neighbour === undefined) return [];
  return [
    { laneId: lane.id, order: neighbour.order },
    { laneId: neighbour.id, order: lane.order },
  ];
}

export function laneArchiveIntent(
  _laneId: LaneDefinition["id"],
  memberCount: number,
): LaneArchiveIntent {
  if (memberCount > 0) {
    return {
      kind: "confirm",
      memberCount,
      explanation: `Archive this lane? Its ${memberCount} ${memberCount === 1 ? "session" : "sessions"} will become unplaced and keep a lane removed note.`,
    };
  }
  return { kind: "archive" };
}
