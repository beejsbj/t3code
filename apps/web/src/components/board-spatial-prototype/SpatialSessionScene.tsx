import { LocateFixedIcon, MinusIcon, PlusIcon } from "lucide-react";
import * as THREE from "three";
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";

import { useBoardFocusStore } from "../../board/boardFocusStore.ts";
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
  readonly centerX: number;
  readonly centerY: number;
}

interface AxisMarker {
  readonly id: string;
  readonly label: string;
  readonly position: number;
}

interface SpatialLayout {
  readonly key: string;
  readonly cards: ReadonlyArray<LayoutCard>;
  readonly byKey: ReadonlyMap<string, LayoutCard>;
  readonly lanes: ReadonlyArray<AxisMarker>;
  readonly projects: ReadonlyArray<AxisMarker>;
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
  readonly setZoom: (zoom: number) => void;
  readonly zoomBy: (factor: number) => void;
}

interface CameraPoint {
  x: number;
  y: number;
  zoom: number;
}

const CARD_WIDTH = 380;
const CARD_HEIGHT = 560;
const COLUMN_GAP = 52;
const ROW_GAP = 76;
const CELL_CARD_GAP = 20;
const MIN_ZOOM = 0.22;
const MAX_ZOOM = 1.4;
const CAMERA_TAU_SECONDS = 0.06;
const CAMERA_EPSILON = 0.12;

