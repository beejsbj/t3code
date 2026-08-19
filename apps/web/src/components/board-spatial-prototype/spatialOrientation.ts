import * as THREE from "three";

export type SemanticAxis = "workflow" | "project" | "state";
export type AxisDirection = -1 | 1;

export interface SignedSemanticAxis {
  readonly axis: SemanticAxis;
  readonly direction: AxisDirection;
}

export interface SpatialOrientation {
  readonly right: SignedSemanticAxis;
  readonly up: SignedSemanticAxis;
  readonly depth: SignedSemanticAxis;
}

export type SpatialRotation = "yaw-left" | "yaw-right" | "pitch-up" | "pitch-down";

const SIGNED_SEMANTIC_AXES: ReadonlyArray<SignedSemanticAxis> = [
  { axis: "workflow", direction: 1 },
  { axis: "workflow", direction: -1 },
  { axis: "project", direction: 1 },
  { axis: "project", direction: -1 },
  { axis: "state", direction: 1 },
  { axis: "state", direction: -1 },
];

const AXIS_LABELS: Readonly<Record<SemanticAxis, string>> = {
  workflow: "Workflow",
  project: "Project",
  state: "State",
};

function signedAxisKey(axis: SignedSemanticAxis): string {
  return `${axis.axis}${axis.direction > 0 ? "+" : "-"}`;
}

export function semanticAxisLabel(axis: SemanticAxis): string {
  return AXIS_LABELS[axis];
}

export function invertSignedSemanticAxis(axis: SignedSemanticAxis): SignedSemanticAxis {
  return { axis: axis.axis, direction: -axis.direction as AxisDirection };
}

export function signedSemanticAxisVector(
  axis: SignedSemanticAxis,
  target?: THREE.Vector3,
): THREE.Vector3 {
  const vector = target ?? new THREE.Vector3();
  switch (axis.axis) {
    case "workflow":
      return vector.set(axis.direction, 0, 0);
    case "project":
      return vector.set(0, -axis.direction, 0);
    case "state":
      return vector.set(0, 0, -axis.direction);
  }
}

function signedSemanticAxisFromVector(vector: THREE.Vector3): SignedSemanticAxis {
  for (const signed of SIGNED_SEMANTIC_AXES) {
    const direction = signedSemanticAxisVector(signed);
    if (
      Math.abs(direction.x - vector.x) < 1e-9 &&
      Math.abs(direction.y - vector.y) < 1e-9 &&
      Math.abs(direction.z - vector.z) < 1e-9
    ) {
      return signed;
    }
  }
  throw new Error(`Vector (${vector.x}, ${vector.y}, ${vector.z}) is not a signed semantic axis`);
}

export function spatialOrientationKey(orientation: SpatialOrientation): string {
  return `${signedAxisKey(orientation.right)}|${signedAxisKey(orientation.up)}|${signedAxisKey(
    orientation.depth,
  )}`;
}

export const HOME_SPATIAL_ORIENTATION: SpatialOrientation = {
  right: { axis: "workflow", direction: 1 },
  up: { axis: "project", direction: -1 },
  depth: { axis: "state", direction: 1 },
};

function buildAllOrientations(): ReadonlyArray<SpatialOrientation> {
  const cross = new THREE.Vector3();
  const orientations: SpatialOrientation[] = [];
  for (const right of SIGNED_SEMANTIC_AXES) {
    for (const up of SIGNED_SEMANTIC_AXES) {
      if (up.axis === right.axis) continue;
      cross.crossVectors(signedSemanticAxisVector(right), signedSemanticAxisVector(up)).negate();
      orientations.push({ right, up, depth: signedSemanticAxisFromVector(cross) });
    }
  }
  return orientations;
}

export const ALL_SPATIAL_ORIENTATIONS: ReadonlyArray<SpatialOrientation> = [
  HOME_SPATIAL_ORIENTATION,
  ...buildAllOrientations().filter(
    (orientation) =>
      spatialOrientationKey(orientation) !== spatialOrientationKey(HOME_SPATIAL_ORIENTATION),
  ),
];

export function spatialOrientationQuaternion(
  orientation: SpatialOrientation,
  target?: THREE.Quaternion,
): THREE.Quaternion {
  const basis = new THREE.Matrix4();
  const right = signedSemanticAxisVector(orientation.right);
  const up = signedSemanticAxisVector(orientation.up);
  const depth = signedSemanticAxisVector(orientation.depth).negate();
  basis.makeBasis(right, up, depth);
  return (target ?? new THREE.Quaternion()).setFromRotationMatrix(basis);
}

export function nearestSpatialOrientation(quaternion: THREE.Quaternion): SpatialOrientation {
  const normalized = quaternion.clone().normalize();
  const candidate = new THREE.Quaternion();
  let best = ALL_SPATIAL_ORIENTATIONS[0];
  let bestSimilarity = -1;
  for (const orientation of ALL_SPATIAL_ORIENTATIONS) {
    spatialOrientationQuaternion(orientation, candidate);
    const similarity = Math.abs(normalized.dot(candidate));
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      best = orientation;
    }
  }
  return best;
}

export function rotateSpatialOrientation(
  orientation: SpatialOrientation,
  rotation: SpatialRotation,
): SpatialOrientation {
  switch (rotation) {
    case "yaw-left":
      return {
        right: orientation.depth,
        up: orientation.up,
        depth: invertSignedSemanticAxis(orientation.right),
      };
    case "yaw-right":
      return {
        right: invertSignedSemanticAxis(orientation.depth),
        up: orientation.up,
        depth: orientation.right,
      };
    case "pitch-up":
      return {
        right: orientation.right,
        up: invertSignedSemanticAxis(orientation.depth),
        depth: orientation.up,
      };
    case "pitch-down":
      return {
        right: orientation.right,
        up: orientation.depth,
        depth: invertSignedSemanticAxis(orientation.up),
      };
  }
}

export function semanticAxisForScreenRole(
  orientation: SpatialOrientation,
  role: "horizontal" | "vertical" | "depth",
): SignedSemanticAxis {
  switch (role) {
    case "horizontal":
      return orientation.right;
    case "vertical":
      return orientation.up;
    case "depth":
      return orientation.depth;
  }
}
