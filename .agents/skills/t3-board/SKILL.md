---
name: t3-board
description: Inspect or move T3 Code threads on the client-local board with `t3 board`. Use only after an explicit user request.
---

# T3 Board

Use this skill only after an explicit user request about the T3 Code board or the current thread's lane.

The board is client-local. Every active sidebar thread is already on the board; snoozed and settled threads are excluded. The T3 client that started the current turn owns the persisted lane registry and sparse lane overrides. These commands ask that exact connected client to run the same move transition used by drag/drop, lane menus, and `/lane`. They do not create board membership or synchronize server-side board state.

## Commands

- `t3 board lanes` lists current workflow lanes with their stable IDs, live names, and descriptions.
- `t3 board lane` reports the current thread's effective lane and whether it uses a local override.
- `t3 board move <lane-id-or-exact-name>` moves the current thread. Prefer a stable lane ID after listing lanes; an exact unambiguous live name also works. Moving to Triage clears the override because Triage is the default lane.

Run one command at a time and report its receipt faithfully. Do not infer success from an exit code if the command printed an error.

If the originating client is disconnected, too old to host board commands, or did not answer, explain that the operation was not performed. Never retry against another client or suggest that server state was updated.

This command is unavailable to agents running on an external OpenCode server because that server does not inherit the scoped T3 process environment. Do not work around that by targeting another client or endpoint.
