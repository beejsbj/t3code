import { LocateFixedIcon, MinusIcon, PlusIcon } from "lucide-react";
import * as THREE from "three";
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";

import { useBoardFocusStore } from "../../board/boardFocusStore.ts";
import { BOARD_STATES } from "../../board/boardOrganization.ts";
import { Button } from "../ui/button.tsx";
import type { SpatialBoardSession } from "./SpatialBoardPrototype.tsx";

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
  readonly depthIndex: number;
}

interface AxisMarker {
  readonly id: string;
  readonly label: string;
  readonly position: number;
}

interface StateMarker {
  readonly id: string;
  readonly label: string;
  readonly index: number;
  readonly count: number;
}

interface SpatialLayout {
  readonly key: string;
  readonly cards: ReadonlyArray<LayoutCard>;
  readonly byKey: ReadonlyMap<string, LayoutCard>;
  readonly lanes: ReadonlyArray<AxisMarker>;
  readonly projects: ReadonlyArray<AxisMarker>;
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
  readonly focusLane: (laneId: string) => void;
  readonly focusProject: (projectTitle: string) => void;
  readonly reset: () => void;
  readonly setDepth: (depth: number) => void;
  readonly depthBy: (amount: number) => void;
}

interface CameraPoint {
  x: number;
  y: number;
  depth: number;
  zoom: number;
}

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
const DEPTH_EPSILON = 0.001;

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
      depthIndex,
    });
  }

  const width = Math.max(CARD_WIDTH, lanes.length * columnStride - COLUMN_GAP);
  const height = Math.max(CARD_HEIGHT, nextTop - ROW_GAP);
  const laneMarkers = lanes.map(([id, label], index) => ({
    id,
    label,
    position: index * columnStride + CARD_WIDTH / 2,
  }));
  const projectMarkers = projects.map((project, index) => ({
    id: project,
    label: project,
    position: (rowTops[index] ?? 0) + (rowHeights[index] ?? CARD_HEIGHT) / 2,
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
    lanes: laneMarkers,
    projects: projectMarkers,
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

export function SpatialSessionScene({
  sessions,
  children,
}: SpatialSessionSceneProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const elementsRef = useRef(new Map<string, HTMLDivElement>());
  const laneMarkerRefs = useRef(new Map<string, HTMLButtonElement>());
  const projectMarkerRefs = useRef(new Map<string, HTMLButtonElement>());
  const stateMarkerRefs = useRef(new Map<string, HTMLButtonElement>());
  const minimapViewportRef = useRef<HTMLDivElement | null>(null);
  const depthLabelRef = useRef<HTMLSpanElement | null>(null);
  const depthRangeRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
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
    if (!root || !canvas || layout.cards.length === 0) return;

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
      return { index: state.index, grid, materials };
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

    const maxDepth = Math.max(0, layout.states.length - 1);
    const firstCard = layout.cards[0];
    const initialDepth = firstCard?.depthIndex ?? 0;
    const target: CameraPoint = { x: 0, y: 0, depth: initialDepth, zoom: 0.78 };
    const current: CameraPoint = { ...target };
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const projectionPoint = new THREE.Vector3();
    const projectionRight = new THREE.Vector3();
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
    let frame = 0;
    let previousTime = 0;
    let settleDeadline = 0;
    let initialized = false;
    let draggingPointerId: number | null = null;
    let dragX = 0;
    let dragY = 0;
    let dragged = false;

    const clampDepth = (depth: number): number => THREE.MathUtils.clamp(depth, 0, maxDepth);

    const homeCamera = (): CameraPoint => {
      const viewportWidth = Math.max(1, root.clientWidth - 190);
      const viewportHeight = Math.max(1, root.clientHeight - 130);
      return {
        x: (layout.bounds.left + layout.bounds.right) / 2,
        y: (layout.bounds.top + layout.bounds.bottom) / 2,
        depth: initialDepth,
        zoom: clampZoom(Math.min(viewportWidth / boundsWidth, viewportHeight / boundsHeight, 0.82)),
      };
    };

    const setAnimating = (animating: boolean): void => {
      root.dataset.spatialAnimating = String(animating);
      for (const element of elementsRef.current.values()) {
        if (animating) element.style.willChange = "transform, opacity";
        else element.style.removeProperty("will-change");
      }
    };

    const updateMinimap = (width: number, height: number): void => {
      const viewport = minimapViewportRef.current;
      if (!viewport) return;
      const worldWidth = width / current.zoom;
      const worldHeight = height / current.zoom;
      const left = ((current.x - worldWidth / 2 - layout.bounds.left) / boundsWidth) * 100;
      const top = ((current.y - worldHeight / 2 - layout.bounds.top) / boundsHeight) * 100;
      viewport.style.left = `${left}%`;
      viewport.style.top = `${top}%`;
      viewport.style.width = `${Math.min(100, (worldWidth / boundsWidth) * 100)}%`;
      viewport.style.height = `${Math.min(100, (worldHeight / boundsHeight) * 100)}%`;
    };

    const renderScene = (): void => {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      const focalDistance = height / (2 * current.zoom * tanHalfFov);
      camera.aspect = width / height;
      camera.position.set(current.x, -current.y, planeZ(current.depth) + focalDistance);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const activeDepth = Math.round(current.depth);

      for (const card of layout.cards) {
        const element = elementsRef.current.get(card.key);
        if (!element) continue;
        const depthDelta = card.depthIndex - current.depth;
        const cameraDistance = camera.position.z - card.z;
        const visible = cameraDistance > camera.near && depthDelta > -1.15 && depthDelta < 5.75;
        if (!visible) {
          element.style.visibility = "hidden";
          element.style.pointerEvents = "none";
          continue;
        }

        projectionPoint.set(card.x, -card.y, card.z).project(camera);
        projectionRight.set(card.x + CARD_WIDTH, -card.y, card.z).project(camera);
        const screenX = (projectionPoint.x * 0.5 + 0.5) * width;
        const screenY = (-projectionPoint.y * 0.5 + 0.5) * height;
        const scale = ((projectionRight.x - projectionPoint.x) * width * 0.5) / CARD_WIDTH;
        const opacity =
          depthDelta < 0
            ? THREE.MathUtils.clamp(1 + depthDelta * 0.84, 0.08, 1)
            : THREE.MathUtils.clamp(Math.exp(-depthDelta * 0.42), 0.1, 1);
        element.style.visibility = "visible";
        element.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) scale(${scale})`;
        element.style.opacity = String(opacity);
        element.style.zIndex = String(2_000 - card.depthIndex);
        element.style.pointerEvents = card.depthIndex === activeDepth ? "auto" : "none";
        element.dataset.spatialActive = String(card.depthIndex === activeDepth);
      }

      for (const marker of layout.lanes) {
        const element = laneMarkerRefs.current.get(marker.id);
        if (!element) continue;
        const screenX = width / 2 + (marker.position - current.x) * current.zoom;
        element.style.transform = `translate3d(${screenX}px, 0, 0) translateX(-50%)`;
        element.style.opacity = screenX < -120 || screenX > width + 120 ? "0" : "1";
      }
      for (const marker of layout.projects) {
        const element = projectMarkerRefs.current.get(marker.id);
        if (!element) continue;
        const screenY = height / 2 + (marker.position - current.y) * current.zoom;
        element.style.transform = `translate3d(0, ${screenY}px, 0) translateY(-50%)`;
        element.style.opacity = screenY < -80 || screenY > height + 80 ? "0" : "1";
      }

      const activeState = layout.states[activeDepth] ?? layout.states[0];
      for (const state of layout.states) {
        const element = stateMarkerRefs.current.get(state.id);
        if (!element) continue;
        element.dataset.active = String(state.index === activeDepth);
        element.setAttribute("aria-current", state.index === activeDepth ? "step" : "false");
      }
      for (const depthGrid of depthGrids) {
        const delta = depthGrid.index - current.depth;
        const opacity =
          delta < -1.15 || delta > 6
            ? 0
            : delta < 0
              ? THREE.MathUtils.clamp(0.22 + delta * 0.16, 0.025, 0.22)
              : THREE.MathUtils.clamp(0.22 * Math.exp(-delta * 0.38), 0.025, 0.22);
        for (const material of depthGrid.materials) material.opacity = opacity;
      }

      if (depthLabelRef.current) depthLabelRef.current.textContent = activeState?.label ?? "State";
      if (depthRangeRef.current) depthRangeRef.current.value = current.depth.toFixed(3);
      root.dataset.spatialDepth = current.depth.toFixed(3);
      root.dataset.spatialState = activeState?.id ?? "";
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
      current.x += (target.x - current.x) * follow;
      current.y += (target.y - current.y) * follow;
      current.depth += (target.depth - current.depth) * follow;
      current.zoom += (target.zoom - current.zoom) * follow;
      renderScene();

      const unsettled =
        Math.abs(target.x - current.x) > CAMERA_EPSILON ||
        Math.abs(target.y - current.y) > CAMERA_EPSILON ||
        Math.abs(target.depth - current.depth) > DEPTH_EPSILON ||
        Math.abs(target.zoom - current.zoom) > 0.0002;
      if (unsettled) schedule(false);
      else {
        Object.assign(current, target);
        renderScene();
        setAnimating(false);
      }
    }

    const setTargetDepth = (depth: number): void => {
      target.depth = clampDepth(depth);
      schedule();
    };

    const reset = (): void => {
      const focusStore = useBoardFocusStore.getState();
      if (focusStore.request) {
        focusStore.clearRequest(focusStore.request.threadKey, focusStore.request.nonce);
      }
      focusStore.setFocused(null);
      Object.assign(target, homeCamera());
      schedule();
    };

    const focusCard = (cardKey: string): void => {
      const card = layout.byKey.get(cardKey);
      if (!card) return;
      target.x = card.centerX;
      target.y = card.centerY;
      target.depth = card.depthIndex;
      target.zoom = THREE.MathUtils.clamp(target.zoom, 0.74, 0.86);
      schedule();
    };

    controllerRef.current = {
      focusCard,
      focusLane: (laneId) => {
        const marker = layout.lanes.find((candidate) => candidate.id === laneId);
        if (!marker) return;
        target.x = marker.position;
        schedule();
      },
      focusProject: (projectTitle) => {
        const marker = layout.projects.find((candidate) => candidate.id === projectTitle);
        if (!marker) return;
        target.y = marker.position;
        schedule();
      },
      reset,
      setDepth: setTargetDepth,
      depthBy: (amount) => setTargetDepth(target.depth + amount),
    };

    const resize = (): void => {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      renderer.setSize(width, height, false);
      if (!initialized) {
        initialized = true;
        Object.assign(
          target,
          firstCard
            ? {
                x: firstCard.centerX,
                y: firstCard.centerY,
                depth: firstCard.depthIndex,
                zoom: 0.78,
              }
            : homeCamera(),
        );
        Object.assign(current, target);
      }
      renderScene();
      setAnimating(false);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || isHudTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-spatial-session-card]")) {
        return;
      }
      draggingPointerId = event.pointerId;
      dragX = event.clientX;
      dragY = event.clientY;
      dragged = false;
      root.setPointerCapture(event.pointerId);
      root.dataset.spatialDragging = "true";
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (draggingPointerId !== event.pointerId) return;
      const deltaX = event.clientX - dragX;
      const deltaY = event.clientY - dragY;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 4) dragged = true;
      target.x -= deltaX / current.zoom;
      target.y -= deltaY / current.zoom;
      dragX = event.clientX;
      dragY = event.clientY;
      schedule();
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (draggingPointerId !== event.pointerId) return;
      if (!dragged) useBoardFocusStore.getState().setFocused(null);
      draggingPointerId = null;
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
        setTargetDepth(target.depth - delta.y * 0.006);
        return;
      }
      const horizontal = event.shiftKey && Math.abs(delta.x) < 0.5 ? delta.y : delta.x;
      const vertical = event.shiftKey && Math.abs(delta.x) < 0.5 ? 0 : delta.y;
      target.x += horizontal / current.zoom;
      target.y += vertical / current.zoom;
      schedule();
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
      } else if (event.key === "Home" || event.key === "0") reset();
      else if (event.key === "+" || event.key === "=" || event.key === "PageDown") {
        setTargetDepth(Math.round(target.depth + 1));
      } else if (event.key === "-" || event.key === "_" || event.key === "PageUp") {
        setTargetDepth(Math.round(target.depth - 1));
      } else if (event.key.toLowerCase() === "e") setTargetDepth(Math.round(target.depth + 1));
      else if (event.key.toLowerCase() === "q") setTargetDepth(Math.round(target.depth - 1));
      else if (event.key === "ArrowLeft") target.x -= event.shiftKey ? 320 : 110;
      else if (event.key === "ArrowRight") target.x += event.shiftKey ? 320 : 110;
      else if (event.key === "ArrowUp") target.y -= event.shiftKey ? 320 : 110;
      else if (event.key === "ArrowDown") target.y += event.shiftKey ? 320 : 110;
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
      delete root.dataset.spatialDepth;
      delete root.dataset.spatialState;
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
        element.style.removeProperty("will-change");
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
          opacity: 0.18 + card.depthIndex * 0.055,
        },
      ]),
    );
  }, [layout]);

  return (
    <div
      ref={rootRef}
      data-spatial-scene
      className="relative isolate min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_50%_42%,color-mix(in_srgb,var(--muted)_52%,transparent),var(--background)_68%)] outline-none data-[spatial-dragging=true]:cursor-grabbing"
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 block h-full w-full"
      />

      <div className="absolute inset-0 overflow-hidden">
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
        aria-label="Workflow axis"
      >
        {layout.lanes.map((lane) => (
          <button
            key={lane.id}
            ref={(element) => {
              if (element) laneMarkerRefs.current.set(lane.id, element);
              else laneMarkerRefs.current.delete(lane.id);
            }}
            type="button"
            className="pointer-events-auto absolute top-1/2 max-w-40 -translate-y-1/2 truncate rounded-md border border-border/70 bg-background px-2 py-1 text-[10px] font-medium shadow-sm transition-colors hover:bg-accent"
            onClick={() => controllerRef.current?.focusLane(lane.id)}
            title={`Workflow: ${lane.label}`}
          >
            {lane.label}
          </button>
        ))}
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Workflow →
        </span>
      </div>

      <div
        data-spatial-hud
        className="pointer-events-none absolute inset-y-9 left-0 z-30 w-24 overflow-hidden border-r border-border/70 bg-background/88 shadow-sm backdrop-blur"
        aria-label="Project axis"
      >
        {layout.projects.map((project) => (
          <button
            key={project.id}
            ref={(element) => {
              if (element) projectMarkerRefs.current.set(project.id, element);
              else projectMarkerRefs.current.delete(project.id);
            }}
            type="button"
            className="pointer-events-auto absolute left-1 w-[5.5rem] truncate rounded-md border border-border/70 bg-background px-1.5 py-1 text-left text-[9px] font-medium shadow-sm transition-colors hover:bg-accent"
            onClick={() => controllerRef.current?.focusProject(project.id)}
            title={`Project: ${project.label}`}
          >
            {project.label}
          </button>
        ))}
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 -rotate-90 whitespace-nowrap text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Project ↓
        </span>
      </div>

      <div
        data-spatial-hud
        className="absolute right-4 top-1/2 z-40 w-32 -translate-y-1/2 rounded-xl border border-border bg-background/92 p-2 shadow-lg backdrop-blur"
        aria-label="State depth axis"
      >
        <div className="mb-1.5 flex items-center text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          State · Z<span className="ml-auto normal-case tracking-normal">near → far</span>
        </div>
        <div className="relative space-y-1 before:absolute before:bottom-3 before:left-[7px] before:top-3 before:w-px before:bg-border">
          {layout.states.map((state) => (
            <button
              key={state.id}
              ref={(element) => {
                if (element) stateMarkerRefs.current.set(state.id, element);
                else stateMarkerRefs.current.delete(state.id);
              }}
              type="button"
              data-active="false"
              className="relative flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[9px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[active=true]:bg-primary/10 data-[active=true]:font-medium data-[active=true]:text-foreground"
              onClick={() => controllerRef.current?.setDepth(state.index)}
            >
              <span className="relative z-10 size-2 rounded-full border border-border bg-background" />
              <span className="min-w-0 flex-1 truncate">{state.label}</span>
              <span className="tabular-nums opacity-65">{state.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        data-spatial-hud
        className="absolute bottom-4 right-4 z-40 w-44 rounded-xl border border-border bg-background/92 p-2 shadow-lg backdrop-blur"
      >
        <div className="mb-2 flex items-center gap-1">
          <span className="text-[10px] font-medium">Board map</span>
          <span
            ref={depthLabelRef}
            className="ml-auto text-[10px] font-medium text-muted-foreground"
          >
            State
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Move toward earlier state"
            onClick={() => controllerRef.current?.depthBy(-1)}
          >
            <MinusIcon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Move toward later state"
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
          max={Math.max(0, layout.states.length - 1)}
          step={0.01}
          defaultValue={0}
          aria-label="Board state depth"
          onInput={(event) => controllerRef.current?.setDepth(Number(event.currentTarget.value))}
        />
        <div className="mt-1 flex justify-between text-[8px] uppercase tracking-wide text-muted-foreground">
          <span>Near</span>
          <span>State depth</span>
          <span>Far</span>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center pr-48">
        <div className="rounded-full border border-border bg-background/88 px-3 py-1.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
          Scroll X/Y · pinch through state depth · drag empty space · Q/E change state ·
          double-click a card to open
        </div>
      </div>
    </div>
  );
}
