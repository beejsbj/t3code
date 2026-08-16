/**
 * Pure camera state and movement for the Board Palace 3D prototype.
 *
 * Everything here is a pure function over an immutable {@link CameraState} —
 * no DOM, no timers, no side effects — so the whole module is unit-testable.
 * The world is right-handed with +Y up. At yaw 0 the camera faces -Z.
 */

export interface CameraState {
  /** Eye position in meters (1 world unit = 1 meter). */
  position: [number, number, number];
  /** Rotation around the +Y axis; 0 faces -Z. */
  yaw: number;
  /** Elevation relative to the horizontal plane, clamped to ±85°. */
  pitch: number;
  /** Current velocity in m/s (walking is damped toward the input target). */
  velocity: [number, number, number];
}

export interface MoveInput {
  /** -1 (back) .. 1 (forward) along the yaw direction. */
  forward: number;
  /** -1 (left) .. 1 (right), perpendicular to the yaw direction. */
  strafe: number;
  /** -1 (down) .. 1 (up). */
  vertical: number;
  /** When true, movement speed is multiplied by {@link SPRINT_MULTIPLIER}. */
  sprint: boolean;
}

const LOOK_SENSITIVITY = 0.0023; // radians per pixel of pointer movement
const PITCH_LIMIT = (85 * Math.PI) / 180; // radians
const WALK_MAX_SPEED = 3; // m/s
const SPRINT_MULTIPLIER = 2.5;
/** 1/s exponential-smoothing rate: sets both acceleration (~30 m/s² from rest at walk) and the ~200-300ms glide-to-stop feel. */
const STIFFNESS = 10;
const FLY_BACK = 2.2; // m the camera sits behind a flyTo target
const MIN_ORIGIN_DISTANCE = 1.2; // m, flyTo keeps the camera this far from the origin
const SHELL_MIN_RADIUS = 0.8; // m, walkable shell inner radius
const SHELL_MAX_RADIUS = 14; // m, walkable shell outer radius
const SHELL_MIN_Y = 0.3; // m
const SHELL_MAX_Y = 8; // m
const EPSILON = 1e-9;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Horizontal unit direction the camera faces for a given yaw. */
function forwardXZ(yaw: number): readonly [number, number] {
  return [Math.sin(yaw), -Math.cos(yaw)];
}

/**
 * Clamp a position to the walkable shell (radius 0.8..14 m around the
 * origin, height 0.3..8 m). Pure: returns a fresh tuple.
 */
function clampToShell(
  x: number,
  y: number,
  z: number,
  minRadius: number,
): [number, number, number] {
  const horiz = Math.hypot(x, z);
  const radius = clamp(horiz, minRadius, SHELL_MAX_RADIUS);
  if (horiz > EPSILON) {
    x = (x / horiz) * radius;
    z = (z / horiz) * radius;
  } else {
    x = minRadius;
    z = 0;
  }
  return [x, clamp(y, SHELL_MIN_Y, SHELL_MAX_Y), z];
}

/**
 * Create a fresh camera standing at eye height looking down -Z.
 * @returns A camera at [0, 1.6, 0], yaw 0 (facing -Z), at rest.
 */
export function createCamera(): CameraState {
  return {
    position: [0, 1.6, 0],
    yaw: 0,
    pitch: 0,
    velocity: [0, 0, 0],
  };
}

/**
 * Apply pointer-look deltas (in pixels) to the camera's yaw/pitch.
 * @param cam The current camera.
 * @param dx Horizontal pointer delta (right is positive).
 * @param dy Vertical pointer delta (down is positive, so looking down lowers pitch).
 * @returns A new camera with the same position/velocity but updated orientation.
 */
export function applyLook(cam: CameraState, dx: number, dy: number): CameraState {
  return {
    ...cam,
    yaw: cam.yaw + dx * LOOK_SENSITIVITY,
    pitch: clamp(cam.pitch - dy * LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT),
    velocity: [...cam.velocity] as [number, number, number],
  };
}

/**
 * Advance the camera one frame of movement integration.
 *
 * Horizontal motion follows the yaw direction only (pitch does not tilt the
 * walk); vertical input moves the camera straight up/down. Velocity eases
 * toward the input target with an exponential blend, then the eye position is
 * integrated and clamped to the walkable shell.
 * @param cam The current camera.
 * @param input This frame's movement input.
 * @param dtSeconds Frame duration in seconds.
 * @returns A new camera with updated velocity and position.
 */
