import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { RuntimeMode } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleDashedIcon, FolderIcon, GitBranchIcon, ServerIcon } from "lucide-react";
import { useMemo } from "react";

import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { isElectron } from "../env";
import { useNowMinute } from "../hooks/useNowMinute";
import { useEnvironments } from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { Badge } from "./ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { buildBoardCards, groupBoardCardsByProject, type BoardCard } from "../board/board.logic";

const runtimeModeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

const statusLabels = {
  approval: "Needs approval",
  input: "Awaiting input",
  working: "Working",
  monitoring: "Monitoring",
  failed: "Error",
  ready: "Ready",
} as const;

const statusStyles = {
  approval: "border-amber-500/35 bg-amber-500/8 text-amber-700 dark:text-amber-300",
  input: "border-indigo-500/35 bg-indigo-500/8 text-indigo-700 dark:text-indigo-300",
  working: "border-sky-500/35 bg-sky-500/8 text-sky-700 dark:text-sky-300",
  monitoring: "border-sky-500/35 bg-sky-500/8 text-sky-700 dark:text-sky-300",
  failed: "border-red-500/35 bg-red-500/8 text-red-700 dark:text-red-300",
  ready: "border-border bg-muted/45 text-muted-foreground",
} as const;

const attentionStatuses = new Set<ReturnType<typeof resolveSidebarThreadStatus>>([
  "approval",
  "input",
  "failed",
]);

export function SessionBoard() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  useNowMinute();
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const activeThreads = useMemo(() => {
    const preciseNow = new Date().toISOString();
    // Lifecycle remains server-backed and follows the same client projection
    // as the sidebar. The board only reads this state; it never mutates it.
    return threads.filter((thread) => {
      if (thread.archivedAt !== null) return false;

      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now: preciseNow })) {
        return false;
      }

      return capabilities?.threadSettlement !== true || thread.settledOverride !== "settled";
    });
  }, [serverConfigs, threads]);
  const cards = useMemo(
    () =>
      buildBoardCards({
        threads: activeThreads,
        projects,
        environmentLabels,
      }),
    [activeThreads, environmentLabels, projects],
  );
  const sections = useMemo(() => groupBoardCardsByProject(cards), [cards]);
  const summary = useMemo(() => {
    let attention = 0;
    let working = 0;
    const environmentIds = new Set<string>();
    for (const card of cards) {
      const status = resolveSidebarThreadStatus(card.thread);
      if (attentionStatuses.has(status)) attention += 1;
      if (status === "working" || status === "monitoring") working += 1;
      environmentIds.add(card.thread.environmentId);
    }
    return { attention, working, environments: environmentIds.size };
  }, [cards]);

  const openThread = (thread: EnvironmentThreadShell) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <div
          aria-live="polite"
          className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
        >
          <h1 className="truncate text-sm font-semibold">Board view</h1>
          <span>
            {cards.length} active {cards.length === 1 ? "session" : "sessions"}
          </span>
          {summary.attention > 0 ? (
            <span className="text-amber-700 dark:text-amber-300">
              {summary.attention} need attention
            </span>
          ) : null}
          {summary.working > 0 ? <span>{summary.working} working</span> : null}
          {summary.environments > 1 ? <span>{summary.environments} environments</span> : null}
        </div>
      </WorkspacePageHeader>
      {sections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-lg">No active sessions</EmptyTitle>
            <EmptyDescription>
              Active sessions will appear here across your connected environments.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6 sm:py-7">
          <div className="mx-auto flex max-w-7xl flex-col gap-8">
            {sections.map((section) => (
              <section
                key={section.projectKey}
                aria-labelledby={`board-project-${section.projectKey}`}
              >
                <div className="mb-3 flex items-center gap-2">
                  <FolderIcon aria-hidden className="size-4 text-muted-foreground" />
                  <h2
                    id={`board-project-${section.projectKey}`}
                    className="text-sm font-semibold tracking-tight"
                  >
                    {section.projectTitle}
                  </h2>
                  <span className="text-xs text-muted-foreground">{section.cards.length}</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-3">
                  {section.cards.map((card) => (
                    <SessionBoardCard
                      key={`${card.thread.environmentId}:${card.thread.id}`}
                      card={card}
                      onOpen={openThread}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </main>
      )}
    </SidebarInset>
  );
}

function SessionBoardCard({
  card,
  onOpen,
}: {
  readonly card: BoardCard<EnvironmentThreadShell, EnvironmentProject>;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const { project, thread } = card;
  const status = resolveSidebarThreadStatus(thread);
  const runtime = thread.session?.providerName ?? String(thread.modelSelection.instanceId);
  const model = thread.modelSelection.model;
  const projectCwd = project?.workspaceRoot ?? thread.worktreePath ?? "";

  return (
    <button
      type="button"
      className="group flex min-h-36 min-w-0 cursor-pointer flex-col rounded-xl border border-border/80 bg-card p-4 text-left shadow-sm/5 outline-none transition-colors hover:border-foreground/20 hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label={`Open session ${thread.title}`}
      onClick={() => onOpen(thread)}
    >
      <div className="flex min-w-0 items-start gap-2">
        <ProjectFavicon
          environmentId={thread.environmentId}
          cwd={projectCwd}
          faviconPath={project?.faviconPath}
          className="mt-0.5 size-4"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{thread.title}</span>
        <Badge className={statusStyles[status]} size="sm" variant="outline">
          {statusLabels[status]}
        </Badge>
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          <ServerIcon aria-hidden className="size-3.5 shrink-0" />
          {card.environmentLabel ?? thread.environmentId}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          <CircleDashedIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate" aria-label={`${runtime} · ${model}`}>
            {runtime} · {model}
          </span>
        </span>
      </div>
      <div className="mt-auto flex min-w-0 items-end justify-between gap-3 pt-4 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          {thread.branch ? <GitBranchIcon aria-hidden className="size-3.5 shrink-0" /> : null}
          <span className="truncate">{thread.branch ?? "No branch"}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-muted-foreground/70">
          <span>{runtimeModeLabels[thread.runtimeMode]}</span>
          <Tooltip>
            <TooltipTrigger
              render={<span>Updated {formatRelativeTimeLabel(thread.updatedAt)}</span>}
            />
            <TooltipPopup>{new Date(thread.updatedAt).toLocaleString()}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
    </button>
  );
}