function buildLayout(sessions: ReadonlyArray<SpatialBoardSession>): SpatialLayout {
  const lanes = [
    ...new Map(sessions.map((session) => [session.laneId, session.workflowLabel])).entries(),
  ];
  const projects = [...new Set(sessions.map((session) => session.projectTitle))];
  const cellSessions = new Map<string, SpatialBoardSession[]>();

  for (const session of sessions) {
    const cellKey = `${session.projectTitle}\u0000${session.laneId}`;
    const entries = cellSessions.get(cellKey) ?? [];
    entries.push(session);
    cellSessions.set(cellKey, entries);
  }

  const rowHeights = lanes.map(([laneId]) => {
    const largestCell = Math.max(
      1,
      ...projects.map((project) => cellSessions.get(`${project}\u0000${laneId}`)?.length ?? 0),
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
    const columnIndex = projects.indexOf(session.projectTitle);
    const rowIndex = lanes.findIndex(([laneId]) => laneId === session.laneId);
    const peers = cellSessions.get(`${session.projectTitle}\u0000${session.laneId}`) ?? [];
    const peerIndex = peers.findIndex((peer) => peer.cardKey === session.cardKey);
    const x = columnIndex * columnStride;
    const y = (rowTops[rowIndex] ?? 0) + peerIndex * (CARD_HEIGHT + CELL_CARD_GAP);
    cards.push({
      key: session.cardKey,
      x,
      y,
      centerX: x + CARD_WIDTH / 2,
      centerY: y + CARD_HEIGHT / 2,
    });
  }

  const width = Math.max(CARD_WIDTH, projects.length * columnStride - COLUMN_GAP);
  const height = Math.max(CARD_HEIGHT, nextTop - ROW_GAP);
  const laneMarkers = lanes.map(([id, label], index) => ({
    id,
    label,
    position: (rowTops[index] ?? 0) + (rowHeights[index] ?? CARD_HEIGHT) / 2,
  }));
  const projectMarkers = projects.map((project, index) => ({
    id: project,
    label: project,
    position: index * columnStride + CARD_WIDTH / 2,
  }));

  return {
    key: sessions
      .map((session) => `${session.cardKey}:${session.laneId}:${session.projectTitle}`)
      .join("\u0001"),
    cards,
    byKey: new Map(cards.map((card) => [card.key, card])),
    lanes: laneMarkers,
    projects: projectMarkers,
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
  const minimapViewportRef = useRef<HTMLDivElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  const zoomRangeRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const focusedThreadKey = useBoardFocusStore((state) => state.focusedThreadKey);
  const focusRequest = useBoardFocusStore((state) => state.request);
  const layoutKey = useMemo(
    () =>
      sessions
        .map((session) => `${session.cardKey}:${session.laneId}:${session.projectTitle}`)
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
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2_000);
    camera.position.z = 1_000;

    const boundsWidth = layout.bounds.right - layout.bounds.left;
    const boundsHeight = layout.bounds.bottom - layout.bounds.top;
    const gridSize = Math.max(boundsWidth, boundsHeight) + 2_400;
    const gridDivisions = Math.max(12, Math.min(120, Math.round(gridSize / 120)));
    const grid = new THREE.GridHelper(gridSize, gridDivisions, 0x94a3b8, 0xcbd5e1);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(boundsWidth / 2, -boundsHeight / 2, -10);
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.2;
    }
    scene.add(grid);

    const target: CameraPoint = { x: 0, y: 0, zoom: 1 };
    const current: CameraPoint = { x: 0, y: 0, zoom: 1 };
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let previousTime = 0;
    let settleDeadline = 0;
    let initialized = false;
    let draggingPointerId: number | null = null;
    let dragX = 0;
    let dragY = 0;
    let dragged = false;

    const homeCamera = (): CameraPoint => {
      const viewportWidth = Math.max(1, root.clientWidth - 150);
      const viewportHeight = Math.max(1, root.clientHeight - 110);
      return {
        x: (layout.bounds.left + layout.bounds.right) / 2,
        y: (layout.bounds.top + layout.bounds.bottom) / 2,
        zoom: clampZoom(Math.min(viewportWidth / boundsWidth, viewportHeight / boundsHeight, 0.9)),
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
      const halfWidth = width / current.zoom / 2;
      const halfHeight = height / current.zoom / 2;
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.position.set(current.x, -current.y, 1_000);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      for (const card of layout.cards) {
        const element = elementsRef.current.get(card.key);
        if (!element) continue;
        const screenX = width / 2 + (card.x - current.x) * current.zoom;
        const screenY = height / 2 + (card.y - current.y) * current.zoom;
        element.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) scale(${current.zoom})`;
      }

      for (const marker of layout.projects) {
        const element = projectMarkerRefs.current.get(marker.id);
        if (!element) continue;
        const screenX = width / 2 + (marker.position - current.x) * current.zoom;
        element.style.transform = `translate3d(${screenX}px, 0, 0) translateX(-50%)`;
        element.style.opacity = screenX < -120 || screenX > width + 120 ? "0" : "1";
      }
      for (const marker of layout.lanes) {
        const element = laneMarkerRefs.current.get(marker.id);
        if (!element) continue;
        const screenY = height / 2 + (marker.position - current.y) * current.zoom;
        element.style.transform = `translate3d(0, ${screenY}px, 0) translateY(-50%)`;
        element.style.opacity = screenY < -80 || screenY > height + 80 ? "0" : "1";
      }

      const zoomPercent = Math.round(current.zoom * 100);
      if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${zoomPercent}%`;
      if (zoomRangeRef.current) zoomRangeRef.current.value = String(zoomPercent);
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
      current.zoom += (target.zoom - current.zoom) * follow;
      renderScene();

      const unsettled =
        Math.abs(target.x - current.x) > CAMERA_EPSILON ||
        Math.abs(target.y - current.y) > CAMERA_EPSILON ||
        Math.abs(target.zoom - current.zoom) > 0.0002;
      if (unsettled) schedule(false);
      else {
        current.x = target.x;
        current.y = target.y;
        current.zoom = target.zoom;
        renderScene();
        setAnimating(false);
      }
    }

    const setTargetZoom = (
      nextZoom: number,
      anchorX = root.clientWidth / 2,
      anchorY = root.clientHeight / 2,
    ) => {
      const zoom = clampZoom(nextZoom);
      const offsetX = anchorX - root.clientWidth / 2;
      const offsetY = anchorY - root.clientHeight / 2;
      const worldX = target.x + offsetX / target.zoom;
      const worldY = target.y + offsetY / target.zoom;
      target.zoom = zoom;
      target.x = worldX - offsetX / zoom;
      target.y = worldY - offsetY / zoom;
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
      target.zoom = THREE.MathUtils.clamp(target.zoom, 0.78, 0.92);
      schedule();
    };

    controllerRef.current = {
      focusCard,
      focusLane: (laneId) => {
        const marker = layout.lanes.find((candidate) => candidate.id === laneId);
        if (!marker) return;
        target.y = marker.position;
        schedule();
      },
      focusProject: (projectTitle) => {
        const marker = layout.projects.find((candidate) => candidate.id === projectTitle);
        if (!marker) return;
        target.x = marker.position;
        schedule();
      },
      reset,
      setZoom: (zoom) => setTargetZoom(zoom),
      zoomBy: (factor) => setTargetZoom(target.zoom * factor),
    };

    const resize = (): void => {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      renderer.setSize(width, height, false);
      if (!initialized) {
        initialized = true;
        const firstCard = layout.cards[0];
        Object.assign(
          target,
          firstCard ? { x: firstCard.centerX, y: firstCard.centerY, zoom: 0.78 } : homeCamera(),
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
        setTargetZoom(target.zoom * Math.exp(-delta.y * 0.008), event.clientX, event.clientY);
        return;
      }
      const horizontal = event.shiftKey && Math.abs(delta.x) < 0.5 ? delta.y : delta.x;
      const vertical = event.shiftKey && Math.abs(delta.x) < 0.5 ? 0 : delta.y;
      target.x += horizontal / target.zoom;
      target.y += vertical / target.zoom;
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
      else if (event.key === "+" || event.key === "=") setTargetZoom(target.zoom * 1.18);
      else if (event.key === "-" || event.key === "_") setTargetZoom(target.zoom / 1.18);
      else if (event.key === "PageUp") setTargetZoom(target.zoom * 1.18);
      else if (event.key === "PageDown") setTargetZoom(target.zoom / 1.18);
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
      grid.geometry.dispose();
      for (const material of gridMaterials) material.dispose();
      renderer.dispose();
      for (const element of elementsRef.current.values()) {
        element.style.removeProperty("transform");
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
            className="absolute left-0 top-0 w-[380px] origin-top-left transform-gpu contain-layout contain-paint"
          >
            {children(session)}
          </div>
        ))}
      </div>

      <div
        data-spatial-hud
        className="pointer-events-none absolute inset-x-0 top-0 z-30 h-9 overflow-hidden border-b border-border/70 bg-background/88 pl-24 shadow-sm backdrop-blur"
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
            className="pointer-events-auto absolute top-1/2 max-w-40 -translate-y-1/2 truncate rounded-md border border-border/70 bg-background px-2 py-1 text-[10px] font-medium shadow-sm transition-colors hover:bg-accent"
            onClick={() => controllerRef.current?.focusProject(project.id)}
            title={`Project: ${project.label}`}
          >
            {project.label}
          </button>
        ))}
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Project →
        </span>
      </div>

      <div
        data-spatial-hud
        className="pointer-events-none absolute inset-y-9 left-0 z-30 w-24 overflow-hidden border-r border-border/70 bg-background/88 shadow-sm backdrop-blur"
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
            className="pointer-events-auto absolute left-1 w-[5.5rem] truncate rounded-md border border-border/70 bg-background px-1.5 py-1 text-left text-[9px] font-medium shadow-sm transition-colors hover:bg-accent"
            onClick={() => controllerRef.current?.focusLane(lane.id)}
            title={`Workflow: ${lane.label}`}
          >
            {lane.label}
          </button>
        ))}
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 -rotate-90 whitespace-nowrap text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Workflow ↓
        </span>
      </div>

      <div
        data-spatial-hud
        className="absolute bottom-4 right-4 z-40 w-44 rounded-xl border border-border bg-background/92 p-2 shadow-lg backdrop-blur"
      >
        <div className="mb-2 flex items-center gap-1">
          <span className="text-[10px] font-medium">Board map</span>
          <span
            ref={zoomLabelRef}
            className="ml-auto text-[10px] tabular-nums text-muted-foreground"
          >
            100%
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Zoom out"
            onClick={() => controllerRef.current?.zoomBy(1 / 1.18)}
          >
            <MinusIcon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Zoom in"
            onClick={() => controllerRef.current?.zoomBy(1.18)}
          >
            <PlusIcon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Fit board"
            onClick={() => controllerRef.current?.reset()}
          >
            <LocateFixedIcon className="size-3" />
          </Button>
        </div>
        <div className="relative h-20 overflow-hidden rounded-md border border-border/70 bg-muted/45">
          {layout.cards.map((card) => (
            <div
              key={card.key}
              className="absolute rounded-[1px] bg-foreground/20"
              style={minimapCardStyles.get(card.key)}
            />
          ))}
          <div
            ref={minimapViewportRef}
            className="absolute min-h-2 min-w-2 rounded-[2px] border border-primary bg-primary/10"
          />
        </div>
        <input
          ref={zoomRangeRef}
          className="mt-2 h-1 w-full accent-primary"
          type="range"
          min={Math.round(MIN_ZOOM * 100)}
          max={Math.round(MAX_ZOOM * 100)}
          defaultValue={100}
          aria-label="Board depth zoom"
          onInput={(event) =>
            controllerRef.current?.setZoom(Number(event.currentTarget.value) / 100)
          }
        />
        <div className="mt-1 flex justify-between text-[8px] uppercase tracking-wide text-muted-foreground">
          <span>Out</span>
          <span>Depth</span>
          <span>In</span>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center pr-48">
        <div className="rounded-full border border-border bg-background/88 px-3 py-1.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
          Scroll in any direction · pinch to move in/out · drag empty space · double-click a card to
          open · target icon fits board
        </div>
      </div>
    </div>
  );
}
