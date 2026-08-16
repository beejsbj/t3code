import type { Board3DCard } from "./layout.ts";

const LANES: ReadonlyArray<{ id: string; order: number }> = [
  { id: "triage", order: 0 },
  { id: "ready", order: 1 },
  { id: "in-progress", order: 2 },
  { id: "review", order: 3 },
  { id: "blocked", order: 4 },
];

const PROJECTS = ["t3code", "day-trading", "personal-site", "homelab"] as const;

const STATES: ReadonlyArray<Board3DCard["state"]> = [
  "working",
  "input",
  "approval",
  "failed",
  "idle",
  "draft",
  "snoozed",
  "settled",
];

const TITLES = [
  "Fix websocket reconnect storm",
  "Board card hover polish",
  "Migrate settings to schema v5",
  "Audit renderer memory churn",
  "Draft: mobile compose bar",
  "Investigate pairing token expiry",
  "Refactor checkpoint diff loader",
  "Tunnel latency regression",
  "Theme Clerk sign-in panel",
  "Keyboard nav for command palette",
  "Snooze wake boundary test",
  "Settle animation timing",
  "Provider adapter error surface",
  "Usage rate cache invalidation",
  "Sidebar teleport focus ring",
  "PR review bot dismissal flow",
  "Electron auto-updater delta",
  "Vite dev proxy websocket drop",
  "Mobile thread list virtualization",
  "Board lane width persistence",
];

/** Mulberry32 — tiny deterministic PRNG for reproducible synthetic boards. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a reproducible synthetic board for the 3D prototype. The same
 * seed always yields the same cards so spatial layout is stable across
 * reloads while we evaluate the feel of the space.
 */
export function generateSyntheticCards(count = 40, seed = 1337): Board3DCard[] {
  const rand = mulberry32(seed);
  const cards: Board3DCard[] = [];
  for (let i = 0; i < count; i += 1) {
    const lane = LANES[Math.floor(rand() * LANES.length)]!;
    const projectId = PROJECTS[Math.floor(rand() * PROJECTS.length)]!;
    // Bias toward the active rings so the near field feels populated.
    const stateRoll = rand();
    const state =
      stateRoll < 0.3
        ? "working"
        : stateRoll < 0.45
          ? "input"
          : stateRoll < 0.52
            ? "approval"
            : stateRoll < 0.6
              ? "failed"
              : stateRoll < 0.78
                ? "idle"
                : stateRoll < 0.84
                  ? "draft"
                  : stateRoll < 0.92
                    ? "snoozed"
                    : "settled";
    const title = TITLES[Math.floor(rand() * TITLES.length)]!;
    cards.push({
      id: "syn-" + i.toString(36).padStart(3, "0"),
      laneId: lane.id,
      laneOrder: lane.order,
      projectId,
      state,
      title,
      needsAttention: state === "input" || state === "approval" || state === "failed",
    });
  }
  return cards;
}

export const SYNTHETIC_LANES = LANES;
export const SYNTHETIC_PROJECTS = PROJECTS;
export const SYNTHETIC_STATES = STATES;
