# Board Palace — html-in-canvas 3D board prototype

**Status:** joy prototype, worktree-only, no PR. Chromium-only (origin trial M148–M151 / `canvas-draw-element` blink flag). Do not touch the 2D board's behavior; this lives beside it.

## Idea

The 2D board already encodes three grouping dimensions (workflow lanes, projects, state). This prototype re-renders those same cards in an egocentric 3D space: _you are at the center_, cards surround you in all directions, always billboarding to face the viewport. The mind-palace bet: your body already knows Triage is left and Review is right — this gives that knowledge muscle memory instead of scroll-distance memory.

Reference feeling: Pantheon finale, Maddy moving through her simulations — the space flows past you, you stay centered.

## Coordinate system (v0 — deliberately simple, feel it out)

| Axis                 | Dimension      | Mapping                                                                                                                                          |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Azimuth (around you) | Workflow lanes | Each lane is a sector, ordered like the 2D board. Angular width proportional to card count, min 24° per occupied lane.                           |
| Elevation (up/down)  | Projects       | Project strata above/below eye level, sorted by card count descending; most-populated project at eye level. One stratum per project, 1.6m apart. |
| Radius (in/out)      | State rings    | Working r≈3m · Input/Approval r≈4.5m · Idle/Done r≈6m · Failed r≈6m · Draft r≈3.5m · Snoozed r≈9m · Settled r≈12m (the horizon).                 |

Cards distribute evenly within their (lane-sector × project-stratum × state-ring) cell with slight deterministic jitter (hash of threadId) so positions are stable across renders. Scale: 1 world unit = 1 meter. Cards are ~1.4m wide quads at a comfortable reading distance.

The mapping module must be pure and data-driven: same inputs → same layout, independent of render order. This is the testable core.

## Rendering: html-in-canvas

- Cards are REAL DOM: reuse the existing board card markup in an offscreen positioned container with the `layoutsubtree` attribute.
- Per frame (or on state change), each card's subtree is drawn into a WebGL texture via `texElementImage2D` and splashed on a billboard quad.
- Raw WebGL2, NO three.js dependency — the scene is quads + a camera; the dep isn't worth it. Small mat4/quat helpers in-module.
- Texture update policy: dirty-flag per card (state change, streaming text tick). Never re-snapshot every card every frame — that's the GPU-peg trap from AGENTS.md taste rules.
- Fallback: if `layoutsubtree`/texElementImage2D is unavailable, render a "your browser can't do this yet" panel with the flag instructions. Detect, don't crash.

## Interaction (prototype controls — tuned for feel, not completeness)

| Input        | Action                                                             |
| ------------ | ------------------------------------------------------------------ |
| Click canvas | pointer lock (FPS look)                                            |
| Mouse        | look around                                                        |
| Wheel        | walk in/out (move along view direction, clamped to walkable shell) |
| W/S or ↑/↓   | walk forward/back                                                  |
| A/D or ←/→   | strafe left/right                                                  |
| Q/E          | strafe down/up                                                     |
| Shift        | faster movement                                                    |
| Click card   | open the thread (same action as 2D card click)                     |
| Esc          | exit pointer lock                                                  |
| Space        | snap to face the nearest attention-needing card                    |

Movement is smoothed (velocity + damping) — no instant teleports except sidebar/HUD jumps, and those animate ~400ms. All camera math in one module with unit tests.

Raycasting: CPU ray vs card quads in world space (cards are axis-aligned billboards; quad = position + size, orientation is view-facing so hit-test against the billboarded plane). Hover sets cursor + highlights the DOM card's outline via a shared hovered-threadId atom.

## HUD (DOM overlays, not canvas — crisp text for free)

- **Compass bands** — one per axis, stacked at top of viewport:
  - Lane band (workflow sectors with names at their azimuth)
  - Project band (strata, shown as vertical gauge at right edge instead — elevation isn't a compass)
  - State band (rings as concentric-arc minimap at bottom-left corner)
  - The current heading marker moves across bands as you turn.
- **Attention dots**: cards needing attention (Input, Approval, Failed) outside the frustum get an edge-glowing dot projected to screen edge, in the direction of the card. This is the 3D-native version of "cards jumping shows aliveness".
- **Sidebar stays**: existing sidebar remains visible as DOM; clicking a thread in it flies the camera to face that card (teleport-with-animation).

## Data

- v0 runs on SYNTHETIC cards: a generator producing N cards (default 40) with lane/project/state/title, seeded by a constant so layout is reproducible. A dev toggle switches to real board data via the existing board selectors once the spatial model feels right.
- Reuse `BoardOrganization`/lane store types where they fit, but DO NOT modify the 2D board components. New directory: `apps/web/src/components/board3d/`. Entry point: a route or board-level view toggle gated behind a dev flag (localStorage `t3:board3d`).

## Performance budget

- 60fps with 100 cards on a mid GPU. Textures atlased or per-card 2D textures, updated on dirty-flag only.
- No continuously repainting CSS animations; canvas renders on demand (state change, camera move, or streaming tick) — rAF loop that early-exits when nothing is dirty.
- Pointer-lock look is the only always-rendering mode, and it's user-active so that's honest work.

## File sketch

```
apps/web/src/components/board3d/
  Board3DView.tsx          # canvas + HUD shell, view toggle
  layout.ts                # pure: cards -> world transforms (TESTED)
  camera.ts                # pure: camera state, movement integration (TESTED)
  raycast.ts               # pure: ray -> card hit (TESTED)
  CardTextureAtlas.ts      # layoutsubtree snapshots -> GL textures
  renderer.ts              # WebGL2 program, billboard batches
  Hud.tsx                  # compass bands, attention dots, minimap
  syntheticCards.ts        # seeded fake data generator
  useBoard3DData.ts        # real board selectors adapter (behind toggle)
```

## Explicit non-goals (v0)

- No mobile. No accessibility tree for the 3D scene (the DOM sidebar remains the accessible path). No drag-and-drop. No persistence of camera. No multiplayer. No three.js.

## Done-when

- Toggle 2D↔3D from the board with the dev flag on.
- 40 synthetic cards visible, navigable, billboarded, readable at their ring distance.
- Hover highlights, click opens thread (synthetic: logs/selects), sidebar teleport works.
- Pure modules (layout, camera, raycast) have unit tests passing.
- 60fps feel, no per-frame DOM snapshots.
