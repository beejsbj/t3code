---
name: t3-board
description: Operate the current T3 Code thread's client-local board placement with `t3 board`. Use only when the user explicitly asks to inspect or change board placement.
---

# T3 Board

Use this skill only after an explicit user request about the T3 Code board or the current thread's lane placement.

The board is client-local. The T3 client that started the current turn owns the persisted lane registry and placement. These commands ask that exact connected client to run the same store transitions used by drag/drop, placement menus, and `/lane`. They do not create or synchronize server-side board state.

## Commands

- `t3 board lanes` lists current workflow lanes with their stable IDs, live names, and descriptions.
- `t3 board placement` reports whether the current thread has an explicit placement and its effective lane.
- `t3 board place <lane-id-or-exact-name>` places the current thread. Prefer a stable lane ID after listing lanes; an exact unambiguous live name also works.
- `t3 board unplace` removes the explicit placement. The receipt may still report Triage as the effective lane because unplaced threads resolve there implicitly.

Run one command at a time and report its receipt faithfully. Do not infer success from an exit code if the command printed an error.

If the originating client is disconnected, too old to host board commands, or did not answer, explain that the operation was not performed. Never retry against another client or suggest that server state was updated.
