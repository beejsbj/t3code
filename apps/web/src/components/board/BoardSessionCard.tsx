import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useDraggable } from "@dnd-kit/core";
import type { LegendListRef } from "@legendapp/list/react";
import type {
  ApprovalRequestId,
  LaneDefinition,
  ProviderApprovalDecision,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
  TurnId,
  WorkflowLane,
} from "@t3tools/contracts";
import { ChevronsDownUpIcon, GripVerticalIcon, Maximize2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  cardSizeForHeight,
  clampCardHeight,
  selectCardHeight,
  useBoardCardStore,
} from "../../board/boardCardStore.ts";
import { useDiffPanelStore } from "../../diffPanelStore.ts";
import { useRightPanelStore } from "../../rightPanelStore.ts";
import { useTheme } from "../../hooks/useTheme.ts";
import { ensureLocalApi } from "../../localApi.ts";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "../../session-logic.ts";
import { readProject, useServerConfigs, useThread } from "../../state/entities.ts";
import { useUiStateStore } from "../../uiStateStore.ts";
import { useThreadContextMenu } from "../useThreadContextMenu.ts";
import {
  resolveThreadRuntimeState,
  threadRuntimeStateAppearance,
  type ThreadRuntimeState,
} from "../../state/threadRuntimeState.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { cn } from "~/lib/utils";
import { useThreadTimeline } from "../chat/useThreadTimeline.ts";
import { ChatComposer } from "../chat/ChatComposer.tsx";
import { useBoardThreadComposer } from "../chat/useThreadComposer.ts";
import { Button } from "../ui/button.tsx";
import { BoardCardExpandedSheet } from "./BoardCardExpandedSheet.tsx";
import { useInViewport } from "./useInViewport.ts";
import { MessagesTimeline } from "../chat/MessagesTimeline.tsx";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog.tsx";
import { type ExpandedImagePreview } from "../chat/ExpandedImagePreview.tsx";

const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

export interface BoardSessionCardProps {
  readonly cardKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly laneId: WorkflowLane | null;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly projectTitle: string;
  readonly isDragging: boolean;
}

