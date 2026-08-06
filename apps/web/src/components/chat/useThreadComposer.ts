import {
  type ApprovalRequestId,
  type EnvironmentId,
  type OrchestrationThreadActivity,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useRef } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  type PendingApproval,
  type PendingUserInput,
} from "../../session-logic.ts";
import { useEnvironmentSettings } from "../../hooks/useSettings.ts";
import { newMessageId } from "../../lib/utils.ts";
import { primaryServerKeybindingsAtom } from "../../state/server.ts";
import { useProject, useServerConfigs } from "../../state/entities.ts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type SessionPhase,
  type SidebarThreadSummary,
  type Thread,
} from "../../types.ts";
import {
  deriveLockedProvider,
  buildThreadTurnInterruptInput,
  readFileAsDataUrl,
} from "../ChatView.logic.ts";
import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore.ts";
import type { TerminalContextDraft } from "../../lib/terminalContext.ts";
import type { ElementContextDraft } from "../../lib/elementContext.ts";
import type { ChatComposerProps } from "./ChatComposer.tsx";
import type { ExpandedImagePreview } from "./ExpandedImagePreview.tsx";

// Hoisted so `thread?.activities ?? []` doesn't allocate a fresh array (and
// bust the memos keyed on it) on every render when a thread has no activities.
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS = {} as const;