export function tickCamera(cam: CameraState, input: MoveInput, dtSeconds: number): CameraState {
  const dt = Math.max(dtSeconds, 0);
  const maxSpeed = input.sprint ? WALK_MAX_SPEED * SPRINT_MULTIPLIER : WALK_MAX_SPEED;

  const [fx, fz] = forwardXZ(cam.yaw);
  // Right is perpendicular to forward in the horizontal plane.
  const dirX = fx * input.forward - fz * input.strafe;
  const dirZ = fz * input.forward + fx * input.strafe;

  let desiredX = 0;
  let desiredZ = 0;
  const dirMag = Math.hypot(dirX, dirZ);
  if (dirMag > EPSILON) {
    const scale = (dirMag > 1 ? 1 / dirMag : 1) * maxSpeed;
    desiredX = dirX * scale;
    desiredZ = dirZ * scale;
  }
  const desiredY = clamp(input.vertical, -1, 1) * maxSpeed;

  const blend = 1 - Math.exp(-STIFFNESS * dt);
  const velocityX = cam.velocity[0] + (desiredX - cam.velocity[0]) * blend;
  const velocityY = cam.velocity[1] + (desiredY - cam.velocity[1]) * blend;
  const velocityZ = cam.velocity[2] + (desiredZ - cam.velocity[2]) * blend;

  const position = clampToShell(
    cam.position[0] + velocityX * dt,
    cam.position[1] + velocityY * dt,
    cam.position[2] + velocityZ * dt,
    SHELL_MIN_RADIUS,
  );

  return {
    position,
    yaw: cam.yaw,
    pitch: cam.pitch,
    velocity: [velocityX, velocityY, velocityZ],
  };
}

/**
 * Build the camera's view matrix (column-major 4x4, right-handed, roll 0).
 *
 * The matrix is laid out as standard OpenGL-style column-major storage:
 * columns 0-2 are the camera's right/up/forward basis, column 3 is the
 * translation that maps world space into camera space.
 * @param cam The camera to build the view from.
 * @returns A 16-element column-major Float32Array view matrix.
 */
export function viewMatrix(cam: CameraState): Float32Array {
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);

  // Camera basis (d = forward the camera looks).
  const d: readonly [number, number, number] = [sy * cp, sp, -cy * cp];
  const r: readonly [number, number, number] = [cy, 0, sy];
  const u: readonly [number, number, number] = [
    r[1] * d[2] - r[2] * d[1],
    r[2] * d[0] - r[0] * d[2],
    r[0] * d[1] - r[1] * d[0],
  ];

  const ex = cam.position[0];
  const ey = cam.position[1];
  const ez = cam.position[2];

  const m = new Float32Array(16);
  // Column 0: right
  m[0] = r[0];
  m[1] = r[1];
  m[2] = r[2];
  m[3] = 0;
  // Column 1: up
  m[4] = u[0];
  m[5] = u[1];
  m[6] = u[2];
  m[7] = 0;
  // Column 2: forward (view direction)
  m[8] = d[0];
  m[9] = d[1];
  m[10] = d[2];
  m[11] = 0;
  // Column 3: translation
  m[12] = -(r[0] * ex + r[1] * ey + r[2] * ez);
  m[13] = -(u[0] * ex + u[1] * ey + u[2] * ez);
  m[14] = -(d[0] * ex + d[1] * ey + d[2] * ez);
  m[15] = 1;
  return m;
}

/**
 * Snap the camera to face a target: it lands {@link FLY_BACK} meters back from
 * the target along the current-to-target direction, oriented toward it, and is
 * never placed closer than {@link MIN_ORIGIN_DISTANCE} meters from the origin.
 * Velocity is zeroed (this is a snap, not a continuation of motion).
 * @param cam The current camera.
 * @param target World position to face.
 * @returns A new camera positioned behind and facing the target.
 */
export function flyTo(cam: CameraState, target: [number, number, number]): CameraState {
  let dx = target[0] - cam.position[0];
  let dy = target[1] - cam.position[1];
  let dz = target[2] - cam.position[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < EPSILON) {
    dx = 0;
    dy = 0;
    dz = -1;
  } else {
    dx /= dist;
    dy /= dist;
    dz /= dist;
  }

  const [px, py, pz] = clampToShell(
    target[0] - dx * FLY_BACK,
    target[1] - dy * FLY_BACK,
    target[2] - dz * FLY_BACK,
    MIN_ORIGIN_DISTANCE,
  );

  // Orient toward the target from the settled position.
  const fx = target[0] - px;
  const fy = target[1] - py;
  const fz = target[2] - pz;
  const yaw = Math.atan2(fx, -fz);
  const horiz = Math.hypot(fx, fz);
  const pitch = horiz < EPSILON ? 0 : Math.atan2(fy, horiz);

  return {
    position: [px, py, pz],
    yaw,
    pitch,
    velocity: [0, 0, 0],
  };
}
