import { useDraggable } from "@dnd-kit/core";
import type {
  ApprovalRequestId,
  LaneDefinition,
  ProviderApprovalDecision,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  ChevronsDownUpIcon,
  EllipsisIcon,
  GripVerticalIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { placementReason, type BoardPlacement } from "../../board/boardLanes.ts";
import {
  CARD_MIN_HEIGHT,
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
import { useServerConfigs, useThread } from "../../state/entities.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown.tsx";
import { resolveSidebarV2Status } from "../Sidebar.logic.ts";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu.tsx";
import { BoardCardComposer } from "./BoardCardComposer.tsx";
import { useInViewport } from "./useInViewport.ts";

const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
/**
 * Compact cards show a tail, not the whole conversation. The full history is
 * one zoom away, and capping here is what keeps N mounted cards affordable.
 */
const COMPACT_MESSAGE_TAIL = 6;
const FOCUSED_MESSAGE_TAIL = 40;

export interface BoardSessionCardProps {
  readonly cardKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly placement: BoardPlacement;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly projectTitle: string;
  readonly isDragging: boolean;
}

export function BoardSessionCard(props: BoardSessionCardProps) {
  const { cardKey, threadRef, thread, placement, lanes, projectTitle } = props;

  const focusedThreadKey = useBoardCardStore((state) => state.focusedThreadKey);
  const toggleFocus = useBoardCardStore((state) => state.toggleFocus);
  const setHeight = useBoardCardStore((state) => state.setHeight);
  const setSize = useBoardCardStore((state) => state.setSize);
  const setWorkflowLane = useAtomCommand(threadEnvironment.setWorkflowLane, {
    reportFailure: false,
  });
  const heightPx = useBoardCardStore((state) => selectCardHeight(state.byThreadKey, threadRef));
  const isFocused = focusedThreadKey === cardKey;

  const slotRef = useRef<HTMLDivElement | null>(null);
  // Cards that have never been scrolled into view do not mount a chat surface
  // at all. `once` means a card that has been seen keeps its live subscription
  // for the rest of the session, so scrolling back and forth does not thrash
  // the per-thread websocket subscription.
  const hasBeenVisible = useInViewport(slotRef, { once: true, rootMargin: "300px" });
  const live = hasBeenVisible || isFocused;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: cardKey,
    disabled: isFocused,
  });

  const status = resolveSidebarV2Status(thread);
  const reason = placementReason(placement, lanes);

  // The drag is tracked locally and only committed to the store on release.
  // Writing on every pointermove would serialize the whole card map to
  // localStorage per frame, which is exactly the kind of jank a resize handle
  // must not have.
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

  const cardBody = (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card shadow-sm",
        isFocused
          ? "fixed inset-6 z-50 border-primary/50 shadow-2xl md:inset-x-[12vw] md:inset-y-[6vh]"
          : "relative border-border/70",
        (isDragging || props.isDragging) && "opacity-60",
        (placement.overridden || placement.heldInPlace) &&
          !isFocused &&
          "border-l-2 border-l-amber-500/70",
      )}
      style={isFocused ? undefined : { height: `${effectiveHeight}px` }}
    >
      <header className="flex shrink-0 items-start gap-1.5 border-b border-border/60 px-2 py-1.5">
        {!isFocused ? (
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
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-4" title={thread.title}>
            {thread.title}
          </p>
          <p className="truncate text-[10px] text-muted-foreground/60">
            {projectTitle}
            {thread.branch ? ` · ${thread.branch}` : ""}
          </p>
        </div>
        <StatusDot status={status} />
        <Menu>
          <MenuTrigger
            aria-label={`Board actions for ${thread.title}`}
            className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() =>
                void setWorkflowLane({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId, workflowLane: null },
                })
              }
            >
              Remove from board
            </MenuItem>
          </MenuPopup>
        </Menu>
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
          onClick={() => toggleFocus(threadRef)}
          aria-label={isFocused ? "Collapse session" : "Zoom into session"}
          data-testid={`board-card-zoom-${thread.id}`}
          className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
        >
          {isFocused ? (
            <Minimize2Icon className="size-3.5" />
          ) : (
            <Maximize2Icon className="size-3.5" />
          )}
        </button>
      </header>

      {reason !== null ? (
        <p className="shrink-0 border-b border-border/50 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
          {reason}
        </p>
      ) : null}

      {live ? (
        <BoardCardChatSurface
          threadRef={threadRef}
          thread={thread}
          isFocused={isFocused}
          messageTail={isFocused ? FOCUSED_MESSAGE_TAIL : COMPACT_MESSAGE_TAIL}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground/50">
          Scroll into view to connect
        </div>
      )}

      {!isFocused ? (
        <div
          onPointerDown={handleResizePointerDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${thread.title} card`}
          data-testid={`board-card-resize-${thread.id}`}
          className="h-2 shrink-0 cursor-ns-resize border-t border-border/40 bg-transparent hover:bg-accent"
        />
      ) : null}
    </div>
  );

  return (
    <div
      ref={slotRef}
      data-board-card={thread.id}
      data-lane={placement.lane ?? "inbox"}
      data-held-in-place={placement.heldInPlace || undefined}
      style={
        !isFocused && transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
    >
      {/*
        Zooming must not remount the chat surface, so the element structure
        here is fixed: the placeholder is always rendered (collapsed to zero
        height when not focused) and `cardBody` is always its next sibling in
        the same position. Swapping between `cardBody` and a fragment wrapping
        it would change the child sequence and let React unmount the Lexical
        editor and the live thread subscription underneath.
      */}
      <div
        aria-hidden
        className={cn(
          "rounded-lg border border-dashed border-border/60 bg-card/30",
          !isFocused && "hidden",
        )}
        style={isFocused ? { height: `${Math.max(CARD_MIN_HEIGHT, heightPx)}px` } : undefined}
      />
      {cardBody}
    </div>
  );
}

function BoardCardChatSurface({
  threadRef,
  thread,
  isFocused,
  messageTail,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly isFocused: boolean;
  readonly messageTail: number;
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

  const tail = useMemo(() => messages.slice(-messageTail), [messages, messageTail]);

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
          <p className="py-4 text-center text-[11px] text-muted-foreground/50">No messages yet</p>
        ) : (
          tail.map((message) => (
            <div
              key={message.id}
              data-message-role={message.role}
              className={cn(
                "rounded-md px-2 py-1.5 text-[11px] leading-snug",
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
        isFocused={isFocused}
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

function StatusDot({ status }: { readonly status: ReturnType<typeof resolveSidebarV2Status> }) {
  const className =
    status === "approval" || status === "input"
      ? "bg-amber-500"
      : status === "working"
        ? "bg-blue-500 animate-pulse"
        : status === "failed"
          ? "bg-red-500"
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