// Board composer never surfaces inline approvals/user-input prompts (that UI
// lives on the route only), so these are always-empty by construction. Hoisted
// so `ChatComposer`'s `memo` sees a stable reference for them across renders.
const EMPTY_PENDING_APPROVALS: PendingApproval[] = [];
const EMPTY_PENDING_USER_INPUTS: PendingUserInput[] = [];
const EMPTY_RESPONDING_REQUEST_IDS: ApprovalRequestId[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProvider[] = [];
// Shared no-op for the handful of board composer callbacks that are inert
// (plan sidebar, focus scheduling, etc. don't apply to embedded cards). A
// zero-arg function is structurally assignable to every callback prop type
// below regardless of its arity, so one constant covers all of them.
const NOOP = () => {};

export type ThreadComposerSurface = "route" | "board";

export function useThreadComposerRouteState(thread: Thread | null | undefined) {
  const threadActivities = thread?.activities ?? EMPTY_ACTIVITIES;
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const phase = derivePhase(thread?.session ?? null);
  return {
    pendingApprovals,
    pendingUserInputs,
    phase,
    activePendingApproval: pendingApprovals[0] ?? null,
    activePendingUserInput: pendingUserInputs[0] ?? null,
  };
}

export type UseBoardThreadComposerInput = {
  readonly threadRef: ScopedThreadRef;
  readonly thread: Thread | null | undefined;
  readonly summary: SidebarThreadSummary;
  readonly resolvedTheme: "light" | "dark";
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
};

export function useBoardThreadComposer(input: UseBoardThreadComposerInput) {
  const { threadRef, thread, summary, resolvedTheme, onExpandImage } = input;
  const environmentId = threadRef.environmentId;
  const settings = useEnvironmentSettings(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfigs = useServerConfigs();

  const composerRef = useRef<import("./ChatComposer.tsx").ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  // Board composer doesn't support inline terminal/element context chips, so
  // these start empty; typed explicitly rather than inferred as `never[]` to
  // match what ChatComposerProps expects. Each card gets its own array — a
  // ref is a mutable cell, so seeding several from one shared array would let
  // a future in-place write leak across every card on the board.
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);

  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });

  const providerStatuses = useMemo<ServerProvider[]>(
    () => [...(serverConfigs.get(environmentId)?.providers ?? EMPTY_PROVIDER_STATUSES)],
    [environmentId, serverConfigs],
  );

  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const gitCwd =
    thread && project
      ? projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: thread.worktreePath ?? null,
        })
      : null;

  const lockedProvider = deriveLockedProvider({
    thread,
    selectedProvider: null,
    threadProvider: summary.modelSelection.instanceId,
  });

  const phase: SessionPhase = derivePhase(thread?.session ?? null);
  const isConnecting = phase === "connecting";
  // Board composer has no local "sending" state of its own; always false.
  const isSendBusy: boolean = false;
  const isWorking = phase === "running" || isConnecting || thread?.session?.status === "starting";

  const runtimeMode = thread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = thread?.interactionMode ?? DEFAULT_INTERACTION_MODE;

  const onSend = useCallback(
    async (event?: { preventDefault: () => void }) => {
      event?.preventDefault();
      if (!thread || isWorking) {
        return;
      }
      const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
      if (!draft) {
        return;
      }
      const text = draft.prompt.trim();
      if (text.length === 0 && draft.images.length === 0) {
        return;
      }
      const attachments = await Promise.all(
        draft.images.map(async (image) => ({
          type: "image" as const,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: await readFileAsDataUrl(image.file),
        })),
      );
      const result = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments,
          },
          modelSelection: summary.modelSelection,
          titleSeed: summary.title,
          runtimeMode: summary.runtimeMode,
          interactionMode: summary.interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          console.error(squashAtomCommandFailure(result));
        }
        return;
      }
      useComposerDraftStore.getState().clearComposerContent(threadRef);
      composerRef.current?.resetCursorState();
    },
    [isWorking, startThreadTurn, summary, thread, threadRef],
  );

  const onInterrupt = useCallback(async () => {
    if (!thread) return;
    await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(thread),
    });
  }, [environmentId, interruptThreadTurn, thread]);

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      await respondToThreadApproval({
        environmentId,
        input: { threadId: threadRef.threadId, requestId, decision },
      });
    },
    [environmentId, respondToThreadApproval, threadRef],
  );

  const onProviderModelSelect = useCallback((_instanceId: ProviderInstanceId, _model: string) => {
    // Model changes on started sessions are blocked in the full route; board
    // cards keep the session model until opened in ChatView.
  }, []);

  const getModelDisabledReason = useCallback(
    (_instanceId: ProviderInstanceId, _model: string) => null,
    [],
  );

  const toggleInteractionMode = useCallback(() => {
    if (!thread) return;
    const next: ProviderInteractionMode =
      interactionMode === "plan" ? DEFAULT_INTERACTION_MODE : "plan";
    void setThreadInteractionMode({
      environmentId,
      input: { threadId: threadRef.threadId, interactionMode: next },
    });
  }, [environmentId, interactionMode, setThreadInteractionMode, thread, threadRef]);

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (!thread) return;
      void setThreadRuntimeMode({
        environmentId,
        input: { threadId: threadRef.threadId, runtimeMode: mode },
      });
    },
    [environmentId, setThreadRuntimeMode, thread, threadRef],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (!thread) return;
      void setThreadInteractionMode({
        environmentId,
        input: { threadId: threadRef.threadId, interactionMode: mode },
      });
    },
    [environmentId, setThreadInteractionMode, thread, threadRef],
  );

  // `ChatComposer` is wrapped in `React.memo`, and a board renders one live
  // instance of it per card, so this object must not be rebuilt on every
  // render — that would hand every field a fresh reference and defeat the
  // memo for every card on every board tick. Deps list only values that can
  // actually vary; the ~30 always-empty/no-op fields above are inlined here
  // straight from module-level constants so recomputation (when it does
  // happen) doesn't reallocate them either.
  const chatComposerProps = useMemo<ChatComposerProps>(
    () => ({
      composerRef,
      composerDraftTarget: threadRef,
      environmentId,
      routeKind: "server",
      routeThreadRef: threadRef,
      draftId: null,
      activeThreadId: thread?.id ?? null,
      activeThreadEnvironmentId: environmentId,
      activeThread: thread ?? undefined,
      isServerThread: true,
      isLocalDraftThread: false,
      forceExpandedOnMobile: false,
      projectSelectionRequired: false,
      phase,
      isConnecting,
      isSendBusy,
      // Board cards mount their own timeline rather than the route's thread
      // detail, so there is no loading gate to report here.
      sendDisabledReason: null,
      isPreparingWorktree: false,
      environmentUnavailable: null,
      activePendingApproval: null,
      pendingApprovals: EMPTY_PENDING_APPROVALS,
      pendingUserInputs: EMPTY_PENDING_USER_INPUTS,
      activePendingProgress: null,
      activePendingResolvedAnswers: null,
      activePendingIsResponding: false,
      activePendingDraftAnswers: EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS,
      activePendingQuestionIndex: 0,
      respondingRequestIds: EMPTY_RESPONDING_REQUEST_IDS,
      showPlanFollowUpPrompt: false,
      activeProposedPlan: null,
      activePlan: null,
      sidebarProposedPlan: null,
      planSidebarLabel: "",
      planSidebarOpen: false,
      runtimeMode,
      interactionMode,
      lockedProvider,
      providerStatuses,
      activeProjectDefaultModelSelection: project?.defaultModelSelection,
      activeThreadModelSelection: summary.modelSelection,
      activeThreadActivities: thread?.activities,
      resolvedTheme,
      settings,
      keybindings,
      terminalOpen: false,
      gitCwd,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      onSend,
      onInterrupt,
      onImplementPlanInNewThread: NOOP,
      onRespondToApproval,
      onSelectActivePendingUserInputOption: NOOP,
      onAdvanceActivePendingUserInput: NOOP,
      onPreviousActivePendingUserInputQuestion: NOOP,
      onChangeActivePendingUserInputCustomAnswer: NOOP,
      onProviderModelSelect,
      getModelDisabledReason,
      toggleInteractionMode,
      handleRuntimeModeChange,
      handleInteractionModeChange,
      togglePlanSidebar: NOOP,
      focusComposer: NOOP,
      scheduleComposerFocus: NOOP,
      setThreadError: NOOP,
      onExpandImage,
      density: "compact",
    }),
    [
      composerRef,
      threadRef,
      environmentId,
      thread,
      phase,
      isConnecting,
      isSendBusy,
      runtimeMode,
      interactionMode,
      lockedProvider,
      providerStatuses,
      project,
      summary,
      resolvedTheme,
      settings,
      keybindings,
      gitCwd,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      onSend,
      onInterrupt,
      onRespondToApproval,
      onProviderModelSelect,
      getModelDisabledReason,
      toggleInteractionMode,
      handleRuntimeModeChange,
      handleInteractionModeChange,
      onExpandImage,
    ],
  );

  return { chatComposerProps, composerRef };
}
