# BJS-286 — Live session board (web prototype)

Receipt for the smallest runnable web-only prototype where a real live session **is** the card on a
spatial work board.

## Branch and base

|             |                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree    | `/home/admin/Projects/T3code-bjs-286`                                                                                                             |
| Branch      | `bjs-286-live-session-board`                                                                                                                      |
| Base commit | `5ba6ef7f84a5586e3795264cae348404dd408cb5` — "Use tarball archiving for hosted web deploys (#4669)", upstream `pingdotgg/t3code` main, 2026-07-27 |

Built against current upstream main rather than a nightly tag. Nothing in the work needed a pinned
revision, and the newest observed nightly (`v0.0.29-nightly.20260727.922` at `80ead5f3a774`) is an
ancestor of this base.

The issue's earlier file/command suggestions were stale and were **not** followed. The current
development surface is `vp run dev` from the repo root (a worktree-local `.t3` state dir, ports
derived from the worktree path), and per `AGENTS.md` verification is focused `vp` commands plus one
integrated browser pass with the `test-t3-app` skill — no repo-wide `vp check`.

## What was built

`/board` is a single web workspace: an **Inbox rail** (the source queue — sessions with no lane) on
the left, six lanes to its right. Every card is a real live session, not a summary or a task
entity. The app sidebar is suppressed on this route so the board's inbox is the only session queue
on screen.

Each card embeds a real compact chat surface:

- **Timeline** — real `OrchestrationMessage`s from the live per-thread subscription, rendered with
  the app's real `ChatMarkdown` (shared highlighter + LRU cache, so the cost is not multiplied per
  card). Compact cards show the last 6 messages, a zoomed card the last 40.
- **Composer** — the real Lexical `ComposerPromptEditor`, writing to the real per-thread
  `composerDraftStore`, so a draft typed on a card is the same draft the full chat view sees.
  Sending dispatches the real `thread.turn.start` command.
- **Slash commands** — real `detectComposerTrigger` → real `searchSlashCommandItems` → real
  `ComposerCommandMenu`. Built-ins (`/plan`, `/default`) switch interaction mode; provider commands
  come from the live provider snapshot.
- **Attachments** — image paste and file picker into the real draft store, uploaded as
  `dataUrl` attachments on the turn.
- **Approval / pending-question attention** — real `derivePendingApprovals` /
  `derivePendingUserInputs`, with real `thread.approval.respond` and `thread.user-input.respond`.
- **Provider / model control** — compact picker writing the real `thread.meta.update`.
- **Activity** — native status dot via the app's own `resolveSidebarV2Status`, plus a working
  indicator and an Interrupt button that dispatches the real `thread.turn.interrupt`.

**Zoom** expands the same mounted card via CSS (`position: fixed`) while its slot holds place in the
lane. No route change, no remount, no different object. **Resize** is a direct vertical drag handle;
a compact/tall toggle snaps between presets. There are no arrow buttons anywhere.

## State mapping and precedence

`apps/web/src/board/boardLanes.ts` is the whole model; `resolveBoardPlacement` is the single entry
point.

Lanes split into two classes:

| Class     | Lanes                         | Authority   |
| --------- | ----------------------------- | ----------- |
| Intent    | `shaping`, `ready`, `done`    | the human   |
| Attention | `active`, `blocked`, `review` | the runtime |

**Precedence, highest first:**

1. **`blocked`** — `hasPendingApprovals || hasPendingUserInput`. Outranks everything including a
   settle pin: burying a session that is waiting on a human is the failure this board exists to
   prevent.
2. **`done` (native)** — `settledOverride === "settled"`. `archivedAt` is deliberately _not_ part of
   this: archived sessions are filtered off the board entirely, so folding it in would be dead code.
3. **Other runtime attention** — `active` when `session.status` is `running`/`starting`; `review`
   when `hasActionableProposedPlan`.
4. **Assigned lane** — the persisted `thread.workflowLane`.
5. **Inbox** — no attention, never placed (`lane === null`).

Runtime attention **displaces** a card; it never writes. `placement.assignedLane` always carries the
persisted value untouched, `placement.overridden` says whether attention is currently displacing it,
and the card renders the reason ("Held here while the agent is working — assigned to Ready"). When
the run ends the card returns to its assigned lane on its own.

