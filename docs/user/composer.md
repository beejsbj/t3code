# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On web and desktop, `/board` opens the live session board. Use `/lane` from an existing thread to
choose one of this client's current workflow lanes, or enter `/lane <lane name>` as a standalone
command. `/lane unplace` removes the explicit placement and returns the thread to the default Triage
placement. These commands update only the client displaying the board and are never sent to the
provider. Lane choices update when lanes are created, renamed, or archived; each lane does not become
a separate slash command.

The React Native mobile app does not currently include the session board or register these two local
commands. Slash text entered there continues through the normal provider path. On web and desktop,
local commands act only when they are standalone and have no attachments or added context; otherwise
the composer preserves the message as ordinary provider input.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.
