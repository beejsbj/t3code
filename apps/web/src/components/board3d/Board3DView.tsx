/**
 * Board Palace — the html-in-canvas 3D board prototype.
 *
 * You stand at the center; cards surround you in every direction and always
 * face you. Workflow lanes are azimuth sectors, projects are elevation
 * strata, and state is radial rings (working close, settled at the horizon).
 * The HUD renders orientation bands as ordinary DOM so text stays crisp.
 *
 * Joy prototype: dev-flag gated, Chromium-only, synthetic cards by default.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyLook,
  createCamera,
  flyTo,
  tickCamera,
  viewMatrix,
  type CameraState,
  type MoveInput,
} from "./camera.ts";
import { layoutBoard3D, type CardTransform } from "./layout.ts";
import { ndcToWorldRay, pickCard } from "./raycast.ts";
import { createRenderer, perspectiveMatrix, type Board3DRenderer } from "./renderer.ts";
import { generateSyntheticCards, SYNTHETIC_LANES } from "./syntheticCards.ts";
import { Board3DHud } from "./Hud.tsx";
import { ElementSnapshotSource } from "./elementCapture.ts";
import { SyntheticCardDom } from "./SyntheticCardDom.tsx";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const MOVE_KEYS: Record<string, keyof Omit<MoveInput, "sprint">> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "forward",
  ArrowDown: "forward",
  KeyA: "strafe",
  ArrowLeft: "strafe",
  KeyD: "strafe",
  ArrowRight: "strafe",
  KeyQ: "vertical",
  KeyE: "vertical",
};

const MOVE_SIGN: Record<string, number> = {
  KeyW: 1,
  ArrowUp: 1,
  KeyS: -1,
  ArrowDown: -1,
  KeyA: -1,
  ArrowLeft: -1,
  KeyD: 1,
  ArrowRight: 1,
  KeyQ: -1,
  KeyE: 1,
};

export function Board3DView(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<Board3DRenderer | null>(null);
  const cameraRef = useRef<CameraState>(createCamera());
  const keysRef = useRef(new Set<string>());
  const snapshotsRef = useRef<ElementSnapshotSource | null>(null);
  const snapshotRootsRef = useRef<Map<string, Root> | null>(null);
  const framePainted = useRef(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [glReady, setGlReady] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [heading, setHeading] = useState({ yaw: 0, pitch: 0 });

  const cards = useMemo(() => generateSyntheticCards(40), []);
  const transforms = useMemo(() => layoutBoard3D(cards), [cards]);
  const transformById = useMemo(
    () => new Map<string, CardTransform>(transforms.map((t) => [t.id, t])),
    [transforms],
  );

  // --- renderer lifecycle ---------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer(canvas);
    rendererRef.current = renderer;
    setGlReady(renderer !== null);
    renderer?.setCards(transforms.map((t) => ({ id: t.id, position: t.position })));
    return () => {
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, [transforms]);

  // --- html-in-canvas snapshots: real DOM card textures --------------------
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !glReady || !renderer.elementTexturesSupported) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const source = new ElementSnapshotSource(canvas);
    const roots = new Map<string, Root>();
    snapshotsRef.current = source;
    snapshotRootsRef.current = roots;
    source.setCards(
      cards.map((c) => c.id),
      (id) => {
        const card = cards.find((c) => c.id === id);
        const el = document.createElement("div");
        const root = createRoot(el);
        roots.set(id, root);
        if (card) flushSync(() => root.render(<SyntheticCardDom card={card} />));
        return el;
      },
    );
    return () => {
      for (const root of roots.values()) root.unmount();
      roots.clear();
      source.dispose();
      snapshotsRef.current = null;
      snapshotRootsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glReady, cards]);

  // --- resize ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer || !glReady) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      const rect = parent.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, window.devicePixelRatio);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [glReady]);

  // --- main loop: renders on camera movement or dirty state -----------------
  useEffect(() => {
    if (!glReady) return;
    let raf = 0;
    let lastTime = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      const keys = keysRef.current;
      const input: MoveInput = {
        forward: 0,
        strafe: 0,
        vertical: 0,
        sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"),
      };
      for (const code of keys) {
        const axis = MOVE_KEYS[code];
        if (axis) input[axis] = MOVE_SIGN[code] ?? 0;
      }
      const cam = cameraRef.current;
      const hasInput = input.forward !== 0 || input.strafe !== 0 || input.vertical !== 0;
      const hasVelocity = cam.velocity[0] !== 0 || cam.velocity[1] !== 0 || cam.velocity[2] !== 0;
      // Always integrate while moving OR gliding to a stop, so momentum damps
      // out smoothly instead of freezing the moment a key releases.
      const moving = hasInput || hasVelocity;
      const next = moving ? tickCamera(cam, input, dt) : cam;
      cameraRef.current = next;
      const renderer = rendererRef.current;
      // Re-snapshot dirty cards into their textures (html-in-canvas). Dirty
      // starts as "all", so the first frames populate every card once their
      // source DOM has painted. Re-snapshotting marks the scene dirty so the
      // frame below redraws with the fresh texture.
      const snapshots = snapshotsRef.current;
      let texturesDirty = false;
      if (renderer && snapshots && renderer.elementTexturesSupported) {
        for (const id of snapshots.consumeDirty()) {
          const el = snapshots.getElement(id);
          if (el) {
            renderer.setCardTextureFromElement(id, el);
            texturesDirty = true;
          }
        }
      }
      if (renderer && (moving || texturesDirty || !framePainted.current)) {
        const canvas = canvasRef.current;
        const aspect = canvas ? canvas.width / Math.max(canvas.height, 1) : 16 / 9;
        renderer.render(viewMatrix(next), perspectiveMatrix(60, aspect, 0.1, 100));
        framePainted.current = true;
        setHeading((h) =>
          h.yaw !== next.yaw || h.pitch !== next.pitch ? { yaw: next.yaw, pitch: next.pitch } : h,
        );
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [glReady]);

  // --- keyboard -------------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (!document.pointerLockElement) return;
      keysRef.current.add(e.code);
      if (e.code === "Space") {
        e.preventDefault();
        snapToNearestAttention();
      }
      if (MOVE_KEYS[e.code]) e.preventDefault();
    };
    const up = (e: KeyboardEvent): void => {
      keysRef.current.delete(e.code);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  // --- pointer lock + look ----------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onLockChange = (): void => setPointerLocked(document.pointerLockElement === canvas);
    const onMove = (e: MouseEvent): void => {
      if (document.pointerLockElement !== canvas) return;
      cameraRef.current = applyLook(cameraRef.current, e.movementX, e.movementY);
    };
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMove);
    };
  }, []);

  // --- picking ----------------------------------------------------------------
  const pick = useCallback(
    (ndcX: number, ndcY: number): string | null => {
      const cam = cameraRef.current;
      const canvas = canvasRef.current;
      const aspect = canvas ? canvas.width / Math.max(canvas.height, 1) : 16 / 9;
      const ray = ndcToWorldRay(ndcX, ndcY, cam, 60, aspect);
      return pickCard(ray, transforms, cam.position);
    },
    [transforms],
  );

  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): void => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (!document.pointerLockElement) {
        canvas.requestPointerLock();
        return;
      }
      const hit = pick(0, 0);
      if (hit) {
        // Prototype: log the "open thread" action; wiring to real threads comes
        // with the real-data adapter.
        console.info("[board3d] open card", hit);
      }
    },
    [pick],
  );

  const onCanvasHover = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): void => {
      if (document.pointerLockElement) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      setHoveredId(pick(ndcX, ndcY));
    },
    [pick],
  );

  // --- actions ------------------------------------------------------------------
  const snapToNearestAttention = useCallback((): void => {
    const cam = cameraRef.current;
    const attention = cards.filter((c) => c.needsAttention);
    let best: CardTransform | null = null;
    let bestDist = Infinity;
    for (const card of attention) {
      const t = transformById.get(card.id);
      if (!t) continue;
      const d = Math.hypot(
        t.position[0] - cam.position[0],
        t.position[1] - cam.position[1],
        t.position[2] - cam.position[2],
      );
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (best) cameraRef.current = flyTo(cam, best.position);
  }, [cards, transformById]);

  const teleportTo = useCallback(
    (id: string): void => {
      const t = transformById.get(id);
      if (t) cameraRef.current = flyTo(cameraRef.current, t.position);
    },
    [transformById],
  );

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-crosshair"
        onClick={onCanvasClick}
        onMouseMove={onCanvasHover}
      />
      {!glReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="max-w-md space-y-2 text-center text-muted-foreground">
            <p className="text-lg font-medium text-foreground">Board Palace needs WebGL2</p>
            <p className="text-sm">
              This prototype renders card billboards in WebGL2 and html-in-canvas textures. Your
              browser did not provide a WebGL2 context. In Chromium, enable{" "}
              <code>chrome://flags/#canvas-draw-element</code>.
            </p>
          </div>
        </div>
      )}
      <Board3DHud
        cards={cards}
        lanes={SYNTHETIC_LANES}
        transforms={transforms}
        yaw={heading.yaw}
        pitch={heading.pitch}
        hoveredId={hoveredId}
        onTeleport={teleportTo}
      />
      {!pointerLocked && (
        <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center">
          <div className="rounded-full bg-black/60 px-4 py-2 text-sm text-white/80">
            Click to look around · WASD move · Q/E down/up · Shift sprint · Space snap to attention
            · Esc release
          </div>
        </div>
      )}
    </div>
  );
}
