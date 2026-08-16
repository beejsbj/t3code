import { describe, expect, it } from "vite-plus/test";

import { perspectiveMatrix } from "./renderer";

/** Project a homogeneous point through a column-major matrix → NDC coords. */
function project(p: [number, number, number, number], m: Float32Array): [number, number, number] {
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]! * p[3];
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]! * p[3];
  const z = m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]! * p[3];
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]! * p[3];
  return [x / w, y / w, z / w];
}

const FOV_Y = 60;
const ASPECT = 16 / 9;
const NEAR = 0.1;
const FAR = 100;

describe("perspectiveMatrix", () => {
  it("maps the near plane to NDC z = -1", () => {
    const m = perspectiveMatrix(FOV_Y, ASPECT, NEAR, FAR);
    // Camera-space z = -NEAR (OpenGL looks down -z).
    const ndc = project([0, 0, -NEAR, 1], m);
    expect(ndc[2]).toBeCloseTo(-1, 6);
  });

  it("maps the far plane to NDC z = +1", () => {
    const m = perspectiveMatrix(FOV_Y, ASPECT, NEAR, FAR);
    const ndc = project([0, 0, -FAR, 1], m);
    expect(ndc[2]).toBeCloseTo(1, 6);
  });

  it("maps a point on the frustum x-edge to NDC x = ±1", () => {
    const m = perspectiveMatrix(FOV_Y, ASPECT, NEAR, FAR);
    const tanHalfY = Math.tan((FOV_Y * Math.PI) / 180 / 2);
    const tanHalfX = tanHalfY * ASPECT;
    const xEdge = tanHalfX * NEAR;
    expect(project([xEdge, 0, -NEAR, 1], m)[0]).toBeCloseTo(1, 6);
    expect(project([-xEdge, 0, -NEAR, 1], m)[0]).toBeCloseTo(-1, 6);
  });

  it("maps a point on the frustum y-edge to NDC y = ±1", () => {
    const m = perspectiveMatrix(FOV_Y, ASPECT, NEAR, FAR);
    const tanHalfY = Math.tan((FOV_Y * Math.PI) / 180 / 2);
    const yEdge = tanHalfY * NEAR;
    expect(project([0, yEdge, -NEAR, 1], m)[1]).toBeCloseTo(1, 6);
    expect(project([0, -yEdge, -NEAR, 1], m)[1]).toBeCloseTo(-1, 6);
  });

  it("produces a 16-element column-major matrix", () => {
    const m = perspectiveMatrix(FOV_Y, ASPECT, NEAR, FAR);
    expect(m).toHaveLength(16);
    // Identity-affecting diagonal entries are present and finite.
    expect(m[0]).toBeGreaterThan(0);
    expect(m[5]).toBeGreaterThan(0);
    expect(m[11]).toBe(-1);
  });
});
