import * as THREE from "three";
import { InteractionManager } from "three/addons/interaction/InteractionManager.js";
import { installHtmlInCanvasPolyfill } from "three-html-render/polyfill";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import type { SpatialBoardSession } from "./SpatialBoardPrototype.tsx";

export type SpatialVariant = "orbit" | "lanes" | "depth";

declare global {
  interface HTMLCanvasElement {
    onpaint: ((event: Event & { readonly changedElements?: readonly Element[] }) => void) | null;
    requestPaint?(): void;
  }
}

interface SpatialSessionSceneProps {
  readonly variant: SpatialVariant;
  readonly sessions: ReadonlyArray<SpatialBoardSession>;
  readonly children: (session: SpatialBoardSession) => ReactNode;
}

interface SceneCard {
  readonly element: HTMLDivElement;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly texture: THREE.HTMLTexture;
}

const STATE_RADIUS: Record<SpatialBoardSession["boardStateId"], number> = {
  draft: 8.5,
  approval: 9,
  input: 9,
  failed: 9.5,
  working: 10,
  idle: 11,
  snoozed: 12.5,
  settled: 14,
};

function projectIndex(sessions: ReadonlyArray<SpatialBoardSession>, projectTitle: string): number {
  return [...new Set(sessions.map((session) => session.projectTitle))].indexOf(projectTitle);
}

function laneIndex(sessions: ReadonlyArray<SpatialBoardSession>, laneId: string): number {
  return [...new Set(sessions.map((session) => session.laneId))].indexOf(laneId as never);
}

function positionFor(
  session: SpatialBoardSession,
  sessions: ReadonlyArray<SpatialBoardSession>,
  variant: SpatialVariant,
): THREE.Vector3 {
  const project = projectIndex(sessions, session.projectTitle);
  const lane = laneIndex(sessions, session.laneId);

  if (variant === "lanes") {
    const laneCount = Math.max(1, new Set(sessions.map((entry) => entry.laneId)).size);
    const projectCount = Math.max(1, new Set(sessions.map((entry) => entry.projectTitle)).size);
    const laneAngle = (lane / laneCount) * Math.PI * 2;
    const peers = sessions.filter((entry) => entry.laneId === session.laneId);
    const peerIndex = peers.findIndex((entry) => entry.cardKey === session.cardKey);
    const spread = (peerIndex - (peers.length - 1) / 2) * 0.12;
    const radius = STATE_RADIUS[session.boardStateId];
    return new THREE.Vector3(
      Math.sin(laneAngle + spread) * radius,
      (project - (projectCount - 1) / 2) * 1.1,
      -Math.cos(laneAngle + spread) * radius,
    );
  }

  if (variant === "depth") {
    const projects = [...new Set(sessions.map((entry) => entry.projectTitle))];
    const peers = sessions.filter((entry) => entry.projectTitle === session.projectTitle);
    const peerIndex = peers.findIndex((entry) => entry.cardKey === session.cardKey);
    return new THREE.Vector3(
      (project - (projects.length - 1) / 2) * 3.8,
      ((peerIndex % 3) - 1) * 3.1,
      -5.5 - Math.floor(peerIndex / 3) * 3.6,
    );
  }

  const projects = [...new Set(sessions.map((entry) => entry.projectTitle))];
  const lanes = [...new Set(sessions.map((entry) => entry.laneId))];
  const peers = sessions.filter(
    (entry) =>
      entry.projectTitle === session.projectTitle &&
      entry.laneId === session.laneId &&
      entry.boardStateId === session.boardStateId,
  );
  const peerIndex = peers.findIndex((entry) => entry.cardKey === session.cardKey);
  const peerSpread = (peerIndex - (peers.length - 1) / 2) * 0.16;
  const angle = (project / Math.max(1, projects.length)) * Math.PI * 2 + peerSpread;
  const radius = STATE_RADIUS[session.boardStateId];
  return new THREE.Vector3(
    Math.sin(angle) * radius,
    (lane - (lanes.length - 1) / 2) * 1.7,
    -Math.cos(angle) * radius,
  );
}

