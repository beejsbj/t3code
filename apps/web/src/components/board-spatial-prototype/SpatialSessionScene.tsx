import { LocateFixedIcon, MinusIcon, PlusIcon } from "lucide-react";
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useBoardFocusStore } from "../../board/boardFocusStore.ts";
import { BOARD_STATES } from "../../board/boardOrganization.ts";
import { Button } from "../ui/button.tsx";
import type { SpatialBoardSession } from "./SpatialBoardPrototype.tsx";
import { SpatialOrientationHud } from "./SpatialOrientationHud.tsx";
import {
  HOME_SPATIAL_ORIENTATION,
  nearestSpatialOrientation,
  rotateSpatialOrientation,
  semanticAxisLabel,
  signedSemanticAxisVector,
  spatialOrientationKey,
  spatialOrientationQuaternion,
  type SemanticAxis,
  type SignedSemanticAxis,
  type SpatialOrientation,
  type SpatialRotation,
} from "./spatialOrientation.ts";

interface SpatialSessionSceneProps {
  readonly sessions: ReadonlyArray<SpatialBoardSession>;
  readonly children: (session: SpatialBoardSession) => ReactNode;
}

interface LayoutCard {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly workflowId: string;
  readonly projectId: string;
  readonly stateId: string;
}

interface SemanticMarker {
  readonly id: string;
  readonly label: string;
  /** Coordinate along the positive semantic axis, in world units. */
  readonly position: number;
  readonly count: number;
}

interface StateMarker extends SemanticMarker {
  readonly index: number;
}

interface SpatialLayout {
  readonly key: string;
  readonly cards: ReadonlyArray<LayoutCard>;
  readonly byKey: ReadonlyMap<string, LayoutCard>;
  readonly markers: Readonly<Record<SemanticAxis, ReadonlyArray<SemanticMarker>>>;
  readonly states: ReadonlyArray<StateMarker>;
  readonly bounds: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

interface SceneController {
  readonly focusCard: (cardKey: string) => void;
  readonly focusMarker: (axis: SemanticAxis, markerId: string) => void;
  readonly reset: () => void;
  readonly resetOrientation: () => void;
  readonly rotate: (rotation: SpatialRotation) => void;
  readonly setDepthIndex: (index: number) => void;
  readonly depthBy: (amount: number) => void;
}

interface PersistentViewState {
  readonly focus: THREE.Vector3;
  zoom: number;
  initialized: boolean;
}

type DragMode = "pan" | "rotate";

const CARD_WIDTH = 380;
const CARD_HEIGHT = 560;
const COLUMN_GAP = 52;
const ROW_GAP = 76;
const CELL_CARD_GAP = 20;
const DEPTH_GAP = 360;
const CAMERA_FOV = 42;
const MIN_ZOOM = 0.24;
const MAX_ZOOM = 1.15;
const CAMERA_TAU_SECONDS = 0.06;
const CAMERA_EPSILON = 0.12;
const ORIENTATION_EPSILON = 0.0005;
const PINCH_DEPTH_PER_PIXEL = 0.03;
const ROTATE_RADIANS_PER_PIXEL = 0.006;

function planeZ(depth: number): number {
  return -depth * DEPTH_GAP;
}

function buildLayout(sessions: ReadonlyArray<SpatialBoardSession>): SpatialLayout {
  const observedLaneLabels = new Map(
    sessions.map((session) => [session.laneId, session.workflowLabel] as const),
  );
  const configuredLanes = new Map(
    sessions
      .flatMap((session) => session.lanes)
      .toSorted((left, right) => left.order - right.order)
      .map((lane) => [lane.id, lane.name] as const),
  );
  for (const [laneId, label] of observedLaneLabels) configuredLanes.set(laneId, label);
  const lanes = [...configuredLanes.entries()];
  const projects = [...new Set(sessions.map((session) => session.projectTitle))];
  const states: StateMarker[] = BOARD_STATES.map((state, index) => ({
    id: state.id,
    label: state.label,
    index,
    position: index * DEPTH_GAP,
    count: sessions.filter((session) => session.boardStateId === state.id).length,
  }));
  const depthByStateId = new Map(states.map((state) => [state.id, state.index] as const));
  const cellSessions = new Map<string, SpatialBoardSession[]>();

  for (const session of sessions) {
    const cellKey = `${session.projectTitle}\u0000${session.laneId}\u0000${session.boardStateId}`;
    const entries = cellSessions.get(cellKey) ?? [];
    entries.push(session);
    cellSessions.set(cellKey, entries);
  }

  const rowHeights = projects.map((project) => {
    const largestCell = Math.max(
      1,
      ...lanes.flatMap(([laneId]) =>
        states.map(
          (state) => cellSessions.get(`${project}\u0000${laneId}\u0000${state.id}`)?.length ?? 0,
        ),
      ),
    );
    return largestCell * CARD_HEIGHT + Math.max(0, largestCell - 1) * CELL_CARD_GAP;
  });
  const rowTops: number[] = [];
  let nextTop = 0;
  for (const rowHeight of rowHeights) {
    rowTops.push(nextTop);
    nextTop += rowHeight + ROW_GAP;
  }

  const columnStride = CARD_WIDTH + COLUMN_GAP;
  const cards: LayoutCard[] = [];
  for (const session of sessions) {
    const columnIndex = lanes.findIndex(([laneId]) => laneId === session.laneId);
    const rowIndex = projects.indexOf(session.projectTitle);
    const depthIndex = depthByStateId.get(session.boardStateId) ?? 0;
    const cellKey = `${session.projectTitle}\u0000${session.laneId}\u0000${session.boardStateId}`;
    const peers = cellSessions.get(cellKey) ?? [];
    const peerIndex = peers.findIndex((peer) => peer.cardKey === session.cardKey);
    const x = Math.max(0, columnIndex) * columnStride;
    const y = (rowTops[Math.max(0, rowIndex)] ?? 0) + peerIndex * (CARD_HEIGHT + CELL_CARD_GAP);
    cards.push({
      key: session.cardKey,
      x,
      y,
      z: planeZ(depthIndex),
      centerX: x + CARD_WIDTH / 2,
      centerY: y + CARD_HEIGHT / 2,
      workflowId: session.laneId,
      projectId: session.projectTitle,
      stateId: session.boardStateId,
    });
  }

  const width = Math.max(CARD_WIDTH, lanes.length * columnStride - COLUMN_GAP);
  const height = Math.max(CARD_HEIGHT, nextTop - ROW_GAP);
  const workflowMarkers = lanes.map(([id, label], index) => ({
    id,
    label,
    position: index * columnStride + CARD_WIDTH / 2,
    count: sessions.filter((session) => session.laneId === id).length,
  }));
  const projectMarkers = projects.map((project, index) => ({
    id: project,
    label: project,
    position: (rowTops[index] ?? 0) + (rowHeights[index] ?? CARD_HEIGHT) / 2,
    count: sessions.filter((session) => session.projectTitle === project).length,
  }));

  return {
    key: sessions
      .map(
        (session) =>
          `${session.cardKey}:${session.laneId}:${session.projectTitle}:${session.boardStateId}`,
      )
      .join("\u0001"),
    cards,
    byKey: new Map(cards.map((card) => [card.key, card])),
    markers: { workflow: workflowMarkers, project: projectMarkers, state: states },
    states,
    bounds: { left: 0, top: 0, right: width, bottom: height },
  };
}

function normalizedWheelDelta(event: WheelEvent): { readonly x: number; readonly y: number } {
  const multiplier =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? window.innerHeight
        : 1;
  return { x: event.deltaX * multiplier, y: event.deltaY * multiplier };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isHudTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-spatial-hud]") !== null;
}

