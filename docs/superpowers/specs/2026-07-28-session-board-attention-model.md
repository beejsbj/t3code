# Session board: attention model and dynamic lanes

**Date:** 2026-07-28
**Repo:** `T3code-bjs-286-nightly`, branch `bjs-286-live-session-board-nightly`, board commit `1a68c7199`
**Status:** design agreed, packets not yet executed

## Problem

The live session board renders real sessions as cards, with six hard-coded workflow lanes. Three things need to change:

1. The board and the sidebar derive session status separately and **already disagree**, which breaks the inbox drain (below).
2. Lanes are a closed literal union. They need to become data the user can create, name, describe and reorder.
3. Agents should be able to file their own session into a lane.

Underneath all three is one principle, held constant throughout: **extend T3 Code's inbuilt session state, do not build a second workflow engine beside it.**

## The inbox is real, and it is broken today

The sidebar was built inspired by inboxes, and T3 Code's settle feature is what makes an inbox coherent: **settled drains to Done, archived leaves the board entirely** — exactly mirroring the sidebar.

The board does not currently honour that:

| Signal         | Sidebar                                                            | Board                                | Consequence                                                   |
| -------------- | ------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------- |
| `failed`       | has it (`resolveSidebarV2Status`)                                  | absent                               | an errored session sits silently wherever it was placed       |
| done           | `effectiveSettled(...)` with auto-settle                           | `settledOverride === "settled"` only | auto-settled threads never drain — they sit on a lane forever |
| `snoozedUntil` | honoured                                                           | ignored                              | snoozed threads still stare at you from the board             |
| plan-ready     | v1 gates on `interactionMode === "plan"` and a settled latest turn | bare `hasActionableProposedPlan`     | false "review" states                                         |

So unifying the resolver is not cleanup. **It is the drain fix**, and it is the reason P1/P2 come first.

## Verdicts

### Modes: not added. `interrupt` stays on the lane.

`ProviderInteractionMode` is `["default", "plan"]` (`packages/contracts/src/orchestration.ts:125`), so plan-ready is downstream of a native mode axis. That made "add our own modes, one of which is grilling" a legitimate proposal — unlike the earlier board-level mode-tag axis, which was rejected.

It still loses, on this distinction: **plan converges, grilling does not.** Plan mode terminates in an artifact — the proposal, with an approval affordance — and that artifact landing is a genuine handoff. That is why `plan-ready` is derivable at all: it comes from `hasActionableProposedPlan`, an _artifact_ signal, with `interactionMode === "plan"` acting only as a gate. Grilling has no terminal artifact; its output is the conversation. There is no "grilling-ready" to derive.

So plan's "move" is already in the native model as artifact-landing attention, and needs no mode-level policy. Grilling's "badge" is a fact about _where the user's attention currently is_ — which only the lane encodes.

The quadrants confirm lane-level policy is correct:

|                                  | move lane                         | badge lane                           |
| -------------------------------- | --------------------------------- | ------------------------------------ |
| **plan mode, plan lands**        | moves to rail — the handoff       | badges — already watching            |
| **default mode, question lands** | moves to rail — genuine interrupt | badges — filed where attention lives |

Mode-level policy gets one quadrant wrong: a _default-mode_ session filed in the grilling lane would be yanked to the rail on every question despite being actively watched. The lane knows the user is watching; the mode cannot.

**What this defers:** the agent does not actually _behave_ like a grill — that stays a prompting concern. A real `grilling` interaction mode is legitimate future work, but it is adapter-and-prompt work across four provider adapters, pays off in agent behaviour rather than attention semantics, and the board needs **zero changes** when it lands. Mode stays orthogonal to placement.

### Default `interrupt` for new lanes: `"move"`

The rail is only a moat if silence means "nothing needs you". Badge is the opt-in for lanes actively tended. This also settles the plan question with no machinery: plan sessions live in ordinary move lanes, so plan-ready moves them.

**Uniform precedence rule: badge suppresses attention displacement only. The drain always applies** — a badge-lane session that settles still flows to Done; archived still leaves the board.

**Named failure mode:** a badge-lane session that stops being watched can sit pending indefinitely. The sidebar is the net. Time-based escalation is deliberately not in this plan.

