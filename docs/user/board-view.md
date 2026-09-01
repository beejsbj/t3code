# Board view

Board view gives you one compact overview of active agent sessions across your connected
environments. It is useful when several agents are working at once and the thread sidebar no
longer answers the immediate question: which sessions need attention?

## Open Board view

Use any of these entry points:

- Select **Board view** in the sidebar.
- Choose **Open Board view** from the command palette.
- Press `mod+alt+shift+b`. You can replace this shortcut in **Settings** → **Keybindings**.
- Visit `/board` directly.

The shortcut works from both the web and desktop clients. Like other global navigation shortcuts,
it stays inactive while the terminal has focus so it cannot consume terminal input.

## What appears

Board view reads the same live session state as the rest of T3 Code. It includes active sessions
from every connected environment and groups them by project, without copying or synchronizing
those sessions into a second store.

Settled, snoozed, and archived threads stay out of Board view. Sessions that need your attention,
such as a pending approval or input request, remain visible.

Each card shows the context needed to distinguish simultaneous sessions:

- Session title and project
- Environment and branch
- Provider model and runtime mode
- Current status, including working, awaiting input, approval, monitoring, failure, or ready

Status comes from the same provider and server projections as the thread sidebar. **Working** means
the provider is currently running a turn or live background work is in progress. **Awaiting input**
and **Needs approval** identify sessions where progress depends on you. **Monitoring** identifies a
session following background work, while **Completed** marks finished work you have not visited yet
and **Ready** is active but currently idle. A failed turn remains visible as **Error** so it is not
lost among idle sessions.

The page header summarizes sessions that need attention or are still working. Each card also shows
when its session last changed, so an older idle session does not look equivalent to fresh activity.

Environment names remain visible even when projects share a title. This matters when a local server,
a desktop-hosted server, and a remote environment expose similar workspaces: selecting the card still
routes to the environment that owns the session.

Select a card to open its canonical thread. You return to the same conversation, worktree, and
provider session shown elsewhere in T3 Code; the card is a view of that session, not a new task or
duplicate thread.

Board view updates as connected environments publish new session state. A disconnected environment
does not become a separate cached workflow; when its live sessions are available again, they return
through the normal environment connection.

## Current scope

Board view is an overview and navigation surface. Session lifecycle remains owned by the server and
the existing thread controls. The board does not assign workflow state, move work between lanes, or
embed a second chat composer.

The standard sidebar remains available, so projects, settings, usage, and updates keep their usual
navigation paths while Board view is open.

Card placement follows a responsive project grid, so the same page remains readable as the window
or desktop shell changes size. Custom lanes, persistent placement, and manually resizable cards are
not part of the current Board view.