function scrollableAncestor(target: EventTarget | null, card: Element): HTMLElement | null {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== card) {
    const style = window.getComputedStyle(node);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function clampZoom(zoom: number): number {
  return THREE.MathUtils.clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

function semanticCoordinate(point: THREE.Vector3, axis: SemanticAxis): number {
  switch (axis) {
    case "workflow":
      return point.x;
    case "project":
      return -point.y;
    case "state":
      return -point.z;
  }
}

function setSemanticCoordinate(point: THREE.Vector3, axis: SemanticAxis, value: number): void {
  switch (axis) {
    case "workflow":
      point.x = value;
      return;
    case "project":
      point.y = -value;
      return;
    case "state":
      point.z = -value;
  }
}

function cardMarkerId(card: LayoutCard, axis: SemanticAxis): string {
  switch (axis) {
    case "workflow":
      return card.workflowId;
    case "project":
      return card.projectId;
    case "state":
      return card.stateId;
  }
}

function nearestMarker(
  markers: ReadonlyArray<SemanticMarker>,
  coordinate: number,
): SemanticMarker | undefined {
  let nearest = markers[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const distance = Math.abs(marker.position - coordinate);
    if (distance < nearestDistance) {
      nearest = marker;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function markerSpacing(markers: ReadonlyArray<SemanticMarker>): number {
  const gaps = markers
    .slice(1)
    .map((marker, index) => Math.abs(marker.position - (markers[index]?.position ?? 0)))
    .filter((gap) => gap > 0)
    .toSorted((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)] ?? DEPTH_GAP;
}

function orderedDepthMarkers(
  layout: SpatialLayout,
  orientation: SpatialOrientation,
): ReadonlyArray<SemanticMarker> {
  const markers = layout.markers[orientation.depth.axis];
  return orientation.depth.direction === 1 ? markers : [...markers].toReversed();
}

function roleDirectionGlyph(role: "horizontal" | "vertical", axis: SignedSemanticAxis): string {
  if (role === "horizontal") return axis.direction === 1 ? "→" : "←";
  return axis.direction === 1 ? "↑" : "↓";
}

export function SpatialSessionScene({
  sessions,
  children,
}: SpatialSessionSceneProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const elementsRef = useRef(new Map<string, HTMLDivElement>());
  const horizontalMarkerRefs = useRef(new Map<string, HTMLButtonElement>());
  const verticalMarkerRefs = useRef(new Map<string, HTMLButtonElement>());
  const depthMarkerRefs = useRef(new Map<string, HTMLButtonElement>());
  const minimapViewportRef = useRef<HTMLDivElement | null>(null);
  const depthLabelRef = useRef<HTMLSpanElement | null>(null);
  const depthRangeRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const orientationRef = useRef<SpatialOrientation>(HOME_SPATIAL_ORIENTATION);
  const persistentViewRef = useRef<PersistentViewState | null>(null);
  if (persistentViewRef.current === null) {
    persistentViewRef.current = { focus: new THREE.Vector3(), zoom: 0.78, initialized: false };
  }
  const [orientation, setOrientation] = useState<SpatialOrientation>(HOME_SPATIAL_ORIENTATION);
  const focusedThreadKey = useBoardFocusStore((state) => state.focusedThreadKey);
  const focusRequest = useBoardFocusStore((state) => state.request);
  const layoutKey = useMemo(
    () =>
      sessions
        .map(
          (session) =>
            `${session.cardKey}:${session.laneId}:${session.projectTitle}:${session.boardStateId}`,
        )
        .join("\u0001"),
    [sessions],
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const layout = useMemo(() => buildLayout(sessionsRef.current), [layoutKey]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const persistentView = persistentViewRef.current;
    if (!root || !canvas || !persistentView || layout.cards.length === 0) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 5, 20_000);
    const boundsWidth = layout.bounds.right - layout.bounds.left;
    const boundsHeight = layout.bounds.bottom - layout.bounds.top;
    const gridSize = Math.max(boundsWidth, boundsHeight) + 2_400;
    const gridDivisions = Math.max(12, Math.min(120, Math.round(gridSize / 120)));
    const depthGrids = layout.states.map((state) => {
      const grid = new THREE.GridHelper(gridSize, gridDivisions, 0x64748b, 0xcbd5e1);
      grid.rotation.x = Math.PI / 2;
      grid.position.set(boundsWidth / 2, -boundsHeight / 2, planeZ(state.index));
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of materials) {
        material.transparent = true;
        material.opacity = 0.08;
        material.depthWrite = false;
      }
      scene.add(grid);
      return { grid, materials };
    });

    const volumeLeft = layout.bounds.left - 220;
    const volumeRight = layout.bounds.right + 220;
    const volumeTop = -(layout.bounds.top - 220);
    const volumeBottom = -(layout.bounds.bottom + 220);
    const firstZ = planeZ(0);
    const lastZ = planeZ(Math.max(0, layout.states.length - 1));
    const volumeGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(volumeLeft, volumeTop, firstZ),
      new THREE.Vector3(volumeLeft, volumeTop, lastZ),
      new THREE.Vector3(volumeRight, volumeTop, firstZ),
      new THREE.Vector3(volumeRight, volumeTop, lastZ),
      new THREE.Vector3(volumeLeft, volumeBottom, firstZ),
      new THREE.Vector3(volumeLeft, volumeBottom, lastZ),
      new THREE.Vector3(volumeRight, volumeBottom, firstZ),
      new THREE.Vector3(volumeRight, volumeBottom, lastZ),
    ]);
    const volumeMaterial = new THREE.LineBasicMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    scene.add(new THREE.LineSegments(volumeGeometry, volumeMaterial));

    const firstCard = layout.cards[0];
    const targetFocus = persistentView.focus.clone();
    const currentFocus = targetFocus.clone();
    let targetZoom = persistentView.zoom;
    let currentZoom = targetZoom;
    const targetQuaternion = spatialOrientationQuaternion(orientationRef.current);
    const currentQuaternion = targetQuaternion.clone();
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const projectionPoint = new THREE.Vector3();
    const projectionEdge = new THREE.Vector3();
    const cameraSpacePoint = new THREE.Vector3();
    const cardCenter = new THREE.Vector3();
    const markerPoint = new THREE.Vector3();
    const cameraRight = new THREE.Vector3();
    const cameraUp = new THREE.Vector3();
    const cameraForward = new THREE.Vector3();
    const panRight = new THREE.Vector3();
    const panUp = new THREE.Vector3();
    const depthVector = new THREE.Vector3();
    const yawQuaternion = new THREE.Quaternion();
    const pitchQuaternion = new THREE.Quaternion();
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
    let frame = 0;
    let previousTime = 0;
    let settleDeadline = 0;
    let initialized = false;
    let draggingPointerId: number | null = null;
    let dragMode: DragMode | null = null;
    let dragX = 0;
    let dragY = 0;
    let dragged = false;

    const syncPersistentView = (): void => {
      persistentView.focus.copy(targetFocus);
      persistentView.zoom = targetZoom;
      persistentView.initialized = true;
    };

    const homeView = (): { readonly focus: THREE.Vector3; readonly zoom: number } => {
      const viewportWidth = Math.max(1, root.clientWidth - 190);
      const viewportHeight = Math.max(1, root.clientHeight - 130);
      return {
        focus: new THREE.Vector3(
          (layout.bounds.left + layout.bounds.right) / 2,
          -(layout.bounds.top + layout.bounds.bottom) / 2,
          firstCard?.z ?? 0,
        ),
        zoom: clampZoom(Math.min(viewportWidth / boundsWidth, viewportHeight / boundsHeight, 0.82)),
      };
    };

    const setAnimating = (animating: boolean): void => {
      root.dataset.spatialAnimating = String(animating);
      for (const element of elementsRef.current.values()) {
        if (animating) element.style.willChange = "transform";
        else element.style.removeProperty("will-change");
      }
    };

    const updateMinimap = (width: number, height: number): void => {
      const viewport = minimapViewportRef.current;
      if (!viewport) return;
      const worldWidth = width / currentZoom;
      const worldHeight = height / currentZoom;
      const projectCoordinate = semanticCoordinate(currentFocus, "project");
      const left = ((currentFocus.x - worldWidth / 2 - layout.bounds.left) / boundsWidth) * 100;
      const top = ((projectCoordinate - worldHeight / 2 - layout.bounds.top) / boundsHeight) * 100;
      viewport.style.left = `${left}%`;
      viewport.style.top = `${top}%`;
      viewport.style.width = `${Math.min(100, (worldWidth / boundsWidth) * 100)}%`;
      viewport.style.height = `${Math.min(100, (worldHeight / boundsHeight) * 100)}%`;
    };

    const projectMarker = (
      axis: SemanticAxis,
      marker: SemanticMarker,
      width: number,
      height: number,
    ): { readonly x: number; readonly y: number } => {
      markerPoint.copy(currentFocus);
      setSemanticCoordinate(markerPoint, axis, marker.position);
      markerPoint.project(camera);
      return {
        x: (markerPoint.x * 0.5 + 0.5) * width,
        y: (-markerPoint.y * 0.5 + 0.5) * height,
      };
    };

    const renderScene = (): void => {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      const focalDistance = height / (2 * currentZoom * tanHalfFov);
      camera.aspect = width / height;
      camera.quaternion.copy(currentQuaternion);
      cameraForward.set(0, 0, -1).applyQuaternion(currentQuaternion).normalize();
      cameraRight.set(1, 0, 0).applyQuaternion(currentQuaternion).normalize();
      camera.position.copy(currentFocus).addScaledVector(cameraForward, -focalDistance);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      const activeAxis = orientationRef.current.depth.axis;
      const activeMarkers = layout.markers[activeAxis];
      const activeMarker = nearestMarker(
        activeMarkers,
        semanticCoordinate(currentFocus, activeAxis),
      );

      for (const card of layout.cards) {
        const element = elementsRef.current.get(card.key);
        if (!element) continue;
        cardCenter.set(card.centerX, -card.centerY, card.z);
        cameraSpacePoint.copy(cardCenter).applyMatrix4(camera.matrixWorldInverse);
        projectionPoint.copy(cardCenter).project(camera);
        projectionEdge
          .copy(cardCenter)
          .addScaledVector(cameraRight, CARD_WIDTH / 2)
          .project(camera);
        const scale =
          (Math.abs(projectionEdge.x - projectionPoint.x) * width) / Math.max(1, CARD_WIDTH);
        const screenCenterX = (projectionPoint.x * 0.5 + 0.5) * width;
        const screenCenterY = (-projectionPoint.y * 0.5 + 0.5) * height;
        const screenX = screenCenterX - (CARD_WIDTH * scale) / 2;
        const screenY = screenCenterY - (CARD_HEIGHT * scale) / 2;
        const visible =
          cameraSpacePoint.z < -camera.near &&
          cameraSpacePoint.z > -camera.far &&
          projectionPoint.z >= -1 &&
          projectionPoint.z <= 1 &&
          Number.isFinite(scale) &&
          scale > 0 &&
          screenX < width + 240 &&
          screenX + CARD_WIDTH * scale > -240 &&
          screenY < height + 240 &&
          screenY + CARD_HEIGHT * scale > -240;
        if (!visible) {
          element.style.visibility = "hidden";
          element.style.pointerEvents = "none";
          continue;
        }

        const active = cardMarkerId(card, activeAxis) === activeMarker?.id;
        element.style.visibility = "visible";
        element.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) scale(${scale})`;
        element.style.opacity = "1";
        element.style.zIndex = String(
          THREE.MathUtils.clamp(Math.round(100_000 + cameraSpacePoint.z * 10), 1, 99_999),
        );
        // Every visible card remains live HTML. Camera-distance z-order resolves
        // overlaps, so a card does not become mysteriously inert just because
        // the focal point is currently nearest another semantic plane.
        element.style.pointerEvents = "auto";
        element.dataset.spatialActive = String(active);
      }

      const horizontalAxis = orientationRef.current.right.axis;
      for (const marker of layout.markers[horizontalAxis]) {
        const element = horizontalMarkerRefs.current.get(marker.id);
        if (!element) continue;
        const screen = projectMarker(horizontalAxis, marker, width, height);
        element.style.transform = `translate3d(${screen.x}px, 0, 0) translateX(-50%)`;
        element.style.opacity = screen.x < -120 || screen.x > width + 120 ? "0" : "1";
      }
      const verticalAxis = orientationRef.current.up.axis;
      for (const marker of layout.markers[verticalAxis]) {
        const element = verticalMarkerRefs.current.get(marker.id);
        if (!element) continue;
        const screen = projectMarker(verticalAxis, marker, width, height);
        element.style.transform = `translate3d(0, ${screen.y}px, 0) translateY(-50%)`;
        element.style.opacity = screen.y < -80 || screen.y > height + 80 ? "0" : "1";
      }

      const depthMarkers = orderedDepthMarkers(layout, orientationRef.current);
      const activeDepthIndex = Math.max(
        0,
        depthMarkers.findIndex((marker) => marker.id === activeMarker?.id),
      );
      for (const marker of depthMarkers) {
        const element = depthMarkerRefs.current.get(marker.id);
        if (!element) continue;
        const active = marker.id === activeMarker?.id;
        element.dataset.active = String(active);
        element.setAttribute("aria-current", active ? "step" : "false");
      }
      if (depthLabelRef.current) depthLabelRef.current.textContent = activeMarker?.label ?? "Depth";
      if (depthRangeRef.current) depthRangeRef.current.value = String(activeDepthIndex);
      root.dataset.spatialOrientation = spatialOrientationKey(orientationRef.current);
      root.dataset.spatialHorizontalAxis = horizontalAxis;
      root.dataset.spatialVerticalAxis = verticalAxis;
      root.dataset.spatialDepthAxis = activeAxis;
      root.dataset.spatialActiveDepth = activeMarker?.id ?? "";
      updateMinimap(width, height);
      renderer.render(scene, camera);
      root.dataset.spatialReady = "true";
    };

    const schedule = (fromInput = true): void => {
      if (fromInput) settleDeadline = performance.now() + 700;
      if (frame !== 0) return;
      if (root.dataset.spatialAnimating !== "true") setAnimating(true);
      frame = window.requestAnimationFrame(tick);
    };

    function tick(time: number): void {
      frame = 0;
      const dt = Math.min(0.1, Math.max(0.001, (time - (previousTime || time - 16)) / 1_000));
      previousTime = time;
      const follow =
        prefersReducedMotion || time >= settleDeadline ? 1 : 1 - Math.exp(-dt / CAMERA_TAU_SECONDS);
      currentFocus.lerp(targetFocus, follow);
      currentZoom += (targetZoom - currentZoom) * follow;
      currentQuaternion.slerp(targetQuaternion, follow).normalize();
      renderScene();

      const unsettled =
        currentFocus.distanceTo(targetFocus) > CAMERA_EPSILON ||
        Math.abs(targetZoom - currentZoom) > 0.0002 ||
        currentQuaternion.angleTo(targetQuaternion) > ORIENTATION_EPSILON;
      if (unsettled) schedule(false);
      else {
        currentFocus.copy(targetFocus);
        currentZoom = targetZoom;
        currentQuaternion.copy(targetQuaternion);
        renderScene();
        setAnimating(false);
      }
    }

    const commitTarget = (): void => {
      syncPersistentView();
      schedule();
    };

    const setOrientationTarget = (next: SpatialOrientation): void => {
      orientationRef.current = next;
      targetQuaternion.copy(spatialOrientationQuaternion(next));
      setOrientation(next);
      schedule();
    };

    const rotate = (rotation: SpatialRotation): void => {
      setOrientationTarget(rotateSpatialOrientation(orientationRef.current, rotation));
    };

    const focusMarker = (axis: SemanticAxis, markerId: string): void => {
      const marker = layout.markers[axis].find((candidate) => candidate.id === markerId);
      if (!marker) return;
      setSemanticCoordinate(targetFocus, axis, marker.position);
      commitTarget();
    };

    const depthBy = (amount: number): void => {
      const markers = orderedDepthMarkers(layout, orientationRef.current);
      if (markers.length === 0) return;
      const coordinate = semanticCoordinate(targetFocus, orientationRef.current.depth.axis);
      const active = nearestMarker(markers, coordinate);
      const activeIndex = Math.max(
        0,
        markers.findIndex((marker) => marker.id === active?.id),
      );
      const nextIndex = THREE.MathUtils.clamp(
        Math.round(activeIndex + amount),
        0,
        markers.length - 1,
      );
      const marker = markers[nextIndex];
      if (marker) focusMarker(orientationRef.current.depth.axis, marker.id);
    };

    const resetOrientation = (): void => {
      setOrientationTarget(HOME_SPATIAL_ORIENTATION);
    };

    const reset = (): void => {
      const focusStore = useBoardFocusStore.getState();
      if (focusStore.request) {
        focusStore.clearRequest(focusStore.request.threadKey, focusStore.request.nonce);
      }
      focusStore.setFocused(null);
      const home = homeView();
      targetFocus.copy(home.focus);
      targetZoom = home.zoom;
      syncPersistentView();
      setOrientationTarget(HOME_SPATIAL_ORIENTATION);
    };

    const focusCard = (cardKey: string): void => {
      const card = layout.byKey.get(cardKey);
      if (!card) return;
      targetFocus.set(card.centerX, -card.centerY, card.z);
      targetZoom = THREE.MathUtils.clamp(targetZoom, 0.74, 0.86);
      commitTarget();
    };

    controllerRef.current = {
      focusCard,
      focusMarker,
      reset,
      resetOrientation,
      rotate,
      setDepthIndex: (index) => {
        const marker = orderedDepthMarkers(layout, orientationRef.current)[Math.round(index)];
        if (marker) focusMarker(orientationRef.current.depth.axis, marker.id);
      },
      depthBy,
    };

    const resize = (): void => {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      renderer.setSize(width, height, false);
      if (!initialized) {
        initialized = true;
        if (!persistentView.initialized) {
          if (firstCard) {
            targetFocus.set(firstCard.centerX, -firstCard.centerY, firstCard.z);
            targetZoom = 0.78;
          } else {
            const home = homeView();
            targetFocus.copy(home.focus);
            targetZoom = home.zoom;
          }
          syncPersistentView();
        }
        currentFocus.copy(targetFocus);
        currentZoom = targetZoom;
      }
      renderScene();
      setAnimating(false);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || isHudTarget(event.target) || isEditableTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-spatial-session-card]")) {
        return;
      }
      draggingPointerId = event.pointerId;
      dragMode = event.altKey ? "rotate" : "pan";
      dragX = event.clientX;
      dragY = event.clientY;
      dragged = false;
      root.setPointerCapture(event.pointerId);
      root.dataset.spatialDragging = dragMode;
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (draggingPointerId !== event.pointerId || dragMode === null) return;
      const deltaX = event.clientX - dragX;
      const deltaY = event.clientY - dragY;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 4) dragged = true;
      if (dragMode === "pan") {
        signedSemanticAxisVector(orientationRef.current.right, panRight);
        signedSemanticAxisVector(orientationRef.current.up, panUp);
        targetFocus
          .addScaledVector(panRight, -deltaX / currentZoom)
          .addScaledVector(panUp, deltaY / currentZoom);
        syncPersistentView();
      } else {
        cameraUp.set(0, 1, 0).applyQuaternion(targetQuaternion).normalize();
        yawQuaternion.setFromAxisAngle(cameraUp, -deltaX * ROTATE_RADIANS_PER_PIXEL);
        targetQuaternion.premultiply(yawQuaternion).normalize();
        cameraRight.set(1, 0, 0).applyQuaternion(targetQuaternion).normalize();
        pitchQuaternion.setFromAxisAngle(cameraRight, -deltaY * ROTATE_RADIANS_PER_PIXEL);
        targetQuaternion.premultiply(pitchQuaternion).normalize();
      }
      dragX = event.clientX;
      dragY = event.clientY;
      schedule();
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (draggingPointerId !== event.pointerId) return;
      if (dragMode === "rotate") {
        setOrientationTarget(nearestSpatialOrientation(targetQuaternion));
      } else if (!dragged) {
        useBoardFocusStore.getState().setFocused(null);
      }
      draggingPointerId = null;
      dragMode = null;
      delete root.dataset.spatialDragging;
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    };

    const onWheel = (event: WheelEvent): void => {
      if (isHudTarget(event.target)) return;
      const card =
        event.target instanceof Element
          ? event.target.closest("[data-spatial-session-card]")
          : null;
      if (card && !event.ctrlKey && scrollableAncestor(event.target, card)) return;
      event.preventDefault();
      const delta = normalizedWheelDelta(event);
      if (event.ctrlKey) {
        const depthAxis = orientationRef.current.depth;
        const markers = layout.markers[depthAxis.axis];
        if (markers.length === 0) return;
        const stride = markerSpacing(markers);
        signedSemanticAxisVector(depthAxis, depthVector);
        targetFocus.addScaledVector(depthVector, -delta.y * PINCH_DEPTH_PER_PIXEL * stride);
        const minimum = Math.min(...markers.map((marker) => marker.position));
        const maximum = Math.max(...markers.map((marker) => marker.position));
        const coordinate = THREE.MathUtils.clamp(
          semanticCoordinate(targetFocus, depthAxis.axis),
          minimum,
          maximum,
        );
        setSemanticCoordinate(targetFocus, depthAxis.axis, coordinate);
        commitTarget();
        return;
      }
      const horizontal = event.shiftKey && Math.abs(delta.x) < 0.5 ? delta.y : delta.x;
      const vertical = event.shiftKey && Math.abs(delta.x) < 0.5 ? 0 : delta.y;
      signedSemanticAxisVector(orientationRef.current.right, panRight);
      signedSemanticAxisVector(orientationRef.current.up, panUp);
      targetFocus
        .addScaledVector(panRight, horizontal / currentZoom)
        .addScaledVector(panUp, -vertical / currentZoom);
      commitTarget();
    };

    const onDoubleClick = (event: MouseEvent): void => {
      if (isHudTarget(event.target)) return;
      const interactive =
        event.target instanceof Element &&
        event.target.closest("button, a, input, textarea, select, [contenteditable='true']");
      if (interactive) return;
      const card =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-spatial-session-card]")
          : null;
      const cardKey = card?.dataset.spatialSessionCard;
      if (!cardKey) return;
      useBoardFocusStore.getState().setExpanded({ kind: "thread", threadKey: cardKey });
    };

    const panByKey = (horizontal: number, vertical: number): void => {
      signedSemanticAxisVector(orientationRef.current.right, panRight);
      signedSemanticAxisVector(orientationRef.current.up, panUp);
      targetFocus.addScaledVector(panRight, horizontal).addScaledVector(panUp, vertical);
      commitTarget();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      const activeCard =
        document.activeElement instanceof Element
          ? document.activeElement.closest<HTMLElement>("[data-spatial-session-card]")
          : null;
      if (event.key === "Enter" && activeCard?.dataset.spatialSessionCard) {
        useBoardFocusStore.getState().setExpanded({
          kind: "thread",
          threadKey: activeCard.dataset.spatialSessionCard,
        });
      } else if (event.key === "Escape") {
        const store = useBoardFocusStore.getState();
        if (store.expandedTarget) store.setExpanded(null);
        else store.setFocused(null);
      } else if (event.altKey && event.key === "ArrowLeft") rotate("yaw-left");
      else if (event.altKey && event.key === "ArrowRight") rotate("yaw-right");
      else if (event.altKey && event.key === "ArrowUp") rotate("pitch-up");
      else if (event.altKey && event.key === "ArrowDown") rotate("pitch-down");
      else if (event.key === "Home" || event.key === "0") reset();
      else if (event.key === "+" || event.key === "=" || event.key === "PageDown") depthBy(1);
      else if (event.key === "-" || event.key === "_" || event.key === "PageUp") depthBy(-1);
      else if (event.key.toLowerCase() === "e") depthBy(1);
      else if (event.key.toLowerCase() === "q") depthBy(-1);
      else if (event.key === "ArrowLeft") panByKey(event.shiftKey ? -320 : -110, 0);
      else if (event.key === "ArrowRight") panByKey(event.shiftKey ? 320 : 110, 0);
      else if (event.key === "ArrowUp") panByKey(0, event.shiftKey ? 320 : 110);
      else if (event.key === "ArrowDown") panByKey(0, event.shiftKey ? -320 : -110);
      else return;
      event.preventDefault();
      schedule();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(root);
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("pointercancel", onPointerUp);
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    resize();

    return () => {
      syncPersistentView();
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerUp);
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      controllerRef.current = null;
      delete root.dataset.spatialReady;
      delete root.dataset.spatialAnimating;
      delete root.dataset.spatialDragging;
      delete root.dataset.spatialOrientation;
      delete root.dataset.spatialHorizontalAxis;
      delete root.dataset.spatialVerticalAxis;
      delete root.dataset.spatialDepthAxis;
      delete root.dataset.spatialActiveDepth;
      for (const depthGrid of depthGrids) {
        depthGrid.grid.geometry.dispose();
        for (const material of depthGrid.materials) material.dispose();
      }
      volumeGeometry.dispose();
      volumeMaterial.dispose();
      renderer.dispose();
      for (const element of elementsRef.current.values()) {
        element.style.removeProperty("transform");
        element.style.removeProperty("opacity");
        element.style.removeProperty("visibility");
        element.style.removeProperty("pointer-events");
        element.style.removeProperty("z-index");
        element.style.removeProperty("will-change");
        delete element.dataset.spatialActive;
      }
    };
  }, [layout]);

  useEffect(() => {
    if (focusedThreadKey) controllerRef.current?.focusCard(focusedThreadKey);
  }, [focusedThreadKey]);

  useEffect(() => {
    if (!focusRequest) return;
    useBoardFocusStore.getState().setFocused(focusRequest.threadKey);
    controllerRef.current?.focusCard(focusRequest.threadKey);
  }, [focusRequest]);

  const minimapCardStyles = useMemo(() => {
    const width = layout.bounds.right - layout.bounds.left;
    const height = layout.bounds.bottom - layout.bounds.top;
    return new Map<string, CSSProperties>(
      layout.cards.map((card) => [
        card.key,
        {
          left: `${((card.x - layout.bounds.left) / width) * 100}%`,
          top: `${((card.y - layout.bounds.top) / height) * 100}%`,
          width: `${Math.max(1.5, (CARD_WIDTH / width) * 100)}%`,
          height: `${Math.max(1.5, (CARD_HEIGHT / height) * 100)}%`,
          opacity: 0.35,
        },
      ]),
    );
  }, [layout]);

  const horizontalMarkers = layout.markers[orientation.right.axis];
  const verticalMarkers = layout.markers[orientation.up.axis];
  const depthMarkers = orderedDepthMarkers(layout, orientation);

  return (
    <div
      ref={rootRef}
      data-spatial-scene
      className="relative isolate min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_50%_42%,color-mix(in_srgb,var(--muted)_52%,transparent),var(--background)_68%)] outline-none data-[spatial-dragging=pan]:cursor-grabbing data-[spatial-dragging=rotate]:cursor-move"
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 block h-full w-full"
      />

      <div className="absolute inset-0 z-10 overflow-hidden">
        {sessions.map((session) => (
          <div
            key={session.cardKey}
            ref={(element) => {
              if (element) elementsRef.current.set(session.cardKey, element);
              else elementsRef.current.delete(session.cardKey);
            }}
            data-spatial-session-card={session.cardKey}
            data-spatial-state={session.boardStateId}
            className="absolute left-0 top-0 w-[380px] origin-top-left transform-gpu contain-layout contain-paint"
            style={{ opacity: 0 }}
          >
            {children(session)}
          </div>
        ))}
      </div>

      <div
        data-spatial-hud
        className="pointer-events-none absolute inset-x-0 top-0 z-30 h-9 overflow-hidden border-b border-border/70 bg-background/88 pl-24 shadow-sm backdrop-blur"
        aria-label={`${semanticAxisLabel(orientation.right.axis)} horizontal axis`}
      >
        {horizontalMarkers.map((marker) => (
          <button
            key={marker.id}
            ref={(element) => {
              if (element) horizontalMarkerRefs.current.set(marker.id, element);
              else horizontalMarkerRefs.current.delete(marker.id);
            }}
            type="button"
            className="pointer-events-auto absolute top-1/2 max-w-40 -translate-y-1/2 truncate rounded-md border border-border/70 bg-background px-2 py-1 text-[10px] font-medium shadow-sm transition-colors hover:bg-accent"
            onClick={() => controllerRef.current?.focusMarker(orientation.right.axis, marker.id)}
            title={`${semanticAxisLabel(orientation.right.axis)}: ${marker.label}`}
          >
            {marker.label}
          </button>
        ))}
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {semanticAxisLabel(orientation.right.axis)}{" "}
          {roleDirectionGlyph("horizontal", orientation.right)}
        </span>
      </div>

      <div
        data-spatial-hud
        className="pointer-events-none absolute inset-y-9 left-0 z-30 w-24 overflow-hidden border-r border-border/70 bg-background/88 shadow-sm backdrop-blur"
        aria-label={`${semanticAxisLabel(orientation.up.axis)} vertical axis`}
      >
        {verticalMarkers.map((marker) => (
          <button
            key={marker.id}
            ref={(element) => {
              if (element) verticalMarkerRefs.current.set(marker.id, element);
              else verticalMarkerRefs.current.delete(marker.id);
            }}
            type="button"
            className="pointer-events-auto absolute left-1 w-[5.5rem] truncate rounded-md border border-border/70 bg-background px-1.5 py-1 text-left text-[9px] font-medium shadow-sm transition-colors hover:bg-accent"
            onClick={() => controllerRef.current?.focusMarker(orientation.up.axis, marker.id)}
            title={`${semanticAxisLabel(orientation.up.axis)}: ${marker.label}`}
          >
            {marker.label}
          </button>
        ))}
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 -rotate-90 whitespace-nowrap text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {semanticAxisLabel(orientation.up.axis)} {roleDirectionGlyph("vertical", orientation.up)}
        </span>
      </div>

      <div className="absolute left-28 top-12 z-50">
        <SpatialOrientationHud
          orientation={orientation}
          onRotateLeft={() => controllerRef.current?.rotate("yaw-left")}
          onRotateRight={() => controllerRef.current?.rotate("yaw-right")}
          onRotateUp={() => controllerRef.current?.rotate("pitch-up")}
          onRotateDown={() => controllerRef.current?.rotate("pitch-down")}
          onResetOrientation={() => controllerRef.current?.resetOrientation()}
        />
      </div>

      <div
        data-spatial-hud
        className="absolute right-4 top-1/2 z-40 w-36 -translate-y-1/2 rounded-xl border border-border bg-background/92 p-2 shadow-lg backdrop-blur"
        aria-label={`${semanticAxisLabel(orientation.depth.axis)} depth axis`}
      >
        <div className="mb-1.5 flex items-center text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          {semanticAxisLabel(orientation.depth.axis)} · Depth
          <span className="ml-auto normal-case tracking-normal">
            {orientation.depth.direction === 1 ? "near → far" : "far ← near"}
          </span>
        </div>
        <div className="relative space-y-1 before:absolute before:bottom-3 before:left-[7px] before:top-3 before:w-px before:bg-border">
          {depthMarkers.map((marker) => (
            <button
              key={marker.id}
              ref={(element) => {
                if (element) depthMarkerRefs.current.set(marker.id, element);
                else depthMarkerRefs.current.delete(marker.id);
              }}
              type="button"
              data-active="false"
              className="relative flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[9px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[active=true]:bg-primary/10 data-[active=true]:font-medium data-[active=true]:text-foreground"
              onClick={() => controllerRef.current?.focusMarker(orientation.depth.axis, marker.id)}
            >
              <span className="relative z-10 size-2 rounded-full border border-border bg-background" />
              <span className="min-w-0 flex-1 truncate">{marker.label}</span>
              <span className="tabular-nums opacity-65">{marker.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        data-spatial-hud
        className="absolute bottom-4 right-4 z-40 w-44 rounded-xl border border-border bg-background/92 p-2 shadow-lg backdrop-blur"
      >
        <div className="mb-2 flex items-center gap-1">
          <span className="text-[10px] font-medium">Workflow × project map</span>
          <span
            ref={depthLabelRef}
            className="ml-auto max-w-16 truncate text-[10px] font-medium text-muted-foreground"
          >
            Depth
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Move toward nearer depth marker"
            onClick={() => controllerRef.current?.depthBy(-1)}
          >
            <MinusIcon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Move toward farther depth marker"
            onClick={() => controllerRef.current?.depthBy(1)}
          >
            <PlusIcon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Fit spatial board"
            onClick={() => controllerRef.current?.reset()}
          >
            <LocateFixedIcon className="size-3" />
          </Button>
        </div>
        <div className="relative h-20 overflow-hidden rounded-md border border-border/70 bg-muted/45">
          {layout.cards.map((card) => (
            <div
              key={card.key}
              className="absolute rounded-[1px] bg-foreground/35"
              style={minimapCardStyles.get(card.key)}
            />
          ))}
          <div
            ref={minimapViewportRef}
            className="absolute min-h-2 min-w-2 rounded-[2px] border border-primary bg-primary/10"
          />
        </div>
        <input
          ref={depthRangeRef}
          className="mt-2 h-1 w-full accent-primary"
          type="range"
          min={0}
          max={Math.max(0, depthMarkers.length - 1)}
          step={1}
          defaultValue={0}
          aria-label={`${semanticAxisLabel(orientation.depth.axis)} depth`}
          onInput={(event) =>
            controllerRef.current?.setDepthIndex(Number(event.currentTarget.value))
          }
        />
        <div className="mt-1 flex justify-between text-[8px] uppercase tracking-wide text-muted-foreground">
          <span>Near</span>
          <span>{semanticAxisLabel(orientation.depth.axis)} depth</span>
          <span>Far</span>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center pr-48">
        <div className="rounded-full border border-border bg-background/88 px-3 py-1.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
          Scroll X/Y · pinch depth · drag empty to pan · Alt-drag empty to rotate · double-click a
          card to open
        </div>
      </div>
    </div>
  );
}
