# Session Board

The session board is an alternate workspace for keeping several live coding-agent sessions visible
at once. Open **Board** from the sidebar or use the command palette.

The normal chat workspace remains available at `/`. The board lives at `/board` and uses the same
sessions, messages, composer, approvals, questions, and provider controls. A server-backed card is
not a separate task or summary of a session; unsent drafts are labeled explicitly.

## Arrange Sessions

Every active sidebar session exists on the board except snoozed, settled, or archived sessions.
Content-bearing new-thread drafts also appear as cards; an empty new-thread placeholder does not.
The default workflow runs from **Triage** through **Blocked**, **Ready**, **In Progress**, and
**Review**. New sessions and sessions without an explicit workflow override start in Triage. Triage
is fixed at the left edge; the other workflow lanes can be created, renamed, described, reordered,
and archived.

Use **Columns** and **Rows** to choose the spatial organization. Columns can be **Workflow** or
**State**. Rows can be **Project**, **State**, or **None**. State cannot be both axes at once; choosing
it on one axis moves the other axis to a valid choice. Project, workflow, and state remain visible on
every card regardless of which dimensions organize the board.

Workflow lanes are the board's user-defined, draggable placement. State is derived from the live
session and includes Draft, Approval, Input, Failed, Working, Idle, Snoozed, and Settled. Plan-ready
sessions fold into Input, while connecting and monitoring sessions fold into Working. A completed
session rests in Idle even when its card still carries the green **Done** treatment, so merely
focusing it does not move it to another state group. Archived sessions remain hidden, matching the
sidebar.

Drag a column's right edge to change its width, and drag the bottom of a normal card to change that
card's height. Wide columns automatically pack cards into additional visual columns. A card never
grows beyond 428 pixels, and a board column can grow to 1316 pixels. This packing is presentational:
it does not create more workflow lanes or change card order. New cards open at the full working
height, and that height is also the resize minimum; cards can be made taller but not compacted below
it. There is no separate compact-size mode.

Projects are listed alphabetically when used as rows. State groups stay in a fixed order, including
empty state rows, so the spatial map does not collapse when its last card moves. In a state-organized
view, cards move as their live state changes. A workflow lane defaults to newest arrival first—using
the time a card was created or moved into that lane—and dragging a card within or between workflow
columns saves that manual placement locally. State columns are read-only presentation columns.

Each card header has quick actions to snooze or settle the session. Its context menu offers the same
thread actions as the sidebar, along with workflow lane placement. The checkout icon identifies the
repository, branch, and workspace path on hover. Snoozing, settling, or archiving removes a session
from both active views; there is no board-only membership toggle.

Sending from a card behaves like sending from the normal chat workspace: the message appears
immediately, the timeline keeps its place, and a message sent while the agent is working steers the
active turn. The compact turn rail at the left of the timeline remains available for moving between
earlier parts of the conversation.

Card status uses the same glyphs and hues as the sidebar. The full border carries the state color and
the card surface carries a very light wash of that hue, so working, completed, waiting, and failed
sessions remain easy to scan.

Lane definitions, widths, ordering, and session placements are saved by the client displaying the
board. They survive reloads on that browser or desktop installation. They are not synchronized to
T3 Code environments or to another client, so the same session can be arranged differently on two
devices.

Tabs from the same browser profile reconcile board changes through local storage. If two tabs edit
the board at exactly the same time, the last saved local change wins.

## Work Across Environments

One board shows sessions from every environment connected to that client. Each card identifies its
environment, and disconnected environments are labeled honestly. A disconnected card may remain
visible from cached state, while sessions from reachable environments continue to work normally.

Project rows use the same logical project identity as the sidebar. Matching clones of one repository
can therefore appear under one project heading even when they belong to different environments.
Choose **None** for rows to view all sessions directly in each column.

## Focus and Expand

Selecting a session in the sidebar while `/board` is open reveals its whole card instead of
navigating away. The board scrolls in both directions when needed, including for cards packed beside
each other, and keeps the card below the sticky board headings. The reveal is smooth unless reduced
motion is enabled. Select the focused session again, or use the expand control on its card, to open
an 80%-sized chat over the board. Focusing a card smoothly reveals the matching session in the
sidebar. Close the expanded view to return to the same spatial workspace.

A new thread started from the board opens in that expanded view. Once it contains user content,
closing the expanded view leaves a Draft card on the board. Project rows have their own new-thread
button and supply the project automatically. On first send, the Draft card hands off to the real
thread card without showing both. A new thread started from a full-screen thread route stays in the
classic full-screen route flow. Returning to **Board** always closes any old expanded view first.

The responsive web board remains available at phone-sized browser widths. Adaptive multi-card
packing is intended for desktop-width web and the desktop app. A dedicated React Native board is not
included yet.

From a web or desktop thread composer, `/board` opens this board and `/lane` lists the current
workflow lanes. Choosing a lane updates only that scoped environment and thread on the current
client. Choosing Triage clears any explicit workflow override. These local commands are not
registered by the React Native app while it has no dedicated board.

## Use Board Commands From An Agent Or Shell

The board skill is opt-in. Install it in a project, then start a new provider session so the provider
can discover the ordinary project-local skill:

```bash
t3 board skill install --directory /path/to/project
```

After an explicit request, an agent can run `t3 board lanes`, `t3 board lane`, or
`t3 board move <lane>`. Those commands apply only to the current thread on the client that started
the turn. If that client is unavailable, the command fails instead of choosing another client.

For manual use from a shell, first list the board-capable windows connected to that T3 server:

```bash
t3 board clients
t3 board lanes --client <client-id>
t3 board lane --client <client-id> --thread <thread-id>
t3 board move <lane> --client <client-id> --thread <thread-id>
```

Client IDs identify one browser tab or desktop renderer for its current lifetime. Run
`t3 board clients` again after reloading that window. Manual targeting is unavailable inside an
agent process, which remains restricted to its originating client and current thread.
