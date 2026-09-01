import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RuntimeMode, TimestampFormat } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleDashedIcon, FolderIcon, GitBranchIcon, ServerIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { isElectron } from "../env";
import { useNowMinute } from "../hooks/useNowMinute";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "../timestampFormat";
import { useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "./Sidebar.logic";
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
  completed: "Completed",
  ready: "Ready",
} as const;

const statusStyles = {
  approval:
    "border-amber-500/35 bg-amber-500/8 text-amber-700 dark:bg-amber-500/16 dark:text-amber-300",
  input:
    "border-indigo-500/35 bg-indigo-500/8 text-indigo-700 dark:bg-indigo-500/16 dark:text-indigo-300",
  working: "border-sky-500/35 bg-sky-500/8 text-sky-700 dark:bg-sky-500/16 dark:text-sky-300",
  monitoring: "border-sky-500/35 bg-sky-500/8 text-sky-700 dark:bg-sky-500/16 dark:text-sky-300",
  failed: "border-red-500/35 bg-red-500/8 text-red-700 dark:bg-red-500/16 dark:text-red-300",
  completed:
    "border-emerald-500/35 bg-emerald-500/8 text-emerald-700 dark:bg-emerald-500/16 dark:text-emerald-300",
  ready: "border-border bg-muted/45 text-muted-foreground dark:bg-muted/45",
} as const;

type BoardThreadStatus = ReturnType<typeof resolveSidebarThreadStatus> | "completed";

const attentionStatuses = new Set<BoardThreadStatus>(["approval", "input", "failed", "completed"]);

function resolveBoardThreadStatus(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
): BoardThreadStatus {
  const status = resolveSidebarThreadStatus(thread);
  if (status !== "ready") return status;
  return hasUnseenCompletion({ ...thread, lastVisitedAt }) ? "completed" : "ready";
}

export function SessionBoard() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const threads = useThreadShells();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { environments, presentationById } = useEnvironments();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  useNowMinute();
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
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
      if (presentationById.get(thread.environmentId)?.connection.phase !== "connected")
        return false;

      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now: preciseNow })) {
        return false;
      }

      return capabilities?.threadSettlement !== true || thread.settledOverride !== "settled";
    });
  }, [presentationById, serverConfigs, snoozeWakeTick, threads]);
  const nextWakeAtMs = useMemo(() => {
    let next = Number.POSITIVE_INFINITY;
    const now = Date.now();
    for (const thread of threads) {
      if (serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze !== true) {
        continue;
      }
      const wakeAt = Date.parse(thread.snoozedUntil ?? "");
      if (wakeAt > now && wakeAt < next) next = wakeAt;
    }
    return next;
  }, [serverConfigs, threads, snoozeWakeTick]);
  useEffect(() => {
    if (!Number.isFinite(nextWakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [nextWakeAtMs, snoozeWakeTick]);
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
      const threadKey = scopedThreadKey(scopeThreadRef(card.thread.environmentId, card.thread.id));
      const status = resolveBoardThreadStatus(card.thread, lastVisitedAtByThreadKey[threadKey]);
      if (attentionStatuses.has(status)) attention += 1;
      if (status === "working") working += 1;
      environmentIds.add(card.thread.environmentId);
    }
    return { attention, working, environments: environmentIds.size };
  }, [cards, lastVisitedAtByThreadKey]);

  const openThread = (thread: EnvironmentThreadShell) => {
    const selection = useThreadSelectionStore.getState();
    if (selection.selectedThreadKeys.size > 0) {
      selection.clearSelection();
    }
    selection.setAnchor(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <div
          aria-live="polite"
          className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
        >
          <h1 className="truncate text-sm font-semibold">Board view</h1>
          <span>
            {bootstrapped
              ? `${cards.length} active ${cards.length === 1 ? "session" : "sessions"}`
              : "Loading sessions…"}
          </span>
          {bootstrapped && summary.attention > 0 ? (
            <span className="text-amber-700 dark:text-amber-300">
              {summary.attention} need attention
            </span>
          ) : null}
          {bootstrapped && summary.working > 0 ? <span>{summary.working} working</span> : null}
          {bootstrapped && summary.environments > 1 ? (
            <span>{summary.environments} environments</span>
          ) : null}
        </div>
      </WorkspacePageHeader>
      {!bootstrapped ? null : sections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-lg">No active sessions</EmptyTitle>
            <EmptyDescription>
              Active sessions will appear here across your connected environments.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-auto px-4 pt-[var(--workspace-titlebar-scroll-fade-height)] pb-5 sm:px-6 sm:pb-7">
          <div className="mx-auto flex max-w-7xl flex-col gap-8">
            {sections.map((section) => (
              <section
                key={section.projectKey}
                aria-labelledby={`board-project-${encodeURIComponent(section.projectKey)}`}
              >
                <div className="mb-3 flex items-center gap-2">
                  <FolderIcon aria-hidden className="size-4 text-muted-foreground" />
                  <h2
                    id={`board-project-${encodeURIComponent(section.projectKey)}`}
                    className="text-sm font-semibold tracking-tight"
                  >
                    {section.projectTitle}
                  </h2>
                  <span className="text-xs text-muted-foreground">{section.cards.length}</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-3">
                  {section.cards.map((card) => (
                    <SessionBoardCard
                      key={JSON.stringify([card.thread.environmentId, card.thread.id])}
                      card={card}
                      lastVisitedAt={
                        lastVisitedAtByThreadKey[
                          scopedThreadKey(scopeThreadRef(card.thread.environmentId, card.thread.id))
                        ]
                      }
                      onOpen={openThread}
                      timestampFormat={timestampFormat}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </SidebarInset>
  );
}

function SessionBoardCard({
  card,
  lastVisitedAt,
  onOpen,
  timestampFormat,
}: {
  readonly card: BoardCard<EnvironmentThreadShell, EnvironmentProject>;
  readonly lastVisitedAt: string | undefined;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
  readonly timestampFormat: TimestampFormat;
}) {
  const { project, thread } = card;
  const status = resolveBoardThreadStatus(thread, lastVisitedAt);
  const runtime = thread.session?.providerName ?? String(thread.modelSelection.instanceId);
  const model = thread.modelSelection.model;
  const projectCwd = project?.workspaceRoot ?? thread.worktreePath ?? "";

  return (
    <button
      type="button"
      className="group flex min-h-36 min-w-0 cursor-pointer flex-col rounded-xl border border-border/80 bg-card p-4 text-left shadow-sm/5 outline-none transition-colors hover:border-foreground/20 hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
            <TooltipPopup>
              {formatChatTimestampTooltip(thread.updatedAt, timestampFormat)}
            </TooltipPopup>
          </Tooltip>
        </span>
      </div>
    </button>
  );
}
