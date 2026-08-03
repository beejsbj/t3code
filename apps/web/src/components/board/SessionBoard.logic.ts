import { LaneId, type LaneDefinition } from "@t3tools/contracts";

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
