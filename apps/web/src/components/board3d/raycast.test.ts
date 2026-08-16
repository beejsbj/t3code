import { describe, expect, it } from "vite-plus/test";

import { ndcToWorldRay, pickCard, rayBillboard, type Ray } from "./raycast";

/** Camera at the origin, looking toward +Z, no pitch. */
const IDENTITY_CAMERA = { position: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0 };

const CENTER_RAY: Ray = { origin: [0, 0, 0], direction: [0, 0, 1] };

describe("ndcToWorldRay", () => {
  it("points straight ahead for the center of the screen", () => {
    const ray = ndcToWorldRay(0, 0, IDENTITY_CAMERA);
    expect(ray.origin).toEqual([0, 0, 0]);
    expect(ray.direction[0]).toBeCloseTo(0, 10);
    expect(ray.direction[1]).toBeCloseTo(0, 10);
    expect(ray.direction[2]).toBeCloseTo(1, 10);
  });

  it("returns a normalized direction", () => {
    const ray = ndcToWorldRay(1, 1, IDENTITY_CAMERA);
    const len = Math.hypot(ray.direction[0], ray.direction[1], ray.direction[2]);
    expect(len).toBeCloseTo(1, 10);
  });

  it("respects yaw and pitch", () => {
    const right = ndcToWorldRay(0, 0, {
      position: [0, 0, 0],
      yaw: Math.PI / 2,
      pitch: 0,
    });
    expect(right.direction[0]).toBeCloseTo(1, 10);
    expect(right.direction[2]).toBeCloseTo(0, 10);

    const up = ndcToWorldRay(0, 0, {
      position: [0, 0, 0],
      yaw: 0,
      pitch: Math.PI / 2,
    });
    expect(up.direction[0]).toBeCloseTo(0, 10);
    expect(up.direction[1]).toBeCloseTo(1, 10);
    expect(up.direction[2]).toBeCloseTo(0, 10);
  });

  it("keeps the ray origin at the camera position", () => {
    const ray = ndcToWorldRay(-1, -1, {
      position: [2, 3, 4],
      yaw: 0,
      pitch: 0,
    });
    expect(ray.origin).toEqual([2, 3, 4]);
  });
});

describe("rayBillboard", () => {
  it("hits a card directly ahead of the camera", () => {
    const dist = rayBillboard(CENTER_RAY, [0, 0, 5], [0, 0, 0]);
    expect(dist).toBeCloseTo(5, 10);
  });

  it("misses a card off to the side beyond the half-width", () => {
    // Card centered 1m right of the ray; default width 1.4 => half-width 0.7.
    expect(rayBillboard(CENTER_RAY, [1, 0, 5], [0, 0, 0])).toBeNull();
  });

  it("hits just inside the half-extent boundary", () => {
    // Card centered just inside the half-width (0.7) catches the ray. The
    // billboard tilts toward the camera at this offset, so the ray travels
    // slightly farther than the card's z distance before meeting the plane.
    const dist = rayBillboard(CENTER_RAY, [0.6, 0, 5], [0, 0, 0]);
    expect(dist).not.toBeNull();
    expect(dist!).toBeCloseTo(5.1, 1);
  });

  it("misses just outside the half-extent boundary", () => {
    expect(rayBillboard(CENTER_RAY, [0.8, 0, 5], [0, 0, 0])).toBeNull();
  });

  it("misses beyond the half-height", () => {
    // Default height 0.9 => half-height 0.45.
    expect(rayBillboard(CENTER_RAY, [0, 0.5, 5], [0, 0, 0])).toBeNull();
  });

  it("never hits a card behind the camera", () => {
    expect(rayBillboard(CENTER_RAY, [0, 0, -5], [0, 0, 0])).toBeNull();
  });

  it("respects an explicit size override", () => {
    // Wide card (width 4) should catch a ray the default 1.4m card would miss.
    const dist = rayBillboard(CENTER_RAY, [1, 0, 5], [0, 0, 0], 4, 0.9);
    expect(dist).toBeCloseTo(5.2, 10);
  });
});

describe("pickCard", () => {
  it("returns null when no card is hit", () => {
    expect(pickCard(CENTER_RAY, [{ id: "a", position: [0, 0, -5] }], [0, 0, 0])).toBeNull();
  });

  it("returns the nearest of two collinear cards", () => {
    const cards = [
      { id: "far", position: [0, 0, 7] as [number, number, number] },
      { id: "near", position: [0, 0, 3] as [number, number, number] },
    ];
    expect(pickCard(CENTER_RAY, cards, [0, 0, 0])).toBe("near");
  });

  it("ignores cards behind the camera", () => {
    const cards = [
      { id: "behind", position: [0, 0, -3] as [number, number, number] },
      { id: "ahead", position: [0, 0, 4] as [number, number, number] },
    ];
    expect(pickCard(CENTER_RAY, cards, [0, 0, 0])).toBe("ahead");
  });
});
