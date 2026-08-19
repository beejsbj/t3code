import ChatView from "../ChatView.tsx";
import type { SpatialBoardSession } from "./SpatialBoardPrototype.tsx";

interface SpatialSessionSurfaceProps {
  readonly session: SpatialBoardSession;
  readonly live: boolean;
  readonly focused: boolean;
}

export function SpatialSessionSurface({
  session,
  live,
  focused,
}: SpatialSessionSurfaceProps): React.JSX.Element {
  return (
    <section
      data-spatial-session-live={live ? "true" : "false"}
      aria-label={session.thread.title}
      className="flex h-[760px] w-[1080px] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl ring-1 ring-black/5"
    >
      {live ? (
        <ChatView
          environmentId={session.threadRef.environmentId}
          threadId={session.threadRef.threadId}
          routeKind="server"
          reserveTitleBarControlInset={false}
          enableGlobalShortcuts={focused}
          autoFocusComposer={false}
          provideDiffWorkerPool={false}
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col bg-background" aria-hidden="true">
          <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center border-b border-border px-5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{session.thread.title}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {session.projectTitle} · {session.workflowLabel} · {session.boardStateLabel}
              </p>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            Moving session into view…
          </div>
        </div>
      )}
    </section>
  );
}
