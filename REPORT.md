# §1.3 and §1.4 — dead interactions

## Findings

Both sections still contained a reproducible dead interaction against `59d6220af`, although §1.3
had two layers and the ordinary §1.4 cell-to-cell path was already sound.

The feedback document named in the brief,
`docs/superpowers/specs/2026-08-04-session-board-polish-feedback.md`, is not present in this
worktree or in reachable git history. I read `AGENTS.md`, the supplied §0/§1.3/§1.4 text, and the
earlier `docs/superpowers/specs/2026-07-28-session-board-attention-model.md` before changing code.

### §1.3 — board composer

Commit `b65214ca4` had already fixed one audit-era cause by supplying
`sendDisabledReason: null`; without that prop `ChatComposer` treats the composer as disabled.
The remaining failure was a shell/detail loading race:

- `BoardSessionCard` can render immediately from its `SidebarThreadSummary` shell.
- `useThread(threadRef)` remains `null` until thread detail arrives.
- Enter and the arrow both correctly reached `ChatComposer.submitComposer`, but
  `useBoardThreadComposer.onSend` returned at `if (!thread || isWorking)`.
- The composer looked enabled because its provider, model, and visible shell state were already
  available.

The main route avoids the lie by disabling its composer while detail loads. The board does not need
to wait: every field required by `startTurn` already lives on the shell summary.

### §1.4 — card drag

The normal same-environment cell-to-cell path was internally sound: active ids match placed-card
keys, droppable ids round-trip their nested lane-column key, and the command wiring matches the
working context-menu path.

The branch-point continuous-board layout introduced a definite dead region. Only `LaneDropCell`
registered as droppable; the sticky header visually represented the same continuous lane but was
not a drop target. With `pointerWithin`, releasing over that header produced no collision, so
`handleDragEnd` received `over === null` and returned.

## Changes

- Board composer submission now derives its busy/sendable decision from the shell session and
  draft, not the optional thread detail.
- Project/worktree context, runtime mode, interaction mode, active thread id, and interrupt input
  also use the shell where detail is not required.
- Added `resolveBoardComposerSubmission` and focused tests for detail-absent sending, empty drafts,
  and starting/running sessions.
- Registered each sticky lane header as a droppable using the existing id format.
- Extracted `resolveBoardLaneDrop` so active-card lookup, droppable parsing, target lookup, and the
  environment guard are covered together.
- Added tests for header id round-tripping, a valid same-environment header drop, and rejection of
  a cross-environment target.

No new entity or store was added. The composer still writes the existing per-thread draft and sends
the existing thread; drag still dispatches the existing workflow-lane command.

## Verification

Failing tests were run before implementation:

- `npx vp test run apps/web/src/components/chat/useThreadComposer.test.ts`
- `npx vp test run apps/web/src/components/board/SessionBoard.logic.test.ts`

Final verification:

- `npx vp test run apps/web/src/components/chat/useThreadComposer.test.ts apps/web/src/components/board/SessionBoard.logic.test.ts` — 2 files, 26 tests passed.
- `cd apps/web && npx tsgo --noEmit` — passed.
- `npx vp lint apps/web/src/components/chat/useThreadComposer.ts apps/web/src/components/chat/useThreadComposer.test.ts apps/web/src/components/board/SessionBoard.tsx apps/web/src/components/board/SessionBoard.logic.ts apps/web/src/components/board/SessionBoard.logic.test.ts` — passed with no warnings.
- `git diff --check` — passed.

Per the brief, I did not start a dev server or use a browser.

## Deliberately left alone

- Project-divider bands and gutters are not drop targets. I did not add a `closestCorners` fallback:
  releasing outside a lane should not silently refile a thread.
- In a multi-environment board, project rows currently render cells for lanes owned by other
  environments. Those cells are visible but correctly rejected by the environment guard. Fixing
  their presentation requires a broader decision about cross-environment column layout, so I left
  it outside §1.4 and locked the guard down in a test.
- Mobile has no session-board surface. Web and the desktop wrapper share this implementation; the
  send and lane commands remain provider- and connection-mode agnostic.

## Expected conflicts

Another section touching the board layout may conflict in `SessionBoard.tsx` and
`SessionBoard.logic.ts`. The changes are narrow: one header droppable prop/ref, one derived
`environmentId` on placed entries, and replacement of the inline drag-end guard chain with the
equivalent tested resolver. Composer changes are isolated to `useThreadComposer.ts` and its test.
