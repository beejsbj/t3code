import { describe, expect, it } from "vite-plus/test";

import { applyLook, createCamera, flyTo, tickCamera, viewMatrix } from "./camera";

const REST = { forward: 0, strafe: 0, vertical: 0, sprint: false };

function speedOf(cam: { velocity: [number, number, number] }): number {
  return Math.hypot(cam.velocity[0], cam.velocity[1], cam.velocity[2]);
}

describe("createCamera", () => {
  it("starts at eye height looking down -Z and at rest", () => {
    const cam = createCamera();
    expect(cam.position).toEqual([0, 1.6, 0]);
    expect(cam.yaw).toBe(0);
    expect(cam.pitch).toBe(0);
    expect(cam.velocity).toEqual([0, 0, 0]);
  });

  it("default view matrix looks down -Z (right-handed, y up)", () => {
    const m = viewMatrix(createCamera());
    expect(m).toHaveLength(16);
    // Forward (view direction) basis vector is (0, 0, -1).
    expect(m[8]).toBeCloseTo(0);
    expect(m[9]).toBeCloseTo(0);
    expect(m[10]).toBeCloseTo(-1);
    // Right basis is +X.
    expect(m[0]).toBeCloseTo(1);
    // Up basis is +Y.
    expect(m[5]).toBeCloseTo(1);
    // Translation maps eye position (0,1.6,0) into camera space.
    expect(m[12]).toBeCloseTo(0);
    expect(m[13]).toBeCloseTo(-1.6);
    expect(m[14]).toBeCloseTo(0);
  });
});

describe("applyLook", () => {
  it("clamps pitch to +-85 degrees", () => {
    const lookingUp = applyLook(createCamera(), 0, -1e6);
    expect(lookingUp.pitch).toBeCloseTo((85 * Math.PI) / 180, 6);

    const lookingDown = applyLook(createCamera(), 0, 1e6);
    expect(lookingDown.pitch).toBeCloseTo(-(85 * Math.PI) / 180, 6);
  });

  it("turns yaw at 0.0023 rad per pixel", () => {
    const cam = applyLook(createCamera(), 1000, 0);
    expect(cam.yaw).toBeCloseTo(2.3, 5);
  });

  it("does not mutate the input camera", () => {
    const cam = createCamera();
    applyLook(cam, 100, -100);
    expect(cam.yaw).toBe(0);
    expect(cam.pitch).toBe(0);
  });
});

describe("tickCamera", () => {
  it("walks forward then glides to rest", () => {
    let cam = createCamera();
    const move = { forward: 1, strafe: 0, vertical: 0, sprint: false };
    for (let i = 0; i < 180; i += 1) cam = tickCamera(cam, move, 1 / 60);
    // It actually moved forward along -Z.
    expect(cam.position[2]).toBeLessThan(-0.5);

    for (let i = 0; i < 300; i += 1) cam = tickCamera(cam, REST, 1 / 60);
    expect(speedOf(cam)).toBeLessThan(0.01);
  });

  it("never exceeds the sprint speed cap of 7.5 m/s", () => {
    let cam = createCamera();
    const sprint = { forward: 1, strafe: 0, vertical: 0, sprint: true };
    let maxSpeed = 0;
    for (let i = 0; i < 600; i += 1) {
      cam = tickCamera(cam, sprint, 1 / 60);
      maxSpeed = Math.max(maxSpeed, speedOf(cam));
    }
    expect(maxSpeed).toBeLessThanOrEqual(7.5 + 1e-6);
  });

  it("caps walk speed at 3 m/s even with diagonal input", () => {
    let cam = createCamera();
    const diagonal = { forward: 1, strafe: 1, vertical: 0, sprint: false };
    let maxSpeed = 0;
    for (let i = 0; i < 600; i += 1) {
      cam = tickCamera(cam, diagonal, 1 / 60);
      maxSpeed = Math.max(maxSpeed, speedOf(cam));
    }
    expect(maxSpeed).toBeLessThanOrEqual(3 + 1e-6);
  });

  it("clamps to the inner shell radius (min 0.8)", () => {
    const cam: ReturnType<typeof createCamera> = {
      ...createCamera(),
      position: [0.8, 1.6, 0],
      velocity: [-20, 0, 0],
    };
    const moved = tickCamera(cam, REST, 1 / 60);
    const radius = Math.hypot(moved.position[0], moved.position[2]);
    expect(radius).toBeGreaterThanOrEqual(0.8 - 1e-6);
  });

  it("clamps to the outer shell radius (max 14)", () => {
    const cam: ReturnType<typeof createCamera> = {
      ...createCamera(),
      position: [14, 1.6, 0],
      velocity: [20, 0, 0],
    };
    const moved = tickCamera(cam, REST, 1 / 60);
    const radius = Math.hypot(moved.position[0], moved.position[2]);
    expect(radius).toBeLessThanOrEqual(14 + 1e-6);
  });

  it("clamps height to 0.3..8 meters", () => {
    const high: ReturnType<typeof createCamera> = {
      ...createCamera(),
      position: [5, 8, 0],
      velocity: [0, 20, 0],
    };
    const lowered = tickCamera(high, REST, 1 / 60);
    expect(lowered.position[1]).toBeLessThanOrEqual(8 + 1e-6);

    const low: ReturnType<typeof createCamera> = {
      ...createCamera(),
      position: [5, 0.3, 0],
      velocity: [0, -20, 0],
    };
    const raised = tickCamera(low, REST, 1 / 60);
    expect(raised.position[1]).toBeGreaterThanOrEqual(0.3 - 1e-6);
  });
});

describe("flyTo", () => {
  it("faces the target (forward dot target-direction > 0.99)", () => {
    const cam = createCamera();
    const target: [number, number, number] = [5, 3, -7];
    const result = flyTo(cam, target);

    const fx = Math.sin(result.yaw) * Math.cos(result.pitch);
    const fy = Math.sin(result.pitch);
    const fz = -Math.cos(result.yaw) * Math.cos(result.pitch);

    const tx = target[0] - result.position[0];
    const ty = target[1] - result.position[1];
    const tz = target[2] - result.position[2];
    const tl = Math.hypot(tx, ty, tz);

    const dot = (fx * tx + fy * ty + fz * tz) / tl;
    expect(dot).toBeGreaterThan(0.99);
  });

  it("lands 2.2m back from the target along the current-to-target direction", () => {
    const cam = createCamera();
    const target: [number, number, number] = [5, 3, -7];
    const result = flyTo(cam, target);

    const back = Math.hypot(
      target[0] - result.position[0],
      target[1] - result.position[1],
      target[2] - result.position[2],
    );
    expect(back).toBeCloseTo(2.2, 5);
  });

  it("never places the camera closer than 1.2m from the origin", () => {
    const cam = createCamera();
    const result = flyTo(cam, [0.5, 0.4, 0.5]);
    const radius = Math.hypot(result.position[0], result.position[2]);
    expect(radius).toBeGreaterThanOrEqual(1.2 - 1e-6);
  });
});