Drag/drop writes **only** `workflowLane`. Dropping a working session into "Ready" records the intent
and the card visibly stays held in "Active" until the turn finishes.

A card parked in an attention lane by hand — assigned `active` while idle — is labelled "Placed here
by hand — the session is idle", so the board never claims the agent is doing something it isn't.

### The one added session-owned field

Everything runtime is already derivable from native state. What is not derivable is human intent:
"still shaping this" and "groomed, ready to pick up" are identical to the runtime (idle session,
nothing pending), and a drag gesture is a statement no runtime signal can stand in for. That gap —
and only that gap — is what the field stores.

`workflowLane: "shaping" | "ready" | "active" | "blocked" | "review" | "done" | null` was added to
`OrchestrationThread` and `OrchestrationThreadShell` as an optional-nullable field (pre-field servers
still decode), with one command/event pair modelled exactly on the existing
`thread.runtime-mode.set` / `thread.runtime-mode-set` path:

`thread.workflow-lane.set` → decider → `thread.workflow-lane-set` → projection pipeline →
`projection_threads.workflow_lane` (migration `035`), and in-memory projector + client reducer for
the live read model. `null` returns a session to the inbox.

Card height and which card is zoomed are client-only (`localStorage`, `t3code:board-cards:v1`),
deliberately: those are properties of _this screen_, not of the session, and should not follow it to
another device.

## Files changed

New:

```
apps/web/src/board/boardLanes.ts                 lane model + precedence (+ .test.ts, 20 tests)
apps/web/src/board/boardCardStore.ts             per-card height / zoom, localStorage
apps/web/src/components/board/SessionBoard.tsx   workspace: inbox rail + lanes + dnd-kit
apps/web/src/components/board/BoardSessionCard.tsx   card, timeline, attention strip, zoom, resize
apps/web/src/components/board/BoardCardComposer.tsx  live composer, slash menu, attachments, send
apps/web/src/components/board/BoardCardModelPicker.tsx
apps/web/src/components/board/useInViewport.ts
apps/web/src/routes/_chat.board.tsx
apps/server/src/persistence/Migrations/035_ProjectionThreadsWorkflowLane.ts
docs/receipts/bjs-286-live-session-board.md
```

Modified:

```
packages/contracts/src/orchestration.ts                    WorkflowLane, field, command, event, payload
packages/client-runtime/src/operations/commands.ts         setThreadWorkflowLane
packages/client-runtime/src/state/threadCommands.ts        threadEnvironment.setWorkflowLane
packages/client-runtime/src/state/threadReducer.ts         thread.workflow-lane-set
apps/server/src/orchestration/decider.ts                   command → event
apps/server/src/orchestration/Layers/ProjectionPipeline.ts event → SQLite
apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts  read side (4 SELECT + 6 assembly sites)
apps/server/src/orchestration/projector.ts                 in-memory read model
apps/server/src/orchestration/Schemas.ts                   payload re-export
apps/server/src/persistence/Services/ProjectionThreads.ts  row schema
apps/server/src/persistence/Layers/ProjectionThreads.ts    upsert + selects
apps/server/src/persistence/Migrations.ts                  register 035
apps/server/src/persistence/Layers/ProjectionRepositories.test.ts  round-trip coverage
apps/web/src/components/AppSidebarLayout.tsx               suppress app sidebar on /board
apps/web/src/components/CommandPalette.tsx                 "Open session board" action
apps/web/src/routeTree.gen.ts                              generated
```

## How to run and verify

```bash
cd /home/admin/Projects/T3code-bjs-286
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PWD/node_modules/.bin:$PATH"
pnpm install          # only needed once; node 24 via corepack pnpm 11.10.0
vp run dev
```

Read the actual ports from the `[dev-runner]` line. In this run:

- server `14148`, web **`http://localhost:6108`**, base dir `<worktree>/.t3`
- verified URL: **`http://localhost:6108/board`**
- also reachable from the command palette → "Open session board"

Authenticate the controlled browser once with the printed `/pair#token=…` URL (single use — not
recorded here).

## Focused checks and actual results