export function SpatialSessionScene({
  variant,
  sessions,
  children,
}: SpatialSessionSceneProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const elementsRef = useRef(new Map<string, HTMLDivElement>());
  const sessionKey = useMemo(
    () => sessions.map((session) => session.cardKey).join("\u0000"),
    [sessions],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || sessions.length === 0) return;

    delete canvas.dataset.spatialReady;
    canvas.dataset.spatialVariant = variant;
    canvas.setAttribute("layoutsubtree", "");
    // Chrome's current experimental native API rejects the Element value that
    // Three's HTMLTexture uploads. Keep this prototype on the compatible path
    // until the browser and Three agree on the native ElementImage contract.
    installHtmlInCanvasPolyfill({ force: true });
    const polyfillHost = document.querySelector<HTMLElement>(
      '[data-host-of="spatial-session-canvas"]',
    );
    if (polyfillHost) {
      polyfillHost.style.zIndex = "0";
      polyfillHost.style.overflow = "hidden";
      polyfillHost.style.isolation = "isolate";
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x101114, 0.028);
    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
    camera.rotation.order = "YXZ";

    const grid = new THREE.GridHelper(36, 36, 0x5b6472, 0x2a3038);
    const gridMaterial = grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.24;
    grid.position.y = -4.2;
    scene.add(grid);

    const interactions = new InteractionManager();
    interactions.connect(renderer, camera);
    const cards: SceneCard[] = [];

    sessions.forEach((session) => {
      const element = elementsRef.current.get(session.cardKey);
      if (!element || element.offsetWidth === 0 || element.offsetHeight === 0) return;

      const width = 3.2;
      const aspect = THREE.MathUtils.clamp(element.offsetHeight / element.offsetWidth, 0.28, 1.4);
      const height = width * aspect;
      const texture = new THREE.HTMLTexture(element);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
      mesh.position.copy(positionFor(session, sessions, variant));
      scene.add(mesh);
      interactions.add(mesh);
      cards.push({ element, mesh, texture });
    });

    let yaw = 0;
    let pitch = 0;
    let frame = 0;
    let hasPainted = false;
    let needsInteractionUpdate = true;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const render = (): void => {
      frame = 0;
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld();
      if (needsInteractionUpdate) {
        needsInteractionUpdate = false;
        for (const card of cards) {
          card.mesh.quaternion.copy(camera.quaternion);
          card.mesh.updateMatrixWorld();
          const distance = card.mesh.position.distanceTo(camera.position);
          const zIndex = String(Math.max(1, 10_000 - Math.round(distance * 100)));
          if (card.element.style.zIndex !== zIndex) card.element.style.zIndex = zIndex;
        }
        interactions.update();
      }
      renderer.render(scene, camera);
      if (hasPainted) canvas.dataset.spatialReady = "true";
    };

    const schedule = (updateInteractions = false): void => {
      if (updateInteractions) needsInteractionUpdate = true;
      if (frame === 0) frame = window.requestAnimationFrame(render);
    };

    const resize = (): void => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (hasPainted) schedule(true);
    };

    const moveCamera = (
      forwardAmount: number,
      rightAmount: number,
      verticalAmount: number,
    ): void => {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
      camera.position.addScaledVector(forward, forwardAmount);
      camera.position.addScaledVector(right, rightAmount);
      camera.position.y += verticalAmount;
      schedule(true);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.target !== canvas) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      yaw -= (event.clientX - lastX) * 0.004;
      pitch = Math.max(-1.35, Math.min(1.35, pitch - (event.clientY - lastY) * 0.004));
      lastX = event.clientX;
      lastY = event.clientY;
      schedule(true);
    };
    const onPointerUp = (event: PointerEvent): void => {
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent): void => {
      if (event.target !== canvas) return;
      event.preventDefault();
      moveCamera(event.deltaY * 0.003, 0, 0);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const step = event.shiftKey ? 1.2 : 0.55;
      if (event.code === "KeyW" || event.code === "ArrowUp") moveCamera(step, 0, 0);
      else if (event.code === "KeyS" || event.code === "ArrowDown") moveCamera(-step, 0, 0);
      else if (event.code === "KeyA" || event.code === "ArrowLeft") moveCamera(0, -step, 0);
      else if (event.code === "KeyD" || event.code === "ArrowRight") moveCamera(0, step, 0);
      else if (event.code === "KeyQ" || event.code === "PageDown") moveCamera(0, 0, -step);
      else if (event.code === "KeyE" || event.code === "PageUp") moveCamera(0, 0, step);
      else if (event.code === "Home" || event.code === "Digit0") {
        camera.position.set(0, 0, 0);
        yaw = 0;
        pitch = 0;
        schedule(true);
      } else return;
      event.preventDefault();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    canvas.onpaint = () => {
      for (const card of cards) card.texture.needsUpdate = true;
      const firstPaint = !hasPainted;
      hasPainted = true;
      schedule(firstPaint);
    };
    resize();
    canvas.requestPaint?.();

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      canvas.onpaint = null;
      delete canvas.dataset.spatialReady;
      delete canvas.dataset.spatialVariant;
      interactions.disconnect();
      for (const card of cards) {
        card.element.style.removeProperty("position");
        card.element.style.removeProperty("left");
        card.element.style.removeProperty("top");
        card.element.style.removeProperty("transform");
        card.element.style.removeProperty("transform-origin");
        card.element.style.removeProperty("z-index");
        card.texture.dispose();
        card.mesh.geometry.dispose();
        card.mesh.material.dispose();
      }
      renderer.dispose();
    };
  }, [sessionKey, sessions, variant]);

  return (
    <div className="relative isolate min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_center,var(--muted),var(--background)_62%)]">
      <canvas
        id="spatial-session-canvas"
        ref={canvasRef}
        className="block h-full w-full cursor-move outline-none"
      >
        {sessions.map((session) => (
          <div
            key={session.cardKey}
            ref={(element) => {
              if (element) elementsRef.current.set(session.cardKey, element);
              else elementsRef.current.delete(session.cardKey);
            }}
            data-spatial-session={session.cardKey}
            className="w-[380px]"
          >
            {children(session)}
          </div>
        ))}
      </canvas>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
        <div className="rounded-full border border-border bg-background/85 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          Drag empty space to look · wheel/WASD move · Q/E rise · Home returns to center · cards
          remain live HTML
        </div>
      </div>
    </div>
  );
}
