/**
 * Pure CPU raycasting against billboarded card quads.
 *
 * Cards are view-facing billboards: each card's quad lies in the plane that
 * faces the camera (plane normal points from the card center toward the
 * camera), with an up axis derived from world-up projected onto that plane.
 * This module never touches the DOM — it maps NDC look coordinates to world
 * rays and tests those rays against card extents in world space.
 */

/** A ray in world space. `direction` is always unit length. */
export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number];
}

/** A camera described by its world position and look orientation (no roll). */
interface CameraLike {
  position: [number, number, number];
  /** Rotation about the world Y axis. yaw=0 faces toward +Z. */
  yaw: number;
  /** Rotation about the camera's local right axis. pitch=0 is eye level. */
  pitch: number;
}

/** A pickable card: a thread id plus its world-space billboard center. */
interface PickableCard {
  id: string;
  position: [number, number, number];
}

const DEFAULT_FOV_Y = 60;
const DEFAULT_ASPECT = 16 / 9;

/** Half-extent of a card billboard: 1.4m wide, 0.9m tall. */
const DEFAULT_HALF_WIDTH = 1.4 / 2;
const DEFAULT_HALF_HEIGHT = 0.9 / 2;

/** Squared threshold below which two vectors are treated as parallel. */
const EPS_SQUARED = 1e-12;

/**
 * Build a camera basis (forward / right / up) from a yaw and pitch.
 * Right is derived first so up = forward × right holds at the identity
 * orientation (yaw=0, pitch=0 gives forward=+Z, right=+X, up=+Y).
 */
function cameraBasis(
  yaw: number,
  pitch: number,
): {
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
} {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);

  const forward: [number, number, number] = [sy * cp, sp, cy * cp];
  const right: [number, number, number] = [cy, 0, -sy];

  // up = normalize(cross(forward, right))
  const up: [number, number, number] = [-sy * sp, cp, -cy * sp];

  return { forward, right, up };
}

/**
 * Convert an NDC look coordinate (each axis in [-1, 1], +y up) into a
 * normalized world-space ray emanating from the camera position. NDC (0, 0)
 * is the forward axis; x grows toward screen-right and y grows upward.
 */
export function ndcToWorldRay(
  ndcX: number,
  ndcY: number,
  camera: CameraLike,
  fovYDeg: number = DEFAULT_FOV_Y,
  aspect: number = DEFAULT_ASPECT,
): Ray {
  const { forward, right, up } = cameraBasis(camera.yaw, camera.pitch);

  const tanHalfFovY = Math.tan((fovYDeg * Math.PI) / 180 / 2);
  const tanHalfFovX = tanHalfFovY * aspect;

  const [fx, fy, fz] = forward;
  const [rx, ry, rz] = right;
  const [ux, uy, uz] = up;

  const dx = fx + rx * ndcX * tanHalfFovX + ux * ndcY * tanHalfFovY;
  const dy = fy + ry * ndcX * tanHalfFovX + uy * ndcY * tanHalfFovY;
  const dz = fz + rz * ndcX * tanHalfFovX + uz * ndcY * tanHalfFovY;

  const len = Math.hypot(dx, dy, dz);
  if (len === 0) {
    // Degenerate: cannot happen for finite inputs, but stay total.
    return { origin: camera.position, direction: forward };
  }

  return {
    origin: camera.position,
    direction: [dx / len, dy / len, dz / len],
  };
}

/**
 * Intersect `ray` with a card billboard centered at `center`. The quad faces
 * `cameraPosition` and spans `width` × `height` world units.
 *
 * Returns the distance along the ray to the hit, or `null` when the ray
 * misses, is parallel to the billboard plane, or would hit behind the camera.
 */
export function rayBillboard(
  ray: Ray,
  center: [number, number, number],
  cameraPosition: [number, number, number],
  width: number = DEFAULT_HALF_WIDTH * 2,
  height: number = DEFAULT_HALF_HEIGHT * 2,
): number | null {
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;
  const [cx, cy, cz] = center;
  const [px, py, pz] = cameraPosition;

  // Plane normal: from card center toward the camera (billboard faces camera).
  let nx = px - cx;
  let ny = py - cy;
  let nz = pz - cz;
  const nLen = Math.hypot(nx, ny, nz);
  if (nLen === 0) {
    // Camera is exactly on the card center — no meaningful plane.
    return null;
  }
  nx /= nLen;
  ny /= nLen;
  nz /= nLen;

  // Solve ray·t against the plane. Front hits need the ray heading toward the
  // plane (dot < 0); parallel rays (dot ~ 0) never intersect.
  const denom = dx * nx + dy * ny + dz * nz;
  if (denom >= -1e-9) {
    return null;
  }

  const t = ((cx - ox) * nx + (cy - oy) * ny + (cz - oz) * nz) / denom;
  if (t < 0) {
    // The plane is behind the ray origin — never pick what's behind us.
    return null;
  }

  // Measure the offset in the billboard's own basis: project the hit point
  // onto the plane orthogonally, then express it in the in-plane axes.
  // Measuring the raw ray-entry point would over- or under-count at oblique
  // angles because the entry point sits off the plane along the ray.
  const hx = ox + dx * t;
  const hy = oy + dy * t;
  const hz = oz + dz * t;
  const dAlong = (hx - cx) * nx + (hy - cy) * ny + (hz - cz) * nz;
  const vx = hx - cx - dAlong * nx;
  const vy = hy - cy - dAlong * ny;
  const vz = hz - cz - dAlong * nz;

  // Billboard up: world up (0, 1, 0) projected onto the billboard plane.
  let ux: number;
  let uy: number;
  let uz: number;
  const projLenSq = 1 - ny * ny;
  if (projLenSq > EPS_SQUARED) {
    const il = 1 / Math.sqrt(projLenSq);
    ux = -ny * nx * il;
    uy = projLenSq * il;
    uz = -ny * nz * il;
  } else {
    // Plane normal is nearly world-up; fall back to an arbitrary in-plane
    // perpendicular instead of degenerating.
    const fallbackLen = Math.hypot(nz, nx);
    if (fallbackLen === 0) {
      return null;
    }
    ux = -nz / fallbackLen;
    uy = 0;
    uz = nx / fallbackLen;
  }

  // Right = cross(n, up). Handedness matters at oblique angles: the flipped
  // axis would double-count the offset between the ray's plane entry point
  // and the quad's perpendicular-projected coordinate.
  const rx = ny * uz - nz * uy;
  const ry = nz * ux - nx * uz;
  const rz = nx * uy - ny * ux;

  const halfWidth = width / 2;
  const halfHeight = height / 2;

  const xCoord = vx * rx + vy * ry + vz * rz;
  const yCoord = vx * ux + vy * uy + vz * uz;

  if (Math.abs(xCoord) > halfWidth || Math.abs(yCoord) > halfHeight) {
    return null;
  }

  return t;
}

/**
 * Return the id of the nearest card whose billboard `ray` hits, or `null` if
 * the ray hits no card. Uses default card dimensions.
 */
export function pickCard(
  ray: Ray,
  cards: readonly PickableCard[],
  cameraPosition: [number, number, number],
): string | null {
  let bestId: string | null = null;
  let bestDist = Infinity;

  for (const card of cards) {
    const dist = rayBillboard(ray, card.position, cameraPosition);
    if (dist !== null && dist < bestDist) {
      bestDist = dist;
      bestId = card.id;
    }
  }

  return bestId;
}