### Hand-dropping into attention columns: removed, deliberately

The current code already apologises for the feature — `placementReason` emits "Placed here by hand — the session is idle" — because `active` is simultaneously a place you can drag to and a claim the runtime makes. The real loss is parking idle cards in Review/Active as self-reminders. Under dynamic lanes the replacement is strictly better: create "On deck" or "To review" as intent lanes with honest names.

### Also rejected (settled earlier, not to be relitigated)

Board-level mode-tag axis; propose-and-approve placement queues; agent-created and temporary lanes; lane `group` nesting; placement skills and system-prompt machinery; `confidence` fields; deterministic lifecycle states as columns.

The propose-and-approve rejection is worth restating: a proposal queue is a new inbox of placement decisions to adjudicate — the attention-moat system generating attention demands. A lane move is the most reversible action on the board; safety comes from provenance, user-always-wins, and visible attribution.

## Model

- **One shared runtime resolver** — `approval | input | working | connecting | failed | plan-ready | idle`. Derived, never persisted, never a column. Sidebar and board both consume it.
- **Lanes are pure intent** — a dynamic registry: name, description, order, interrupt policy. Human-created only.
- **One persisted thread field** — `{ laneId, placedBy: "user" | "agent", placedAt } | null`.
- **One fixed Needs-you rail** replaces the `active` / `blocked` / `review` columns and the inbox rail. Derived membership, non-droppable, system-gray, moves in real time.
- **Per-lane `interrupt: "move" | "badge"`.**
- **Agent self-placement is one MCP tool** on the already-injected per-thread toolkit, with a never-overwrite-user rule enforced in the decider.

Deterministic state renders as (a) each card's live status strip — gray at rest, colored and pulsing while working, flipping **in place** — and (b) the rail, the single surface where deterministic movement is physical. Cards never teleport out of the lane they were filed in.

## Work packets

Constraints in force for every packet: no Linear coupling; no schema change before P5; prefer editing existing files; commit per packet.

**Sequencing:** P1 → P2 → P3 → {P4 ∥ P5} → {P6 (needs both) ∥ P7 (needs P5)}

### P1 — Extract one shared runtime-state resolver (pure refactor)

**Goal:** one canonical derivation of a thread's runtime state, consumed by sidebar v1, sidebar v2 and the board, with zero behaviour change.

Three parallel derivations exist and disagree: `resolveThreadStatusPill` and `resolveSidebarV2Status` in `apps/web/src/components/Sidebar.logic.ts`, and `resolveRuntimeAttention` in `apps/web/src/board/boardLanes.ts`. All read the same `OrchestrationThreadShell` fields.

- Create `apps/web/src/state/threadRuntimeState.ts` exporting the canonical resolver. Adopt the **stricter v1 plan-ready gating** as canonical: `interactionMode === "plan" && isLatestTurnSettled(...) && hasActionableProposedPlan`.
- Reimplement both sidebar resolvers as thin projections. v2 deliberately folds `plan-ready` into `ready` — preserve that.
- Do **not** touch `boardLanes.ts` in this packet.

**Acceptance:** existing `Sidebar.logic.test.ts` passes unchanged. Add characterization tests asserting projections match pre-refactor output across a fixture matrix of every input boolean × session status. Add drift tests on the canonical resolver — these become P2's contract.

**Unverified:** module housing `effectiveSettled` / `isLatestTurnSettled` — `grep -rn "export function effectiveSettled\|export function isLatestTurnSettled" apps/web/src`.

**Depends on:** nothing. Lands alone.

### P2 — Inbox drain fix: board consumes the canonical state

**Goal:** auto-settled sessions drain to Done, snoozed sessions leave until they wake or raise their hand, failed sessions surface, plan-ready gating matches the sidebar.

Archived threads are already filtered in `SessionBoard.tsx` — leave that. Snooze semantics are defined on the `snoozedUntil` contract comment: suppressed until wake **or the thread raises its hand**.

