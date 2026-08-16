/**
 * Pure spatial layout for the 3D board prototype.
 *
 * Maps board cards into world-space transforms. The same input always yields
 * the same layout: all grouping, ordering, and jitter are derived from the
 * input data alone (no `Math.random`). One world unit is one meter; azimuth 0
 * faces -Z.
 */

export type Board3DCardState =
  | "working"
  | "input"
  | "approval"
  | "failed"
  | "idle"
  | "draft"
  | "snoozed"
  | "settled";

/** A single board card as seen by the 3D layout. */
export interface Board3DCard {
  id: string;
  laneId: string;
  laneOrder: number;
  projectId: string;
  state: Board3DCardState;
  title: string;
  needsAttention: boolean;
}

/** World-space placement of one card, in meters. */
export interface CardTransform {
  id: string;
  position: [number, number, number];
}

const STATE_RADIUS_METERS: Record<Board3DCardState, number> = {
  working: 3,
  input: 4.5,
  approval: 4.5,
  idle: 6,
  failed: 6,
  draft: 3.5,
  snoozed: 9,
  settled: 12,
};

const MIN_LANE_SECTOR_DEGREES = 24;
const STRATUM_SPACING_METERS = 1.6;
const FULL_CIRCLE_DEGREES = 360;
const JITTER_AMPLITUDE_FRACTION = 0.35;
const JITTER_AMPLITUDE_MAX_RADIANS = 0.08;

const DEG_TO_RAD = Math.PI / 180;

/** FNV-1a 32-bit hash, used only for deterministic jitter. */
function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Hash of a string mapped into the half-open unit range [0, 1). */
function hashUnit(input: string): number {
  return hashString(input) / Math.pow(2, 32);
}

interface LaneAggregate {
  laneId: string;
  laneOrder: number;
  count: number;
}

interface LaneSector {
  laneId: string;
  start: number;
  end: number;
}

/** Group cards by lane, ordered by laneOrder (ties broken by laneId). */
function aggregateLanes(cards: readonly Board3DCard[]): LaneAggregate[] {
  const byLane = new Map<string, LaneAggregate>();
  for (const card of cards) {
    const existing = byLane.get(card.laneId);
    if (existing) {
      existing.count += 1;
    } else {
      byLane.set(card.laneId, {
        laneId: card.laneId,
        laneOrder: card.laneOrder,
        count: 1,
      });
    }
  }
  const lanes = [...byLane.values()];
  lanes.sort(
    (a, b) => a.laneOrder - b.laneOrder || (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0),
  );
  return lanes;
}

/**
 * Angular width (degrees) per lane. Width is proportional to card count with a
 * 24-degree minimum per occupied lane; sectors tile the full 360 degrees.
 * When the minimums alone exceed 360 (e.g. more than 15 lanes) the circle is
 * divided evenly so the sectors always tile.
 */
function laneSectorWidthsDegrees(lanes: readonly LaneAggregate[]): number[] {
  const occupied = lanes.length;
  if (occupied === 0) return [];
  const minTotal = occupied * MIN_LANE_SECTOR_DEGREES;
  if (minTotal >= FULL_CIRCLE_DEGREES) {
    const each = FULL_CIRCLE_DEGREES / occupied;
    return lanes.map(() => each);
  }
  const remaining = FULL_CIRCLE_DEGREES - minTotal;
  const totalCount = lanes.reduce((sum, lane) => sum + lane.count, 0);
  return lanes.map((lane) => MIN_LANE_SECTOR_DEGREES + (remaining * lane.count) / totalCount);
}

/**
 * One stratum per project, ordered by card count descending (ties by
 * projectId). Most-populated at eye level (y=0), then alternating +1.6,
 * -1.6, +3.2, -3.2 meters. Returns a map of projectId -> elevation.
 */
function projectStrata(cards: readonly Board3DCard[]): Map<string, number> {
  const countByProject = new Map<string, number>();
  for (const card of cards) {
    countByProject.set(card.projectId, (countByProject.get(card.projectId) ?? 0) + 1);
  }
  const projects = [...countByProject.keys()];
  projects.sort((a, b) => {
    const diff = (countByProject.get(b) ?? 0) - (countByProject.get(a) ?? 0);
    return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
  });
  const yByProject = new Map<string, number>();
  projects.forEach((projectId, index) => {
    yByProject.set(projectId, stratumY(index));
  });
  return yByProject;
}

