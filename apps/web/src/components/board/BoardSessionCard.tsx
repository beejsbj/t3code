import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import type { MessageId, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleDashedIcon, ExternalLinkIcon, GitBranchIcon, ServerIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import type { BoardCard } from "../../board/board.logic";
import { useTheme } from "../../hooks/useTheme";
import { useThread } from "../../state/entities";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { ChatComposer } from "../chat/ChatComposer";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { useBoardThreadComposer } from "../chat/useThreadComposer";
import { useThreadTimeline } from "../chat/useThreadTimeline";
import { useInViewport } from "./useInViewport";

const statusLabels = {
  approval: "Needs approval",
  input: "Awaiting input",
  working: "Working",
  monitoring: "Monitoring",
  failed: "Error",
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
  ready: "border-border bg-muted/45 text-muted-foreground dark:bg-muted/45",
} as const;

const EMPTY_REVERT_TURN_COUNTS = new Map<MessageId, number>();

export const BoardSessionCard = memo(function BoardSessionCard(props: {
  readonly card: BoardCard<EnvironmentThreadShell, EnvironmentProject>;
  readonly environmentConnection: EnvironmentConnectionPresentation;
}) {
  const { card, environmentConnection } = props;
  const { project, thread } = card;
  const slotRef = useRef<HTMLDivElement | null>(null);
  const isNearViewport = useInViewport(slotRef, { rootMargin: "300px" });
  const status = resolveSidebarThreadStatus(thread);
  const runtime = thread.session?.providerName ?? String(thread.modelSelection.instanceId);
  const projectCwd = project?.workspaceRoot ?? thread.worktreePath ?? "";
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);

  return (
    <article
      ref={slotRef}
      data-board-card={thread.id}
      className="flex h-[34rem] min-w-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm/5"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2">
        <ProjectFavicon
          environmentId={thread.environmentId}
          cwd={projectCwd}
          faviconPath={project?.faviconPath}
          className="mt-0.5 size-4"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-xs font-semibold" title={thread.title}>
              {thread.title}
            </h2>
            <Badge className={statusStyles[status]} size="sm" variant="outline">
              {statusLabels[status]}
            </Badge>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-[10px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <ServerIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{card.environmentLabel ?? thread.environmentId}</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <CircleDashedIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate" title={`${runtime} · ${thread.modelSelection.model}`}>
                {runtime} · {thread.modelSelection.model}
              </span>
            </span>
            {thread.branch ? (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{thread.branch}</span>
              </span>
            ) : null}
          </div>
        </div>
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: thread.environmentId, threadId: thread.id }}
          aria-label={`Open ${thread.title} in the full thread view`}
          className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLinkIcon className="size-3.5" />
        </Link>
      </header>
      {isNearViewport ? (
        <BoardCardChatSurface
          threadRef={threadRef}
          thread={thread}
          environmentLabel={card.environmentLabel ?? thread.environmentId}
          environmentConnection={environmentConnection}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/55">
          Scroll into view to load this conversation
        </div>
      )}
    </article>
  );
});

const BoardCardChatSurface = memo(function BoardCardChatSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string;
  readonly environmentConnection: EnvironmentConnectionPresentation;
}) {
  const { threadRef, thread, environmentLabel, environmentConnection } = props;
  const navigate = useNavigate();
  const fullThread = useThread(threadRef);
  const { resolvedTheme } = useTheme();
  const legendListRef = useRef<LegendListRef | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const anchorRef = useRef<MessageId | null>(null);

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const { chatComposerProps, timelineMessages, timelineAnchorMessageId, clearTimelineAnchor } =
    useBoardThreadComposer({
      threadRef,
      thread: fullThread,
      summary: thread,
      environmentLabel,
      environmentConnection,
      resolvedTheme,
      onExpandImage: onExpandTimelineImage,
    });
  const deferCheckpointRevertToFullThread = useCallback(() => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
    });
  }, [navigate, threadRef.environmentId, threadRef.threadId]);
  const {
    timelineEntries,
    latestTurn,
    runningTurnId,
    isWorking,
    activeTurnStartedAt,
    turnDiffSummaryByAssistantMessageId,
    onRevertUserMessage,
    markdownCwd,
    workspaceRoot,
    resolvedTheme: timelineTheme,
    timestampFormat,
    skills,
    routeThreadKey,
    activeThreadEnvironmentId,
    isRevertingCheckpoint,
  } = useThreadTimeline({
    threadRef,
    thread: fullThread,
    timelineMessages,
    isRevertingCheckpoint: false,
    onRevertToTurnCount: deferCheckpointRevertToFullThread,
    resolvedTheme,
  });

  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      useDiffPanelStore.getState().selectTurn(threadRef, turnId, filePath);
      useRightPanelStore.getState().open(threadRef, "diff");
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
      });
    },
    [navigate, threadRef],
  );
  const onAnchorReady = useCallback((messageId: MessageId, anchorIndex: number) => {
    if (anchorRef.current === messageId) return;
    anchorRef.current = messageId;
    void legendListRef.current?.scrollToIndex({
      index: anchorIndex,
      animated: true,
      viewPosition: 0,
      viewOffset: 8,
    });
  }, []);
  useEffect(() => {
    if (timelineAnchorMessageId === null) return;
    anchorRef.current = null;
    setLiveFollowEnabled(true);
  }, [timelineAnchorMessageId]);
  const onManualNavigation = useCallback(() => {
    setLiveFollowEnabled(false);
  }, []);
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (!isAtEnd) return;
      setLiveFollowEnabled(true);
      clearTimelineAnchor();
    },
    [clearTimelineAnchor],
  );

  return (
    <>
      <div className="min-h-0 flex-1">
        <MessagesTimeline
          density="compact"
          isWorking={isWorking}
          activeTurnStartedAt={activeTurnStartedAt}
          listRef={legendListRef}
          timelineEntries={timelineEntries}
          latestTurn={latestTurn}
          runningTurnId={runningTurnId}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          routeThreadKey={routeThreadKey}
          onOpenTurnDiff={onOpenTurnDiff}
          revertTurnCountByUserMessageId={EMPTY_REVERT_TURN_COUNTS}
          onRevertUserMessage={onRevertUserMessage}
          isRevertingCheckpoint={isRevertingCheckpoint}
          onImageExpand={onExpandTimelineImage}
          openingVideoAttachmentId={null}
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          markdownCwd={markdownCwd}
          resolvedTheme={timelineTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          skills={skills}
          anchorMessageId={timelineAnchorMessageId}
          onAnchorReady={onAnchorReady}
          contentInsetEndAdjustment={0}
          liveFollowEnabled={liveFollowEnabled}
          onIsAtEndChange={onIsAtEndChange}
          onManualNavigation={onManualNavigation}
          topFadeEnabled={false}
        />
      </div>
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
      <div className="shrink-0 border-t border-border/60 px-1.5 py-1">
        <ChatComposer {...chatComposerProps} embedded />
      </div>
    </>
  );
});