- Replace `resolveRuntimeAttention` internals with the P1 resolver. Add `failed` to `RuntimeAttention`, mapped to the `blocked` lane with its own reason string.
- Replace `isNativelyDone` with `effectiveSettled`, wiring the same `autoSettleAfterDays` setting `SidebarV2` passes.
- Suppress snoozed threads **unless** attention is non-null.
- Adopt canonical plan-ready gating for `review`.

**Acceptance:** auto-settled → `done`; snoozed+idle → nowhere; snoozed+pending-approval → `blocked`; `session.status === "error"` → `blocked` with failed reason; `hasActionableProposedPlan` in `default` mode no longer produces `review`. Drift tests assert board and sidebar agree.

**Unverified:** whether a board lane test file exists — `grep -rn "resolveBoardPlacement" apps/web/src --include='*.test.*'`; create `boardLanes.test.ts` if not.

**Depends on:** P1.

### P3 — Per-lane interrupt policy

**Goal:** a session in a badge-policy lane is never displaced by attention; it lights up in place.

- Add `interrupt: "move" | "badge"` to each `BOARD_LANES` entry. `shaping` = `"badge"`, others `"move"`.
- In `resolveBoardPlacement`: when attention fires and `assignedLane` is a badge lane, return the assigned lane with `heldInPlace: true` on `BoardPlacement` (attention still populated). Done/drain precedence stays above this.
- Update `placementReason` for the held case. Render the badge on the card.

**Acceptance:** `hasPendingUserInput` + `shaping` stays put with `heldInPlace: true`; same fixture in `ready` moves to `blocked`; shaping fixture that is effectively settled moves to `done` (drain beats badge); pending-approval + shaping stays badged.

**Unverified:** `apps/web/src/components/board/BoardSessionCard.tsx` was never read. Inspect what it renders before adding the badge visual; reuse its existing reason/status affordance.

**Depends on:** P2.

### P4 — Native sidebar as the board's inbox view

**Goal:** on `/board` the native sidebar mounts as the exhaustive inbox view; the board's custom inbox rail is deleted.

`AppSidebarLayout.tsx` early-returns bare children when `pathname === "/board"`, with a comment about competing lists. That rationale is retired: the sidebar is the exhaustive view, the board shows only placed or attention-holding sessions. Unplaced sessions with active attention already appear on the board, so nothing hot can hide once the rail is gone; unplaced+idle becomes sidebar-only, which is intended.

- Remove the `isOnBoard` early-return and its comment. Verify the board's `h-dvh`/overflow styling survives inside `SidebarProvider`.
- Delete `InboxRail` and `INBOX_DROPPABLE_ID` from `SessionBoard.tsx`.
- Add "Place in lane…" and "Remove from board" to the sidebar row context menu, and "Remove from board" to the board card menu, writing via the existing `setWorkflowLane` command path.

**Acceptance:** board renders with the native sidebar; unplaced+idle appears in sidebar only; unplaced+pending-approval appears in Blocked; placing from the sidebar menu moves it onto the board; `resolveBoardPlacement` output unchanged by this packet.

**Unverified:** single-row context-menu plumbing in `Sidebar.tsx` / `SidebarV2.tsx`; whether `BoardSessionCard` has an existing menu. Do **not** attempt drag-from-sidebar-to-lane — `SidebarV2` DnD wiring is unverified; the menu is the v1 gesture.

**Depends on:** P3 (serializes edits to `SessionBoard.tsx`).

### P5 — Contracts + server: lane registry, widened `WorkflowLane`, provenance

**Goal:** lanes become data, the thread's lane field becomes a free identifier with provenance, and the decider enforces that agents never overwrite human placement. First schema-touching packet.

Event-sourced: follow the existing `ThreadWorkflowLaneSetCommand` pattern through `decider.ts` (~690) and `projector.ts` (~425). Client write path is `packages/client-runtime/src/operations/commands.ts` and `state/threadReducer.ts`.

