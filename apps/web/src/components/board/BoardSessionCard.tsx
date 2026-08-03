import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useDraggable } from "@dnd-kit/core";
import type {
  ApprovalRequestId,
  LaneDefinition,
  ProviderApprovalDecision,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
  WorkflowLane,
} from "@t3tools/contracts";
import { ChevronsDownUpIcon, GripVerticalIcon, Maximize2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cardSizeForHeight,
  clampCardHeight,
  selectCardHeight,
  useBoardCardStore,
} from "../../board/boardCardStore.ts";
import { useTheme } from "../../hooks/useTheme.ts";
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
  type ThreadRuntimeState,
} from "../../state/threadRuntimeState.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown.tsx";
import { BoardCardComposer } from "./BoardCardComposer.tsx";
import { BoardCardExpandedSheet } from "./BoardCardExpandedSheet.tsx";
import { useInViewport } from "./useInViewport.ts";

const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
/**
 * Compact cards show a tail, not the whole conversation. The full history is
 * one zoom away, and capping here is what keeps N mounted cards affordable.
 */
const COMPACT_MESSAGE_TAIL = 6;

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
  const { openThreadContextMenu } = useThreadContextMenu({ onMarkUnread: markThreadUnread });

  const setHeight = useBoardCardStore((state) => state.setHeight);
  const setSize = useBoardCardStore((state) => state.setSize);
  const heightPx = useBoardCardStore((state) => selectCardHeight(state.byThreadKey, threadRef));
  const [expanded, setExpanded] = useState(false);

  const slotRef = useRef<HTMLDivElement | null>(null);
  const hasBeenVisible = useInViewport(slotRef, { once: true, rootMargin: "300px" });
  const live = hasBeenVisible;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: cardKey,
  });

  const status = resolveThreadRuntimeState(thread);

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
          "relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-0.5",
          (isDragging || props.isDragging) && "opacity-60",
          runtimeChromeClassName(status),
        )}
        style={{ height: `${effectiveHeight}px` }}
        onContextMenu={handleContextMenu}
      >
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
            <p className="truncate text-[9px] text-muted-foreground/60">
              {projectTitle}
              {thread.branch ? ` · ${thread.branch}` : ""}
            </p>
          </div>
          <StatusDot status={status} />
          <button
            type="button"
            onClick={() => setSize(threadRef, size === "tall" ? "compact" : "tall")}
            aria-label={size === "tall" ? "Make card compact" : "Make card tall"}
            className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          >
            <ChevronsDownUpIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="Zoom into session"
            data-testid={`board-card-zoom-${thread.id}`}
            className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          >
            <Maximize2Icon className="size-3.5" />
          </button>
        </header>

        {live ? (
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
  const detail = useThread(threadRef);
  const serverConfigs = useServerConfigs();
  const { resolvedTheme } = useTheme();

  const providerStatuses = useMemo<ReadonlyArray<ServerProvider>>(
    () => serverConfigs.get(threadRef.environmentId)?.providers ?? [],
    [serverConfigs, threadRef.environmentId],
  );

  const messages = detail?.messages ?? [];
  const activities = detail?.activities ?? [];

  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(activities), [activities]);

  const tail = useMemo(() => messages.slice(-COMPACT_MESSAGE_TAIL), [messages]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessage = tail.at(-1);
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lastMessage?.id, lastMessage?.text]);

  const isWorking = thread.session?.status === "running" || thread.session?.status === "starting";

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {tail.length === 0 ? (
          <p className="py-4 text-center text-[10px] text-muted-foreground/50">No messages yet</p>
        ) : (
          tail.map((message) => (
            <div
              key={message.id}
              data-message-role={message.role}
              className={cn(
                "rounded-md px-2 py-1.5 text-[10px] leading-snug",
                message.role === "user"
                  ? "bg-accent/60 text-foreground"
                  : "bg-muted/40 text-foreground/90",
              )}
            >
              <span className="mb-0.5 block text-[9px] uppercase tracking-wide text-muted-foreground/50">
                {message.role}
              </span>
              <ChatMarkdown
                text={message.text}
                cwd={thread.worktreePath ?? undefined}
                threadRef={threadRef}
                isStreaming={message.streaming}
                lineBreaks={message.role === "user"}
                className="prose-xs [&_pre]:text-[10px]"
              />
            </div>
          ))
        )}
        {isWorking ? (
          <p className="animate-pulse px-2 text-[10px] text-muted-foreground/60">Working…</p>
        ) : null}
      </div>

      <AttentionStrip
        threadRef={threadRef}
        pendingApprovals={pendingApprovals}
        pendingUserInputs={pendingUserInputs}
      />

      <BoardCardComposer
        threadRef={threadRef}
        thread={thread}
        providerStatuses={providerStatuses}
        skills={providerSkills(providerStatuses, thread) ?? EMPTY_SKILLS}
        resolvedTheme={resolvedTheme}
        isWorking={isWorking}
      />
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
      await respondToUserInput({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId, answers },
      });
      setBusy(null);
    },
    [respondToUserInput, threadRef],
  );

  if (!approval && !question) return null;

  return (
    <div
      data-testid="board-card-attention"
      className="shrink-0 space-y-1.5 border-t border-amber-500/40 bg-amber-500/10 px-2 py-1.5"
    >
      {approval ? (
        <div>
          <p className="text-[10px] font-medium text-amber-800 dark:text-amber-200">
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
                ["accept", "Approve"],
                ["acceptForSession", "Always"],
                ["decline", "Decline"],
              ] as const
            ).map(([decision, label]) => (
              <button
                key={decision}
                type="button"
                disabled={busy === approval.requestId}
                onClick={() => void decide(approval.requestId, decision)}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {question ? (
        <div>
          {question.questions.map((entry) => (
            <div key={entry.id} className="mb-1 last:mb-0">
              <p className="text-[10px] font-medium text-amber-800 dark:text-amber-200">
                {entry.header}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{entry.question}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {entry.options.map((option) => {
                  const selected = picked[entry.id] === option.label;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      title={option.description}
                      disabled={busy === question.requestId}
                      onClick={() =>
                        setPicked((current) => ({ ...current, [entry.id]: option.label }))
                      }
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50",
                        selected
                          ? "border-amber-600 bg-amber-500/25 font-medium"
                          : "border-border bg-background hover:bg-accent",
                      )}
                    >
                      {option.label}
                    </button>
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
          <button
            type="button"
            disabled={busy === question.requestId || !allAnswered}
            onClick={() => void answer(question.requestId, picked)}
            data-testid="board-card-answer-submit"
            className="mt-1 rounded bg-primary px-2 py-0.5 text-[10px] text-primary-foreground disabled:opacity-40"
          >
            {allAnswered
              ? "Send answer"
              : `Pick ${question.questions.length - Object.keys(picked).length} more`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function runtimeChromeClassName(status: ThreadRuntimeState): string {
  switch (status) {
    case "approval":
    case "input":
    case "plan-ready":
      return "before:bg-amber-500/80";
    case "working":
    case "connecting":
      return "before:animate-pulse before:bg-blue-500/80";
    case "failed":
      return "before:bg-red-500/80";
    case "idle":
      return "before:bg-muted-foreground/25";
  }
}

function StatusDot({ status }: { readonly status: ThreadRuntimeState }) {
  const className =
    status === "approval" || status === "input"
      ? "bg-amber-500"
      : status === "working" || status === "connecting"
        ? "bg-blue-500 animate-pulse"
        : status === "failed"
          ? "bg-red-500"
          : status === "plan-ready"
            ? "bg-amber-500"
            : "bg-muted-foreground/40";
  return (
    <span
      data-testid="board-card-status"
      data-status={status}
      title={status}
      className={cn("mt-1 size-1.5 shrink-0 rounded-full", className)}
    />
  );
}