export function BoardSessionCard(props: BoardSessionCardProps) {
  const { cardKey, threadRef, thread, laneId, lanes, projectTitle } = props;

  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const { openThreadContextMenu } = useThreadContextMenu({
    onMarkUnread: markThreadUnread,
  });

  const setHeight = useBoardCardStore((state) => state.setHeight);
  const setSize = useBoardCardStore((state) => state.setSize);
  const heightPx = useBoardCardStore((state) => selectCardHeight(state.byThreadKey, threadRef));
  const [expanded, setExpanded] = useState(false);

  const slotRef = useRef<HTMLDivElement | null>(null);
  const hasBeenVisible = useInViewport(slotRef, {
    once: true,
    rootMargin: "300px",
  });

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging: isDraggingSelf,
  } = useDraggable({
    id: cardKey,
  });

  const status = resolveThreadRuntimeState(thread);
  const appearance = threadRuntimeStateAppearance(status);

  const [draggingHeight, setDraggingHeight] = useState<number | null>(null);
  const teardownResizeRef = useRef<(() => void) | null>(null);

  useEffect(() => () => teardownResizeRef.current?.(), []);

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const startHeight = heightPx;
      let latest = startHeight;

      const onMove = (moveEvent: PointerEvent) => {
        latest = clampCardHeight(startHeight + (moveEvent.clientY - startY));
        setDraggingHeight(latest);
      };
      const finish = () => {
        teardownResizeRef.current?.();
        setDraggingHeight(null);
        setHeight(threadRef, latest);
      };
      const teardown = () => {
        teardownResizeRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };

      teardownResizeRef.current = teardown;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [heightPx, setHeight, threadRef],
  );

  const effectiveHeight = draggingHeight ?? heightPx;
  const size = cardSizeForHeight(effectiveHeight);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const threadProject = readProject(scopeProjectRef(thread.environmentId, thread.projectId));
      const workspacePath = thread.worktreePath ?? threadProject?.workspaceRoot ?? null;
      void openThreadContextMenu(
        {
          threadRef,
          thread,
          workspacePath,
          lanes,
        },
        { x: event.clientX, y: event.clientY },
      );
    },
    [lanes, openThreadContextMenu, thread, threadRef],
  );

  return (
    <div
      ref={slotRef}
      data-board-card={thread.id}
      data-lane={laneId ?? "unknown"}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
    >
      <div
        className={cn(
          "relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm",
          (isDraggingSelf || props.isDragging) && "opacity-60",
        )}
        style={{ height: `${effectiveHeight}px` }}
        onContextMenu={handleContextMenu}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-0 top-0 z-10 h-0.5",
            appearance.accentClass,
            appearance.pulse && "animate-status-pulse motion-reduce:animate-none",
          )}
        />
        <header className="flex shrink-0 items-start gap-1.5 border-b border-border/60 px-2 py-1.5">
          <button
            type="button"
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            aria-label={`Drag ${thread.title}`}
            className="mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-medium leading-4" title={thread.title}>
              {thread.title}
            </p>
            <p className="truncate text-[10px] text-muted-foreground/60">
              {projectTitle}
              {thread.branch ? ` · ${thread.branch}` : ""}
            </p>
          </div>
          <StatusDot status={status} />
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setSize(threadRef, size === "tall" ? "compact" : "tall")}
            aria-label={size === "tall" ? "Make card compact" : "Make card tall"}
            className="text-muted-foreground/60 hover:text-foreground"
          >
            <ChevronsDownUpIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setExpanded(true)}
            aria-label="Zoom into session"
            data-testid={`board-card-zoom-${thread.id}`}
            className="text-muted-foreground/60 hover:text-foreground"
          >
            <Maximize2Icon className="size-3.5" />
          </Button>
        </header>

        {hasBeenVisible ? (
          <BoardCardChatSurface threadRef={threadRef} thread={thread} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[10px] text-muted-foreground/50">
            Scroll into view to connect
          </div>
        )}

        <div
          onPointerDown={handleResizePointerDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${thread.title} card`}
          data-testid={`board-card-resize-${thread.id}`}
          className="h-2 shrink-0 cursor-ns-resize border-t border-border/40 bg-transparent hover:bg-accent"
        />
      </div>

      <BoardCardExpandedSheet
        threadRef={threadRef}
        title={thread.title}
        open={expanded}
        onOpenChange={setExpanded}
      />
    </div>
  );
}

function BoardCardChatSurface({
  threadRef,
  thread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
}) {
  const fullThread = useThread(threadRef);
  const serverConfigs = useServerConfigs();
  const { resolvedTheme } = useTheme();
  const legendListRef = useRef<LegendListRef | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });

  const providerStatuses = useMemo<ReadonlyArray<ServerProvider>>(
    () => serverConfigs.get(threadRef.environmentId)?.providers ?? [],
    [serverConfigs, threadRef.environmentId],
  );

  const activities = fullThread?.activities ?? [];
  const timelineMessages = fullThread?.messages ?? [];

  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(activities), [activities]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      if (!fullThread || isRevertingCheckpoint) {
        return;
      }
      const confirmed = await ensureLocalApi().dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      const result = await revertThreadCheckpoint({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          turnCount,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        console.error(error instanceof Error ? error.message : "Failed to revert thread state.");
      }
      setIsRevertingCheckpoint(false);
    },
    [fullThread, isRevertingCheckpoint, revertThreadCheckpoint, threadRef],
  );

  const {
    timelineEntries,
    latestTurn,
    runningTurnId,
    isWorking,
    activeTurnInProgress,
    activeTurnStartedAt,
    turnDiffSummaryByAssistantMessageId,
    revertTurnCountByUserMessageId,
    onRevertUserMessage,
    markdownCwd,
    workspaceRoot,
    resolvedTheme: timelineTheme,
    timestampFormat,
    skills,
    routeThreadKey,
    activeThreadEnvironmentId,
    isRevertingCheckpoint: timelineIsRevertingCheckpoint,
  } = useThreadTimeline({
    threadRef,
    thread: fullThread,
    timelineMessages,
    isRevertingCheckpoint,
    onRevertToTurnCount,
    resolvedTheme,
    skills: providerSkills(providerStatuses, thread) ?? EMPTY_SKILLS,
  });

  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      useDiffPanelStore.getState().selectTurn(threadRef, turnId, filePath);
      useRightPanelStore.getState().open(threadRef, "diff");
    },
    [threadRef],
  );

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);

  const { chatComposerProps } = useBoardThreadComposer({
    threadRef,
    thread: fullThread,
    summary: thread,
    resolvedTheme,
    onExpandImage: onExpandTimelineImage,
  });

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <MessagesTimeline
          density="compact"
          isWorking={isWorking}
          activeTurnInProgress={activeTurnInProgress}
          activeTurnStartedAt={activeTurnStartedAt}
          listRef={legendListRef}
          timelineEntries={timelineEntries}
          latestTurn={latestTurn}
          runningTurnId={runningTurnId}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          routeThreadKey={routeThreadKey}
          onOpenTurnDiff={onOpenTurnDiff}
          revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
          onRevertUserMessage={onRevertUserMessage}
          isRevertingCheckpoint={timelineIsRevertingCheckpoint}
          onImageExpand={onExpandTimelineImage}
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          markdownCwd={markdownCwd}
          resolvedTheme={timelineTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          skills={skills}
          anchorMessageId={null}
          onAnchorReady={() => {}}
          onAnchorSizeChanged={() => {}}
          contentInsetEndAdjustment={0}
          onIsAtEndChange={() => {}}
          onManualNavigation={() => {}}
          hideEmptyPlaceholder={false}
          topFadeEnabled={false}
        />
      </div>

      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}

      <AttentionStrip
        threadRef={threadRef}
        pendingApprovals={pendingApprovals}
        pendingUserInputs={pendingUserInputs}
      />

      <div className="shrink-0 border-t border-border/60 px-1.5 py-1">
        <ChatComposer {...chatComposerProps} />
      </div>
    </>
  );
}

function providerSkills(
  providerStatuses: ReadonlyArray<ServerProvider>,
  thread: SidebarThreadSummary,
): ReadonlyArray<ServerProviderSkill> | null {
  const instanceId = thread.modelSelection.instanceId;
  const match = providerStatuses.find((provider) => provider.instanceId === instanceId);
  return match?.skills ?? null;
}

function AttentionStrip({
  threadRef,
  pendingApprovals,
  pendingUserInputs,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
}) {
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [answersByRequest, setAnswersByRequest] = useState<Record<string, Record<string, unknown>>>(
    {},
  );

  const approval = pendingApprovals[0];
  const question = pendingUserInputs[0];
  const picked = (question && answersByRequest[question.requestId]) || {};
  const allAnswered =
    question !== undefined && question.questions.every((entry) => picked[entry.id] !== undefined);

  const setPicked = useCallback(
    (update: (current: Record<string, unknown>) => Record<string, unknown>) => {
      if (!question) return;
      setAnswersByRequest((current) => ({
        ...current,
        [question.requestId]: update(current[question.requestId] ?? {}),
      }));
    },
    [question],
  );

  const decide = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      setBusy(requestId);
      await respondToApproval({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId, decision },
      });
      setBusy(null);
    },
    [respondToApproval, threadRef],
  );

  const answer = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      setBusy(requestId);
      const result = await respondToUserInput({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId, answers },
      });
      if (result._tag === "Success") {
        // Free the draft once it has been sent; otherwise a later request that
        // reuses the same id (unlikely, but the map has no other eviction) would
        // resurrect stale picks.
        setAnswersByRequest((current) => {
          if (!(requestId in current)) return current;
          const next = { ...current };
          delete next[requestId];
          return next;
        });
      }
      setBusy(null);
    },
    [respondToUserInput, threadRef],
  );

  if (!approval && !question) return null;

  // Approval and input are different states in the app's color language
  // (amber vs indigo); when both are pending, approval outranks input the
  // same way resolveThreadRuntimeState does.
  const attentionTextClass = threadRuntimeStateAppearance(
    approval ? "approval" : "input",
  ).textClass;

  return (
    <div
      data-testid="board-card-attention"
      className="shrink-0 space-y-1.5 border-t border-border/60 bg-muted/40 px-2 py-1.5"
    >
      {approval ? (
        <div>
          <p className={cn("text-[10px] font-medium", attentionTextClass)}>
            Approval needed · {approval.requestKind}
          </p>
          {approval.detail ? (
            <p className="mt-0.5 line-clamp-2 font-mono text-[10px] text-muted-foreground">
              {approval.detail}
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-1">
            {(
              [
                ["accept", "Approve", "default"],
                ["acceptForSession", "Always", "outline"],
                ["decline", "Decline", "destructive-outline"],
              ] as const
            ).map(([decision, label, variant]) => (
              <Button
                key={decision}
                size="xs"
                variant={variant}
                disabled={busy === approval.requestId}
                onClick={() => void decide(approval.requestId, decision)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {question ? (
        <div>
          {question.questions.map((entry) => (
            <div key={entry.id} className="mb-1 last:mb-0">
              <p className={cn("text-[10px] font-medium", attentionTextClass)}>{entry.header}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{entry.question}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {entry.options.map((option) => {
                  const selected = picked[entry.id] === option.label;
                  return (
                    <Button
                      key={option.label}
                      size="xs"
                      variant={selected ? "default" : "outline"}
                      title={option.description}
                      disabled={busy === question.requestId}
                      onClick={() =>
                        setPicked((current) => ({
                          ...current,
                          [entry.id]: option.label,
                        }))
                      }
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
          {/*
            One response carries every answer. Submitting per-option would
            drop the remaining questions of a multi-question request, so the
            send button stays disabled until each one has a pick.
          */}
          <Button
            size="xs"
            disabled={busy === question.requestId || !allAnswered}
            onClick={() => void answer(question.requestId, picked)}
            data-testid="board-card-answer-submit"
            className="mt-1"
          >
            {allAnswered
              ? "Send answer"
              : `Pick ${question.questions.length - Object.keys(picked).length} more`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Matches resolveThreadStatusPill's colorClass for the same states (Sidebar.logic.ts)
// so the strip's headings read the same hue as the sidebar pill for approval/input.
function StatusDot({ status }: { readonly status: ThreadRuntimeState }) {
  const appearance = threadRuntimeStateAppearance(status);
  return (
    <span
      data-testid="board-card-status"
      data-status={status}
      title={appearance.label}
      className={cn(
        "mt-1 size-1.5 shrink-0 rounded-full",
        appearance.accentClass,
        appearance.pulse && "animate-status-pulse motion-reduce:animate-none",
      )}
    />
  );
}
