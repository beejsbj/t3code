---
name: t3-board
description: Inspect or move this thread's card on the user's T3 Code session board with the `board_lanes` and `board_move` MCP tools. Use only after an explicit user request.
---

# T3 Board

Use this skill only after an explicit user request about the T3 Code board or this thread's lane, directly or through standing instructions.

The board is client-local. Each T3 Code web or desktop window keeps its own lanes and card placements; the server stores none of it. Every active sidebar thread is already on the board, so there is nothing to add or remove.

## Tools

Both tools come from the `t3-code` MCP server and act only on the thread you are running in.

- `board_lanes` lists the workflow lanes with stable ids, names, and descriptions, and reports this thread's current lane.
- `board_move` moves this thread's card. Pass a lane id from `board_lanes`, or an exact lane name. Moving to Triage clears the card's override, because Triage is the default lane.

Both results name the window that answered. `routing: "origin"` is the window that last sent a message to this thread. `routing: "only-client"` means that window is unknown or closed and the only open board was used.

## Failures

Report a failure as it is: nothing was changed. The tools fail when no T3 Code window is open, when several boards are open and the window that last messaged this thread is gone, or when the window does not answer in time. Do not retry against another window or claim the server's state changed. If the user wants the move, ask them to send a message to this thread from the window whose board should change, then try again.