| Check                                                | Command                                                                                                           | Result                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Lane model unit tests                                | `cd apps/web && vp test run src/board/boardLanes.test.ts --project unit`                                          | **20 passed**                                                                                                     |
| Server projection round-trip (incl. `workflow_lane`) | `cd apps/server && vp test run src/persistence/Layers/ProjectionRepositories.test.ts`                             | **3 passed**                                                                                                      |
| Typecheck                                            | `vp run --filter @t3tools/web --filter @t3tools/contracts --filter @t3tools/client-runtime --filter t3 typecheck` | **clean** (only pre-existing `TS377019` effect suggestions)                                                       |
| Lint                                                 | `vp lint apps/web/src packages/contracts/src`                                                                     | no new warnings; all remaining warnings are pre-existing (`ChatMarkdown`, `CommandPalette`, `useHandleNewThread`) |
| Format                                               | `vp fmt apps/web/src packages/contracts/src packages/client-runtime/src apps/server/src`                          | applied                                                                                                           |

Repo-wide `vp check` / `vp run test` were **not** run, per `AGENTS.md`.

### Integrated browser verification (`test-t3-app`, real sessions only)

Four real sessions were created through the UI in a real git project
(`/home/admin/t3-board-demo`), each with a real provider round-trip (Claude Haiku 4.5). No seeded
fixtures were used for any interaction.

| #   | Interaction                                   | Result                                                                                                                                                    |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Drag a real session Inbox → Ready             | card moves; `projection_threads.workflow_lane = 'ready'` in SQLite — real command → event → projection, not client state                                  |
| 2   | Type + send from the card's embedded composer | real turn started; user message and assistant reply (`15`) appear in the card timeline                                                                    |
| 3   | Runtime attention override                    | card moved itself Ready → **Active** while the turn ran, banner "Held here while the agent is working — assigned to Ready", Send replaced by Interrupt    |
| 4   | Attention clears                              | card returned to **Ready** by itself; `workflow_lane` still `'ready'` — assignment never overwritten                                                      |
| 5   | Zoom / collapse                               | roomier chat with full timeline; URL stayed `/board` throughout; card stayed in its lane; composer draft survived both transitions (no remount)           |
| 6   | Slash commands                                | `/` opened the real menu: built-ins `/plan`, `/default` plus real provider commands from this host (`/fiscal`, `/frontend-design`, `/ios-debugger-agent`) |
| 7   | Resize                                        | drag handle 260px → 440px, still 440px after a full page reload                                                                                           |
| 8   | Lane → lane drag                              | Done → Ready → Blocked, each persisted                                                                                                                    |
| 9   | Drop outside any lane                         | **no-op** — nothing written (verified after the collision-detection fix)                                                                                  |
| 10  | Manual placement honesty                      | idle session dragged to Blocked renders "Placed here by hand — the session is idle"                                                                       |
| 11  | Viewport gating                               | at a 380px viewport, 3 of 4 cards mounted a live surface and 1 stayed a placeholder; scrolling mounted the 4th                                            |

**Product verdict: met.** The embedded surface is a real session — sending from a card starts a real
turn, and the card's lane is a real server-persisted property of that session.

## Performance findings

Measured in the controlled browser (`performance.memory`, DOM node count, 60-frame rAF sampling):

|                         | live cards | Lexical editors | DOM nodes | JS heap | frame median / max |
| ----------------------- | ---------- | --------------- | --------- | ------- | ------------------ |
| `/board`                | 4          | 4               | 349       | 151 MB  | 16.7 ms / 16.8 ms  |
| single `ChatView` route | —          | 1               | 495       | 169 MB  | 16.7 ms / 33.3 ms  |

**Four live board cards cost less than one full `ChatView`, and drop no frames where the single
chat route drops one.** That is the measurement that justified the central architectural decision:
`ChatView` is 6,094 lines and its default export mounts a private `DiffWorkerPoolProvider` (2–6 real
Web Workers plus a 240-entry AST cache) _per instance_, registers a capture-phase `window` keydown
handler that would type into every card at once, steals focus on mount, and calls the router's
`navigate()`. Embedding N of it was not viable, so the card is a separate small surface that reuses
the safe parts (the real editor, the real draft store, the real command menu, the real commands).

Cost control actually implemented:

