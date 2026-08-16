import { describe, expect, it } from "vite-plus/test";

import { layoutBoard3D } from "./layout";
import type { Board3DCard, Board3DCardState } from "./layout";

function card(overrides: Partial<Board3DCard> & { id: string }): Board3DCard {
  return {
    laneId: "lane-a",
    laneOrder: 0,
    projectId: "proj-0",
    state: "working",
    title: "T",
    needsAttention: false,
    ...overrides,
  };
}

/** Azimuth in degrees [0, 360), azimuth 0 facing -Z. */
function azimuthDeg(position: [number, number, number]): number {
  const [x, , z] = position;
  let deg = (Math.atan2(x, -z) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

function radialDistance(position: [number, number, number]): number {
  const [x, , z] = position;
  return Math.hypot(x, z);
}

describe("layoutBoard3D", () => {
  it("returns an empty layout for empty input", () => {
    expect(layoutBoard3D([])).toEqual([]);
  });

  it("is deterministic: same input yields identical output", () => {
    const cards = Array.from({ length: 40 }, (_, i) =>
      card({
        id: `card-${i}`,
        laneId: `lane-${i % 4}`,
        laneOrder: i % 4,
        projectId: `proj-${i % 3}`,
        state: (i % 2 === 0 ? "working" : "input") as Board3DCardState,
      }),
    );

    const first = layoutBoard3D(cards);
    const second = layoutBoard3D(cards);

    expect(second).toEqual(first);
    expect(first.map((t) => t.id)).toEqual(cards.map((c) => c.id));
  });

  it("keeps every occupied lane at least 24 degrees wide", () => {
    const laneCount = 8;
    const cards = Array.from({ length: laneCount }, (_, i) =>
      card({ id: `card-${i}`, laneId: `lane-${i}`, laneOrder: i }),
    );

    const out = layoutBoard3D(cards);
    const azimuths = out.map((t) => azimuthDeg(t.position));

    // Sectors tile in laneOrder order; each lane owns its own single-card cell,
    // so azimuths ascend in lane order and adjacent centers are >= 24 degrees apart.
    for (let i = 1; i < azimuths.length; i++) {
      expect(azimuths[i]! - azimuths[i - 1]!).toBeGreaterThanOrEqual(24);
    }
    // And the whole ring is covered once.
    expect(azimuths[azimuths.length - 1]! - azimuths[0]!).toBeLessThan(360);
  });

  it("places each state on its ring radius", () => {
    const states: Board3DCardState[] = [
      "working",
      "input",
      "approval",
      "idle",
      "failed",
      "draft",
      "snoozed",
      "settled",
    ];
    const expectedRadius: Record<Board3DCardState, number> = {
      working: 3,
      input: 4.5,
      approval: 4.5,
      idle: 6,
      failed: 6,
      draft: 3.5,
      snoozed: 9,
      settled: 12,
    };

    const cards = states.map((state) => card({ id: `c-${state}`, state }));
    const out = layoutBoard3D(cards);

    for (const t of out) {
      const state = t.id.replace("c-", "") as Board3DCardState;
      expect(radialDistance(t.position)).toBeCloseTo(expectedRadius[state], 5);
    }
  });

  it("assigns project strata by descending card count, alternating up and down", () => {
    const cards = [
      ...Array.from({ length: 4 }, (_, i) => card({ id: `big-${i}`, projectId: "big" })),
      ...Array.from({ length: 2 }, (_, i) => card({ id: `mid-${i}`, projectId: "mid" })),
      card({ id: "small-0", projectId: "small" }),
    ];

    const out = layoutBoard3D(cards);
    const yFor = (id: string) => out.find((t) => t.id === id)!.position[1];

    // Most-populated project at eye level; next two alternate up then down.
    expect(yFor("big-0")).toBeCloseTo(0, 5);
    expect(yFor("mid-0")).toBeCloseTo(1.6, 5);
    expect(yFor("small-0")).toBeCloseTo(-1.6, 5);
  });

  it("produces no duplicate positions", () => {
    const states: readonly Board3DCardState[] = [
      "working",
      "input",
      "approval",
      "idle",
      "failed",
      "draft",
      "snoozed",
      "settled",
    ];
    const cards = Array.from({ length: 120 }, (_, i) =>
      card({
        id: `card-${i}`,
        laneId: `lane-${i % 5}`,
        laneOrder: i % 5,
        projectId: `proj-${i % 4}`,
        state: states[i % states.length]!,
      }),
    );

    const out = layoutBoard3D(cards);
    const seen = new Set<string>();
    for (const t of out) {
      const key = t.position.map((v) => v.toFixed(9)).join(",");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(cards.length);
  });
});