- New `LaneDefinition`: `{ id: LaneId (branded non-empty string), name, description, order: number, interrupt: "move" | "badge" }`. Commands/events for lane create/update/archive through decider → projector → shell snapshot and stream. Seed with `shaping` (badge), `ready`, `done` (move).
- Widen `WorkflowLane` from literals to the branded string. **No migration script:** unknown or retired lane ids (`active`, `blocked`, `review`, deleted lanes) resolve client-side to unplaced with a visible "lane removed" note. The decider does not validate lane existence; the UI offers only real lanes, P7's tool validates at the tool layer, and the dangling rule covers deletion races.
- Extend the lane-set command with `placedBy: Schema.optional(Schema.Literals(["user","agent"]))` defaulting `"user"` — wire-compatible, same trick as `workflowLane` itself.
- **Decider rule:** reject a `placedBy: "agent"` set when current placement has `placedBy: "user"`. Agent may fill `null` or move its own placement.

**Acceptance:** decider tests for lane CRUD round-trip; agent-over-user rejected, agent-over-null and agent-over-agent accepted, user set always accepted and stamps `user`. Projector tests: registry in shell snapshot; legacy `workflowLane: "shaping"` payloads still decode. Contract decode tests for pre-board payloads.

**Unverified:** where projection seeds/defaults live server-side; whether shell stream events are the right carrier for registry updates. Read `decider.ts` and `projector.ts` around the cited lines first.

**Depends on:** P3 (for `interrupt` semantics). Parallel with P4.

### P6 — Dynamic board UI: registry-driven columns + Needs-you rail

**Goal:** columns come from the registry; `active`/`blocked`/`review` are replaced by one fixed, system-gray, non-droppable rail whose membership is derived and moves in real time.

Cards from `"move"` lanes with interrupting attention render in the rail instead of their column; badge-lane cards stay put and light up; unplaced+hot cards render in the rail. The rail is not droppable — membership is derived, so a drop there means nothing.

- Rework `SessionBoard.tsx` to map registry lanes to columns plus the rail; rework placement to target `{ laneId | "rail" | "done" | null }`; card status strip via the P1 resolver; minimal lane management (add / rename / describe / reorder / archive / toggle interrupt) as a popover or inline column-header editing — no settings page; dangling-lane note rendering.

**Acceptance:** move-lane+approval → rail; badge-lane+approval → stays, held; unplaced+working → rail; unplaced+idle → nowhere; settled anywhere → Done; dangling laneId → unplaced with note. Creating a lane adds a droppable column; archiving a lane with members leaves them unplaced with the note.

**Unverified:** `BoardSessionCard.tsx`; how Done renders once attention columns are gone — recommend keeping Done as the rightmost fixed column, since it is the drain outlet and part of the inbox metaphor.

**Depends on:** P4 and P5.

### P7 — Agent self-placement: `set_board_lane` MCP tool

**Goal:** a session files itself into a lane via one tool whose description carries the live lane registry.

T3 Code already injects a per-thread MCP server into provider sessions — `apps/server/src/mcp/McpHttpServer.ts` and `McpProviderSession`, wired in `ClaudeAdapter.ts` (~3521–3554). Thread identity is ambient in the MCP session.

- Add `set_board_lane` (params: `laneId`, optional `reason`) following the preview toolkit's registration pattern.
- **The tool must not take a session or thread id** — an agent must be structurally unable to move other sessions.
- Render the tool description dynamically from the lane registry (names, descriptions, interrupt hints). This is the entire prompt surface: no skill, no system-prompt append.
- Handler resolves the thread from `McpProviderSession`, validates `laneId`, emits the lane-set with `placedBy: "agent"`.
- Surface the decider's user-precedence rejection as a tool error. Extend `placementReason` to render "Filed here by the agent — {reason}".

**Acceptance:** places into a valid lane with agent provenance; unknown lane → tool error listing valid lanes; user-placed thread → rejection surfaced, placement unchanged; card shows provenance and reason.

**Unverified:** how preview toolkit handlers obtain thread context and dispatch orchestration commands (`apps/server/src/mcp/toolkits/preview/handlers.ts`) — mirror it exactly.

**Depends on:** P5. Parallel with P6.

## Deferred by verdict, not forgotten

- `grilling` as a real `ProviderInteractionMode` — provider-behaviour track, board-orthogonal, zero board changes when it lands.
- Time-based escalation out of badge lanes.
- Ghost runtime strip (watching lifecycle flow as chips).
- Drag from sidebar directly into a lane.
