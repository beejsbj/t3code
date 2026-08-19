import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_SPATIAL_ORIENTATIONS,
  HOME_SPATIAL_ORIENTATION,
  invertSignedSemanticAxis,
  nearestSpatialOrientation,
  rotateSpatialOrientation,
  semanticAxisForScreenRole,
  semanticAxisLabel,
  signedSemanticAxisVector,
  spatialOrientationKey,
  spatialOrientationQuaternion,
  type SpatialRotation,
} from "./spatialOrientation.ts";

const ROTATIONS: ReadonlyArray<SpatialRotation> = [
  "yaw-left",
  "yaw-right",
  "pitch-up",
  "pitch-down",
];

describe("spatial orientation model", () => {
  it("contains exactly 24 unique orientations with home first", () => {
    expect(ALL_SPATIAL_ORIENTATIONS).toHaveLength(24);
    expect(ALL_SPATIAL_ORIENTATIONS[0]).toEqual(HOME_SPATIAL_ORIENTATION);
    const keys = ALL_SPATIAL_ORIENTATIONS.map(spatialOrientationKey);
    expect(new Set(keys).size).toBe(24);
  });

  it("uses each semantic axis exactly once per orientation and stays right-handed", () => {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const depth = new THREE.Vector3();
    const cross = new THREE.Vector3();
    for (const orientation of ALL_SPATIAL_ORIENTATIONS) {
      const axes = [orientation.right.axis, orientation.up.axis, orientation.depth.axis];
      expect(new Set(axes).size).toBe(3);
      expect(axes).toEqual(expect.arrayContaining(["workflow", "project", "state"]));
      for (const signed of [orientation.right, orientation.up, orientation.depth]) {
        expect([-1, 1]).toContain(signed.direction);
      }
      signedSemanticAxisVector(orientation.right, right);
      signedSemanticAxisVector(orientation.up, up);
      signedSemanticAxisVector(orientation.depth, depth);
      cross.crossVectors(right, up).negate();
      expect(cross.distanceTo(depth)).toBeLessThan(1e-9);
      expect(right.dot(up)).toBeCloseTo(0);
      expect(right.length()).toBeCloseTo(1);
      expect(up.length()).toBeCloseTo(1);
      expect(depth.length()).toBeCloseTo(1);
    }
  });

  it("maps the home orientation to the identity quaternion", () => {
    const home = spatialOrientationQuaternion(HOME_SPATIAL_ORIENTATION);
    expect(home.x).toBeCloseTo(0);
    expect(home.y).toBeCloseTo(0);
    expect(home.z).toBeCloseTo(0);
    expect(home.w).toBeCloseTo(1);
  });

  it("round-trips every orientation through its quaternion", () => {
    for (const orientation of ALL_SPATIAL_ORIENTATIONS) {
      const recovered = nearestSpatialOrientation(spatialOrientationQuaternion(orientation));
      expect(recovered).toEqual(orientation);
    }
  });

  it("keeps every rotation inside the 24 orientations", () => {
    const keys = new Set(ALL_SPATIAL_ORIENTATIONS.map(spatialOrientationKey));
    for (const orientation of ALL_SPATIAL_ORIENTATIONS) {
      for (const rotation of ROTATIONS) {
        const turned = rotateSpatialOrientation(orientation, rotation);
        expect(keys.has(spatialOrientationKey(turned))).toBe(true);
      }
    }
  });

  it("gives every rotation an inverse and a 4-cycle", () => {
    const inverse: Readonly<Record<SpatialRotation, SpatialRotation>> = {
      "yaw-left": "yaw-right",
      "yaw-right": "yaw-left",
      "pitch-up": "pitch-down",
      "pitch-down": "pitch-up",
    };
    for (const orientation of ALL_SPATIAL_ORIENTATIONS) {
      for (const rotation of ROTATIONS) {
        const once = rotateSpatialOrientation(orientation, rotation);
        expect(rotateSpatialOrientation(once, inverse[rotation])).toEqual(orientation);
        let cycled = orientation;
        for (let step = 0; step < 4; step += 1) {
          cycled = rotateSpatialOrientation(cycled, rotation);
        }
        expect(cycled).toEqual(orientation);
      }
    }
  });

  it("turns workflow into the depth axis with a horizontal turn from home", () => {
    const yawedLeft = rotateSpatialOrientation(HOME_SPATIAL_ORIENTATION, "yaw-left");
    expect(yawedLeft.depth.axis).toBe("workflow");
    expect(yawedLeft.right.axis).toBe("state");
    expect(yawedLeft.up.axis).toBe("project");
    expect(yawedLeft.right.direction).toBe(1);

    const yawedRight = rotateSpatialOrientation(HOME_SPATIAL_ORIENTATION, "yaw-right");
    expect(yawedRight.depth.axis).toBe("workflow");
    expect(yawedRight.right.axis).toBe("state");
    expect(yawedRight.up.axis).toBe("project");
    expect(yawedRight.right.direction).toBe(-1);
  });

  it("labels and inverts signed semantic axes", () => {
    expect(semanticAxisLabel("workflow")).toBe("Workflow");
    expect(semanticAxisLabel("project")).toBe("Project");
    expect(semanticAxisLabel("state")).toBe("State");
    expect(invertSignedSemanticAxis({ axis: "state", direction: 1 })).toEqual({
      axis: "state",
      direction: -1,
    });
    expect(invertSignedSemanticAxis({ axis: "workflow", direction: -1 })).toEqual({
      axis: "workflow",
      direction: 1,
    });
  });

  it("resolves signed axes to their world vectors", () => {
    expect(signedSemanticAxisVector({ axis: "workflow", direction: 1 })).toEqual(
      new THREE.Vector3(1, 0, 0),
    );
    expect(signedSemanticAxisVector({ axis: "workflow", direction: -1 })).toEqual(
      new THREE.Vector3(-1, 0, 0),
    );
    expect(signedSemanticAxisVector({ axis: "project", direction: 1 })).toEqual(
      new THREE.Vector3(0, -1, 0),
    );
    expect(signedSemanticAxisVector({ axis: "project", direction: -1 })).toEqual(
      new THREE.Vector3(0, 1, 0),
    );
    expect(signedSemanticAxisVector({ axis: "state", direction: 1 })).toEqual(
      new THREE.Vector3(0, 0, -1),
    );
    expect(signedSemanticAxisVector({ axis: "state", direction: -1 })).toEqual(
      new THREE.Vector3(0, 0, 1),
    );
  });

  it("resolves screen roles from an orientation", () => {
    expect(semanticAxisForScreenRole(HOME_SPATIAL_ORIENTATION, "horizontal")).toEqual({
      axis: "workflow",
      direction: 1,
    });
    expect(semanticAxisForScreenRole(HOME_SPATIAL_ORIENTATION, "vertical")).toEqual({
      axis: "project",
      direction: -1,
    });
    expect(semanticAxisForScreenRole(HOME_SPATIAL_ORIENTATION, "depth")).toEqual({
      axis: "state",
      direction: 1,
    });
  });
});
