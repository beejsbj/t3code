/**
 * HUD for the Board Palace prototype. All DOM, no canvas: the lane compass
 * band across the top tracks your yaw, the project gauge on the right tracks
 * elevation, attention dots pin to the screen edge in the direction of
 * off-screen cards that need you, and a card list at the left acts as the
 * teleport "sidebar".
 */

import { useMemo } from "react";

import type { Board3DCard } from "./layout.ts";
import type { CardTransform } from "./layout.ts";

interface Board3DHudProps {
  cards: readonly Board3DCard[];
  lanes: ReadonlyArray<{ id: string; order: number }>;
  transforms: readonly CardTransform[];
  yaw: number;
  pitch: number;
  hoveredId: string | null;
  onTeleport: (id: string) => void;
}

const STATE_COLORS: Record<Board3DCard["state"], string> = {
  working: "#4c8dff",
  input: "#ffb224",
  approval: "#a06bff",
  failed: "#ff5c5c",
  idle: "#3a3b42",
  draft: "#2dd4bf",
  snoozed: "#64748b",
  settled: "#2a2b30",
};

const LANE_LABELS: Record<string, string> = {
  triage: "Triage",
  ready: "Ready",
  "in-progress": "In Progress",
  review: "Review",
  blocked: "Blocked",
};

function normalizeAngle(rad: number): number {
  let a = rad % (Math.PI * 2);
  if (a < -Math.PI) a += Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  return a;
}

export function Board3DHud({
  cards,
  lanes,
  transforms,
  yaw,
  pitch,
  hoveredId,
  onTeleport,
}: Board3DHudProps): React.JSX.Element {
  const transformById = useMemo(() => new Map(transforms.map((t) => [t.id, t])), [transforms]);

  // Lane sectors for the compass: midpoint azimuth per lane derived from the
  // same ordering the layout uses, so the band matches the space.
  const laneTicks = useMemo(() => {
    const occupied = lanes.filter((lane) => cards.some((c) => c.laneId === lane.id));
    const count = occupied.length;
    if (count === 0) return [];
    // Sectors tile 360 degrees evenly across occupied lanes (matches the
    // visual rhythm; exact proportional widths live in layout.ts).
    return occupied.map((lane, i) => ({
      id: lane.id,
      label: LANE_LABELS[lane.id] ?? lane.id,
      azimuth: (i / count) * Math.PI * 2,
    }));
  }, [lanes, cards]);

  // Camera yaw=0 faces -Z; azimuth 0 in layout faces -Z too, so compass
  // offset = normalize(laneAzimuth - yawAzimuthOfCamera).
  const cameraAzimuth = Math.atan2(-Math.sin(yaw), -Math.cos(yaw));

  const projects = useMemo(() => [...new Set(cards.map((c) => c.projectId))], [cards]);

  const attentionCards = cards.filter((c) => c.needsAttention);

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-sans">
      {/* Lane compass band */}
      <div className="absolute inset-x-0 top-3 flex justify-center">
        <div className="relative h-8 w-[480px] overflow-hidden rounded-full bg-black/50 backdrop-blur-sm">
          <div className="absolute inset-y-0 left-1/2 w-px bg-white/70" />
          {laneTicks.map((tick) => {
            const rel = normalizeAngle(tick.azimuth - cameraAzimuth + Math.PI);
            const x = 50 + (rel / Math.PI) * 50; // percent; band shows +-180deg
            if (x < 2 || x > 98) return null;
            return (
              <div
                key={tick.id}
                className="absolute top-0 flex h-full -translate-x-1/2 flex-col items-center justify-start"
                style={{ left: `${x}%` }}
              >
                <div className="h-1.5 w-px bg-white/50" />
                <span className="mt-0.5 text-[10px] tracking-wide text-white/75">{tick.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Project gauge */}
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col items-end gap-1">
        {projects.map((p) => {
          const count = cards.filter((c) => c.projectId === p).length;
          return (
            <div
              key={p}
              className="rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/70 backdrop-blur-sm"
            >
              {p} · {count}
            </div>
          );
        })}
        <div className="mt-1 text-[9px] uppercase tracking-widest text-white/40">
          pitch {(pitch * (180 / Math.PI)).toFixed(0)}°
        </div>
      </div>

      {/* Attention edge dots */}
      {attentionCards.map((card) => {
        const t = transformById.get(card.id);
        if (!t) return null;
        const az = Math.atan2(t.position[0], -t.position[2]);
        const rel = normalizeAngle(az - cameraAzimuth + Math.PI);
        // Only draw edge dots for cards outside a comfortable central view.
        if (Math.abs(rel) < 0.6) return null;
        const x = 50 + Math.sign(rel) * 46;
        const y = 50 - Math.max(-30, Math.min(30, (t.position[1] / 6) * 50));
        return (
          <div
            key={card.id}
            className="absolute h-2 w-2 rounded-full"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              backgroundColor: STATE_COLORS[card.state],
              boxShadow: `0 0 8px ${STATE_COLORS[card.state]}`,
            }}
            title={card.title}
          />
        );
      })}

      {/* Teleport list (prototype sidebar) */}
      <div className="pointer-events-auto absolute left-3 top-1/2 max-h-[60vh] w-52 -translate-y-1/2 space-y-0.5 overflow-y-auto rounded-lg bg-black/50 p-2 backdrop-blur-sm">
        <div className="mb-1 px-1 text-[9px] uppercase tracking-widest text-white/40">teleport</div>
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onTeleport(card.id)}
            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-white/75 hover:bg-white/10 ${hoveredId === card.id ? "bg-white/15" : ""}`}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: STATE_COLORS[card.state] }}
            />
            <span className="truncate">{card.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