- **Viewport gating** (`useInViewport`, `rootMargin: 300px`) — a card that has never been scrolled
  into view mounts no chat surface at all. Verified above.
- **Message tail** — 6 messages compact, 40 zoomed, instead of full history.
- **Shared caches** — `ChatMarkdown`'s highlighter and highlighted-code LRU are module-level, so
  markdown cost is not multiplied per card.

## Independent review

An independent second opinion was obtained from **Hermes CLI** using the locally configured GPT Sol
model: provider `openai-codex`, model `gpt-5.6-sol` (confirmed present in
`~/.hermes/provider_models_cache.json` before use). It was run read-only against a copy of the board
sources in a scratch directory, never against this worktree, and never concurrently with edits:

```bash
hermes chat --provider openai-codex -m gpt-5.6-sol -Q --cli --max-turns 25 --ignore-rules -q '<review prompt>'
```

Findings acted on:

1. **Enter could start a second turn while the session was working** — fixed: synchronous `sendingRef`
   guard plus an `isWorking` check in both `send()` and the Enter handler.
2. **A drop outside any lane still wrote a lane** — fixed: collision detection is now `pointerWithin`
   only, with no `closestCorners` fallback. Verified as a no-op above.
3. **Zoom could remount the chat surface** — correct: swapping `cardBody` for a fragment changed the
   child sequence. Fixed by always rendering the placeholder (hidden when not focused) so the element
   structure is stable. Verified: the composer draft now survives zoom and collapse.
4. **Multi-question requests submitted a partial answer** — fixed: all questions render, answers are
   collected, and one response carries them all; submit stays disabled until every question is
   answered.
5. **Resize leaked listeners and wrote `localStorage` every pointermove** — fixed: height is local
   during the drag and committed once on release; `pointercancel` and unmount both tear down.
6. **Precedence contradicted the persistence rationale** — fixed: lanes are now explicitly split into
   intent and attention classes; a hand-placed attention lane is labelled as such; `blocked` was
   raised above native-done; the dead `archivedAt` branch was removed.

Separately, laying the board out at fixed 340px lanes put four of six lanes off-screen at 1680px
wide, making their cards unreachable. Lanes now flex to share the available width
(`flex-1 basis-0 min-w-[212px]`) and the whole board fits with no horizontal overflow.

## Incomplete or knowingly deferred

- **A card remounts when runtime attention moves it between lanes.** dnd-kit columns are separate
  React parents, so an identical key does not preserve the subtree across them. The _session_ is
  unaffected — the draft store is thread-keyed and the thread atom has a 5-minute idle TTL, so
  re-subscription is cheap — but the claim "never remounts" is true only for zoom, not for lane
  moves. A flat absolutely-positioned layout would fix it and was out of scope here.
- **`useInViewport` latches (`once: true`).** A card that has been seen keeps its subscription and
  editor for the rest of the page's life, so cost is bounded by _cards ever viewed_, not cards
  visible. Fine at the measured scale; a bounded LRU or a release-after-grace-period is the follow-up
  for a large board.
- **Slash-command insertion is not cursor-aware.** Selecting a provider command replaces the trigger
  range in the draft text; it does not reposition the Lexical caret the way the full composer's
  `applyPromptReplacement` does.
- **`/plan` and model changes are fire-and-forget.** Neither awaits its command before the next send
  reads `thread.interactionMode` / `thread.modelSelection`, so a very fast send after either could
  use the previous value. Failures are silent (`reportFailure: false`).
- **No terminal, diff, preview, plan sidebar, or checkpoint UI on a card.** These are the parts of
  `ChatView` that are genuinely expensive or genuinely need the full route; zoom shows a roomier
  chat, not the full right-panel stack.
- **Approval strip shows one approval and one question request at a time** (the first of each).
- **Not verified on mobile.** This is a web-only prototype per the brief; `test-t3-mobile` was not
  run.
- **Not committed as multiple commits, not pushed.** No PR, no Linear or Cockpit changes, no
  GitHub settings touched, per the brief.

## Out of scope, as briefed

No Linear sync, no Linear comments as transport, no one-to-one Linear binding. Nothing under
`.repos/` was read into the build or edited. The primary clone `/home/admin/Projects/T3code` was not
touched. The old desktop/Electron prototype was not reused.
