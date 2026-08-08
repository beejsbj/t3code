# §3.2 lifecycle lanes

## Reproduction

The defect still reproduced at `59d6220af`. `boardLaneCollapsedByDefault` correctly hid lifecycle cards, but both the sticky header and every project-grid row used `repeat(..., 380px)`. Settled and Snoozed therefore still consumed a full workflow-lane column; the only visual distinction was `bg-muted/25`.

The requested spec file is not present in this worktree (`docs/superpowers/specs/2026-08-04-session-board-polish-feedback.md`); I used the supplied §3.2 brief alongside the lane-model header and current board code.

## Root cause and change

The shared grid template treated every lane as the same width, so the existing collapsed-by-default state removed cards without reclaiming the empty horizontal budget.

Collapsed Settled and Snoozed lanes now render as 112px rails. Expanding either restores its 380px chat-card column consistently in the sticky header and every project band. The helper is tested directly. Their resting state drops the description and uses the sidebar’s established language: Settled is muted; Snoozed has the existing blue cue. The live cards themselves remain opaque and fully legible when a lifecycle lane is expanded; the lane, not a translucent treatment over chat, carries the de-emphasis.

I deliberately did not alter lane classification, lifecycle commands, board focus, or card state.

## Verification

Passed:

```sh
npx vp test run apps/web/src/components/board/SessionBoard.logic.test.ts
npx vp lint apps/web/src/components/board/SessionBoard.tsx apps/web/src/components/board/SessionBoard.logic.ts apps/web/src/components/board/SessionBoard.logic.test.ts
cd apps/web && npx tsgo --noEmit
git diff --check
```

I did not launch a dev server or use a browser, per the task constraints.

## Expected conflicts

No expected conflict with the other sections: this changes only `SessionBoard` presentation and its local layout helper/test. It retains the shared continuous-grid layout from §3.1.