function stratumY(index: number): number {
  if (index === 0) return 0;
  if (index % 2 === 1) return STRATUM_SPACING_METERS * ((index + 1) / 2);
  return -STRATUM_SPACING_METERS * (index / 2);
}

function cellKey(projectId: string, state: Board3DCardState): string {
  return `${projectId}\u0000${state}`;
}

/**
 * Assign each card an azimuth (radians) inside its lane sector. Within a lane
 * the (project x state) cells subdivide the sector proportionally to card
 * count; cards spread across their cell with small deterministic jitter
 * hashed from the card id.
 */
function planCardAzimuths(
  cards: readonly Board3DCard[],
  sectors: readonly LaneSector[],
): Map<string, number> {
  const azimuthByCard = new Map<string, number>();
  const cardsByLane = new Map<string, Board3DCard[]>();
  for (const card of cards) {
    const list = cardsByLane.get(card.laneId);
    if (list) list.push(card);
    else cardsByLane.set(card.laneId, [card]);
  }

  for (const sector of sectors) {
    const laneCards = cardsByLane.get(sector.laneId);
    if (!laneCards || laneCards.length === 0) continue;

    const cells = new Map<string, Board3DCard[]>();
    for (const card of laneCards) {
      const key = cellKey(card.projectId, card.state);
      const list = cells.get(key);
      if (list) list.push(card);
      else cells.set(key, [card]);
    }

    const cellKeys = [...cells.keys()].sort();
    const sectorSpan = sector.end - sector.start;
    const total = laneCards.length;
    let cellStart = sector.start;

    for (const key of cellKeys) {
      const cellCards = cells.get(key)!;
      const m = cellCards.length;
      const span = (sectorSpan * m) / total;
      const cellEnd = cellStart + span;
      const spacing = span / m;
      const amplitude = Math.min(spacing * JITTER_AMPLITUDE_FRACTION, JITTER_AMPLITUDE_MAX_RADIANS);

      for (let j = 0; j < m; j++) {
        const card = cellCards[j]!;
        const base = cellStart + span * ((j + 0.5) / m);
        const jitter = (hashUnit(card.id) * 2 - 1) * amplitude;
        const angle = Math.min(cellEnd, Math.max(cellStart, base + jitter));
        azimuthByCard.set(card.id, angle);
      }

      cellStart = cellEnd;
    }
  }

  return azimuthByCard;
}

/**
 * Lay a set of board cards out in world space.
 *
 * Azimuth maps to workflow lanes (sectors tiling 360 degrees, azimuth 0 faces
 * -Z), elevation maps to projects (one stratum each, most-populated at eye
 * level, alternating up/down), and radius maps to state rings. Output order
 * matches input order, and the layout is deterministic: identical input
 * always produces identical transforms.
 *
 * @param cards - the cards to lay out; empty input yields an empty layout.
 * @returns one transform per card, in input order.
 */
export function layoutBoard3D(cards: readonly Board3DCard[]): readonly CardTransform[] {
  if (cards.length === 0) return [];

  const lanes = aggregateLanes(cards);
  const widthsDegrees = laneSectorWidthsDegrees(lanes);

  const sectors: LaneSector[] = [];
  let angleDegrees = 0;
  for (let i = 0; i < lanes.length; i++) {
    const start = angleDegrees * DEG_TO_RAD;
    angleDegrees += widthsDegrees[i]!;
    sectors.push({ laneId: lanes[i]!.laneId, start, end: angleDegrees * DEG_TO_RAD });
  }

  const azimuthByCard = planCardAzimuths(cards, sectors);
  const yByProject = projectStrata(cards);

  return cards.map((card) => {
    const angle = azimuthByCard.get(card.id)!;
    const radius = STATE_RADIUS_METERS[card.state];
    const y = yByProject.get(card.projectId)!;
    // Azimuth 0 faces -Z.
    const x = radius * Math.sin(angle);
    const z = -radius * Math.cos(angle);
    return { id: card.id, position: [x, y, z] };
  });
}
