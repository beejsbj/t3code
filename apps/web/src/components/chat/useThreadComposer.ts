import {
  AuthOrchestrationOperateScope,
  type MessageId,
  type ModelSelection,
  type OrchestrationMessageContext,
  type OrchestrationV2ProjectedTurnItem,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type PreviewAnnotationPayload,
  type RuntimeMode,
  type RuntimeRequestId,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { deriveCanInterruptRunningThread, derivePhase } from "../../session-logic.ts";
import { useEnvironmentSettings } from "../../hooks/useSettings.ts";
import { newMessageId } from "../../lib/utils.ts";
import { primaryServerKeybindingsAtom } from "../../state/server.ts";
import { useProject, useServerConfigs } from "../../state/entities.ts";
import { useEnvironmentScope } from "../../state/session.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type SidebarThreadSummary,
} from "../../types.ts";
import {
  deriveLockedProvider,
  cloneComposerImageForRetry,
  getStartedThreadModelChangeBlockReason,
  readFileAsDataUrl,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  resolveThreadMetadataUpdateForNextTurn,
  deriveComposerSendState,
} from "../ChatView.logic.ts";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
} from "../../composerDraftStore.ts";
import { resolveAppModelSelectionForInstance } from "../../modelSelection.ts";
import { type TerminalContextDraft } from "../../lib/terminalContext.ts";
import { type ReviewCommentContext } from "../../reviewCommentContext.ts";
import { buildMessageContext, terminalContextReference } from "../../lib/composerContextRecords.ts";
import { removeInlineContextReference } from "../../lib/composerContextReferences.ts";
import type { ChatComposerHandle, ChatComposerProps } from "./ChatComposer.tsx";
import type { ExpandedImagePreview } from "./ExpandedImagePreview.tsx";
import { deriveServerAcknowledgedUserMessageIds } from "./useThreadTimeline.ts";
import { toastManager } from "../ui/toast.tsx";

// The board composer never surfaces inline approvals or user-input prompts
// (the card shows an attention strip that opens the full session instead), so
// these are always empty. Hoisted so ChatComposer's memo sees stable values.
const EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS = {} as const;
const EMPTY_PENDING_APPROVALS: ChatComposerProps["pendingApprovals"] = [];
const EMPTY_PENDING_USER_INPUTS: ChatComposerProps["pendingUserInputs"] = [];
const EMPTY_RESPONDING_REQUEST_IDS: RuntimeRequestId[] = [];
const EMPTY_COMPOSER_BANNER_ITEMS = [] as const;
const EMPTY_PROMPT_HISTORY: ReadonlyArray<ChatMessage> = [];
// Inert callbacks for composer features that only the full session view owns.
const NOOP = () => {};
const NO_TIMELINE_SCROLLABLE_NODE = () => null;
const TIMELINE_IS_AT_LOGICAL_END = () => true;

export function resolveBoardComposerSubmission(input: {
  readonly prompt: string;
  readonly imageCount: number;
}): { readonly text: string } | null {
  const text = input.prompt.trim();
  if (text.length === 0 && input.imageCount === 0) return null;
  return { text };
}

export function buildBoardComposerMessageFields(input: {
  readonly text: string;
  readonly context: OrchestrationMessageContext | undefined;
  readonly supportsInlineMessageContext: boolean;
}): { readonly text: string; readonly context?: OrchestrationMessageContext } {
  if (input.context === undefined) return { text: input.text };
  return input.supportsInlineMessageContext
    ? { text: input.text, context: input.context }
    : {
        text: serializeLegacyContextMessage({
          text: input.text,
          records: input.context.records,
        }),
      };
}

export function boardComposerDraftCanBeRestored(
  draft:
    | (Pick<ComposerThreadDraftState, "prompt" | "images"> &
        Partial<
          Pick<
            ComposerThreadDraftState,
            "files" | "terminalContexts" | "previewAnnotations" | "reviewComments"
          >
        >)
    | null,
): boolean {
  return (
    draft === null ||
    (draft.prompt.length === 0 &&
      draft.images.length === 0 &&
      (draft.files?.length ?? 0) === 0 &&
      (draft.terminalContexts?.length ?? 0) === 0 &&
      (draft.previewAnnotations?.length ?? 0) === 0 &&
      (draft.reviewComments?.length ?? 0) === 0)
  );
}

/**
 * Optimistic sends the server has not acknowledged. Returns `messages` itself
 * when none were acknowledged: the timeline rederives whenever this array's
 * identity changes, and a fresh empty array on every render loops forever.
 */
export function retainUnacknowledgedMessages<M extends { readonly id: MessageId }>(
  messages: ReadonlyArray<M>,
  acknowledged: ReadonlySet<MessageId>,
): ReadonlyArray<M> {
  return messages.some((message) => acknowledged.has(message.id))
    ? messages.filter((message) => !acknowledged.has(message.id))
    : messages;
}

export function canBeginBoardComposerSend(
  connection: EnvironmentConnectionPresentation,
  sendInFlight: boolean,
): boolean {
  return connection.phase === "connected" && !sendInFlight;
}

export function resolveBoardComposerModelSelection(
  draft: {
    readonly activeProvider: ProviderInstanceId | null;
    readonly modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  },
  fallback: ModelSelection,
): ModelSelection {
  return (draft.activeProvider && draft.modelSelectionByProvider[draft.activeProvider]) || fallback;
}

export type UseBoardThreadComposerInput = {
  readonly threadRef: ScopedThreadRef;
  readonly summary: SidebarThreadSummary;
  readonly environmentLabel: string;
  readonly environmentConnection: EnvironmentConnectionPresentation;
  readonly resolvedTheme: "light" | "dark";
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  /** The thread's server state; optimistic rows retire once it has their message. */
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly detail: EnvironmentThread | null;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
};

/**
 * The compact composer behind each live board card: a plain follow-up sender
 * for an existing thread. Approvals, questions, plans, and the other
 * session-level controls stay in the full session view.
 */
export function useBoardThreadComposer(input: UseBoardThreadComposerInput) {
  const {
    threadRef,
    summary,
    environmentLabel,
    environmentConnection,
    resolvedTheme,
    onExpandImage,
  } = input;
  // Derived here rather than by the caller: the React Compiler memoizes this
  // hook, so the set keeps its identity until the thread's server state changes.
  const serverAcknowledgedUserMessageIds = deriveServerAcknowledgedUserMessageIds(
    input.visibleTurnItems,
    input.detail,
  );
  const providerStatuses = input.providerStatuses as ServerProvider[];
  const navigate = useNavigate();
  const environmentId = threadRef.environmentId;
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const settings = useEnvironmentSettings(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const environmentConfig = useServerConfigs().get(environmentId);

  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  // Each card gets its own array: a ref is a mutable cell, so seeding several
  // from one shared array would let an in-place write leak across cards.
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const focusComposer = () => {
    composerRef.current?.focusAtEnd();
  };

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
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });

  const project = useProject(scopeProjectRef(summary.environmentId, summary.projectId));
  const gitCwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: summary.worktreePath ?? null,
      })
    : null;

  const lockedProvider = deriveLockedProvider({
    thread: summary,
    selectedProvider: null,
    threadProvider: summary.modelSelection.instanceId,
    providers: providerStatuses,
  });

  const phase = derivePhase(summary.runtime);
  const isConnecting = phase === "connecting";
  const canInterrupt = canOperateThread && deriveCanInterruptRunningThread(true, summary.runtime);
  const sendInFlightRef = useRef(false);
  const [isSendBusy, setIsSendBusy] = useState(false);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ReadonlyArray<ChatMessage>>(
    [],
  );
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  useEffect(() => {
    // Rows that left state (acknowledged, failed, or replaced) release their previews.
    for (const message of optimisticUserMessagesRef.current) {
      if (!optimisticUserMessages.includes(message)) revokeUserMessagePreviewUrls(message);
    }
    optimisticUserMessagesRef.current = optimisticUserMessages;
  }, [optimisticUserMessages]);
  // Rows the server already has leave state as soon as it acknowledges them, so
  // the pending array keeps one identity between sends. The timeline rederives
  // on every new identity; filtering on each render loops.
  const pendingOptimisticUserMessages = retainUnacknowledgedMessages(
    optimisticUserMessages,
    serverAcknowledgedUserMessageIds,
  );
  if (pendingOptimisticUserMessages !== optimisticUserMessages) {
    setOptimisticUserMessages(pendingOptimisticUserMessages);
  }
  const [timelineAnchorMessageId, setTimelineAnchorMessageId] = useState<MessageId | null>(null);
  const clearTimelineAnchor = () => setTimelineAnchorMessageId(null);

  useEffect(
    () => () => {
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    },
    [],
  );

  const runtimeMode = summary.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = summary.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const hasStartedSession = summary.runtime !== null;
  const currentProviderInstanceId = summary.runtime?.providerInstanceId ?? null;

  const onSend = async (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    if (!canBeginBoardComposerSend(environmentConnection, sendInFlightRef.current)) return;

    sendInFlightRef.current = true;
    setIsSendBusy(true);
    let optimisticMessageId: MessageId | null = null;
    let sentDraft: {
      readonly prompt: string;
      readonly images: ComposerImageAttachment[];
      readonly terminalContexts: TerminalContextDraft[];
      readonly previewAnnotations: PreviewAnnotationPayload[];
      readonly reviewComments: ReviewCommentContext[];
    } | null = null;
    let sendSucceeded = false;
    let sendError: unknown = null;
    try {
      const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
      if (!draft) return;
      const sendState = deriveComposerSendState({
        prompt: draft.prompt,
        imageCount: draft.images.length,
        terminalContexts: draft.terminalContexts,
        elementContextCount: draft.previewAnnotations.length + draft.reviewComments.length,
      });
      if (!sendState.hasSendableContent) return;
      const messageText = draft.terminalContexts
        .filter((context) => !sendState.sendableTerminalContexts.includes(context))
        .reduce(
          (text, context) =>
            removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
          draft.prompt,
        )
        .trim();
      const messageContext = buildMessageContext({
        terminalContexts: sendState.sendableTerminalContexts,
        previewAnnotations: draft.previewAnnotations,
        reviewComments: draft.reviewComments,
        attachments: draft.images.map((attachment) => ({
          attachment,
          attachmentId: attachment.id,
        })),
      });
      const outgoingMessage = buildBoardComposerMessageFields({
        text: messageText,
        context: messageContext,
        supportsInlineMessageContext:
          environmentConfig?.environment.capabilities.inlineMessageContext === true,
      });
      const requestedModelSelection = resolveBoardComposerModelSelection(
        draft,
        summary.modelSelection,
      );
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession,
        currentModelSelection: summary.modelSelection,
        currentProviderInstanceId,
        nextModelSelection: requestedModelSelection,
      });
      const modelSelection = modelChangeBlockReason
        ? summary.modelSelection
        : requestedModelSelection;
      const messageId = newMessageId();
      const createdAt = new Date().toISOString();
      const optimisticAttachments = draft.images.map((image) => ({
        type: "image" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        previewUrl: image.previewUrl,
      }));
      optimisticMessageId = messageId;
      sentDraft = {
        prompt: draft.prompt,
        images: [...draft.images],
        terminalContexts: [...draft.terminalContexts],
        previewAnnotations: [...draft.previewAnnotations],
        reviewComments: [...draft.reviewComments],
      };
      setTimelineAnchorMessageId(messageId);
      for (const message of optimisticUserMessagesRef.current) {
        if (serverAcknowledgedUserMessageIds.has(message.id)) revokeUserMessagePreviewUrls(message);
      }
      setOptimisticUserMessages((existing) => [
        ...existing.filter((message) => !serverAcknowledgedUserMessageIds.has(message.id)),
        {
          id: messageId,
          role: "user",
          ...outgoingMessage,
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
          runId: null,
          createdAt,
          updatedAt: createdAt,
          streaming: false,
        },
      ]);
      promptRef.current = "";
      composerImagesRef.current = [];
      useComposerDraftStore.getState().clearComposerContent(threadRef);
      composerRef.current?.resetCursorState();

      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: summary.modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: summary.branch,
      });
      if (metadataUpdate !== null) {
        const metadataResult = await updateThreadMetadata({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            ...metadataUpdate,
          },
        });
        if (metadataResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(metadataResult)) {
            sendError = squashAtomCommandFailure(metadataResult);
          }
          return;
        }
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
            messageId,
            role: "user",
            ...outgoingMessage,
            attachments,
          },
          modelSelection,
          titleSeed: summary.title,
          runtimeMode: summary.runtimeMode,
          interactionMode: summary.interactionMode,
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          sendError = squashAtomCommandFailure(result);
        }
        return;
      }
      sendSucceeded = true;
    } catch (error) {
      sendError = error;
    } finally {
      if (!sendSucceeded && optimisticMessageId !== null && sentDraft !== null) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== optimisticMessageId),
        );
        setTimelineAnchorMessageId((current) => (current === optimisticMessageId ? null : current));

        const currentDraft = useComposerDraftStore.getState().getComposerDraft(threadRef);
        if (boardComposerDraftCanBeRestored(currentDraft)) {
          const retryImages = sentDraft.images.map(cloneComposerImageForRetry);
          for (const image of sentDraft.images) revokeBlobPreviewUrl(image.previewUrl);
          promptRef.current = sentDraft.prompt;
          composerImagesRef.current = retryImages;
          composerTerminalContextsRef.current = sentDraft.terminalContexts;
          const draftStore = useComposerDraftStore.getState();
          draftStore.setPrompt(threadRef, sentDraft.prompt);
          draftStore.addImages(threadRef, retryImages);
          draftStore.setTerminalContexts(threadRef, sentDraft.terminalContexts);
          draftStore.setPreviewAnnotations(threadRef, sentDraft.previewAnnotations);
          draftStore.setReviewComments(threadRef, sentDraft.reviewComments);
          composerRef.current?.resetCursorState({
            prompt: sentDraft.prompt,
            cursor: sentDraft.prompt.length,
            detectTrigger: true,
          });
        } else {
          for (const image of sentDraft.images) revokeBlobPreviewUrl(image.previewUrl);
        }
        if (sendError !== null) {
          toastManager.add({
            type: "error",
            title: "Failed to send message",
            description:
              sendError instanceof Error ? sendError.message : "The message was restored.",
          });
        }
      }
      sendInFlightRef.current = false;
      setIsSendBusy(false);
    }
  };

  const onInterrupt = async () => {
    await interruptThreadTurn({
      environmentId,
      input: { threadId: threadRef.threadId },
    });
  };

  const onRespondToApproval = (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) =>
    respondToThreadApproval({
      environmentId,
      input: { threadId: threadRef.threadId, requestId, decision },
    });

  const setComposerDraftModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const onProviderModelSelect = (instanceId: ProviderInstanceId, model: string) => {
    const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
    const resolvedDriverKind = entry?.driver ?? null;
    if (
      lockedProvider !== null &&
      resolvedDriverKind !== null &&
      resolvedDriverKind !== lockedProvider
    ) {
      focusComposer();
      return;
    }
    if (lockedProvider !== null && currentProviderInstanceId) {
      const currentEntry = providerStatuses.find(
        (snapshot) => snapshot.instanceId === currentProviderInstanceId,
      );
      if (
        currentEntry?.continuation?.groupKey &&
        entry?.continuation?.groupKey &&
        currentEntry.continuation.groupKey !== entry.continuation.groupKey
      ) {
        focusComposer();
        return;
      }
    }
    const resolvedModel = resolveAppModelSelectionForInstance(
      instanceId,
      settings,
      providerStatuses,
      model,
    );
    if (!resolvedModel) {
      focusComposer();
      return;
    }
    const nextModelSelection: ModelSelection = { instanceId, model: resolvedModel };
    const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
      providers: providerStatuses,
      hasStartedSession,
      currentModelSelection: summary.modelSelection,
      currentProviderInstanceId,
      nextModelSelection,
    });
    if (modelChangeBlockReason) {
      toastManager.add({
        type: "warning",
        title: modelChangeBlockReason.title,
        description: modelChangeBlockReason.description,
      });
      focusComposer();
      return;
    }
    setComposerDraftModelSelection(threadRef, nextModelSelection);
    focusComposer();
  };

  const onOpenProviderSetup = (instanceId: ProviderInstanceId) => {
    void navigate({
      to: "/settings/providers",
      search: { environmentId, instanceId },
    });
  };

  const getModelDisabledReason = (instanceId: ProviderInstanceId, model: string) => {
    const reason = getStartedThreadModelChangeBlockReason({
      providers: providerStatuses,
      hasStartedSession,
      currentModelSelection: summary.modelSelection,
      currentProviderInstanceId,
      nextModelSelection: { instanceId, model },
    });
    return reason ? `${reason.description} Start a new thread to use this model.` : null;
  };

  const handleInteractionModeChange = (mode: ProviderInteractionMode) => {
    void setThreadInteractionMode({
      environmentId,
      input: { threadId: threadRef.threadId, interactionMode: mode },
    });
  };
  const toggleInteractionMode = () =>
    handleInteractionModeChange(interactionMode === "plan" ? DEFAULT_INTERACTION_MODE : "plan");

  const handleRuntimeModeChange = (mode: RuntimeMode) => {
    void setThreadRuntimeMode({
      environmentId,
      input: { threadId: threadRef.threadId, runtimeMode: mode },
    });
  };

  const chatComposerProps: ChatComposerProps = {
    composerRef,
    composerDraftTarget: threadRef,
    environmentId,
    canOperateThread,
    attachmentUploadsCapabilityKnown: environmentConfig !== undefined,
    supportsAttachmentUploads:
      environmentConfig?.environment.capabilities.attachmentUploads === true,
    supportsQuestionAttachments: false,
    // The embedded board sender serializes images directly. Generic files stay
    // visible in retained drafts, but the full session view sends them.
    maxFileAttachmentBytes: null,
    routeKind: "server",
    routeThreadRef: threadRef,
    draftId: null,
    multipleModelSelections: null,
    supportsMultipleModels: false,
    onMultipleModelSelectionsChange: NOOP,
    activeThreadId: summary.id,
    activeThreadEnvironmentId: environmentId,
    activeThread: summary,
    activeThreadShell: null,
    // The card supplies its timeline's messages when it renders the composer.
    promptHistoryMessages: EMPTY_PROMPT_HISTORY,
    isServerThread: true,
    isLocalDraftThread: false,
    forceExpandedOnMobile: false,
    projectSelectionRequired: false,
    phase,
    canInterrupt,
    isConnecting,
    isSendBusy,
    canResume: false,
    sendDisabledReason: null,
    isPreparingWorktree: false,
    isCompacting: false,
    bannerItems: EMPTY_COMPOSER_BANNER_ITEMS,
    resumeCompactionTokens: null,
    keepFullHistory: false,
    onToggleKeepFullHistory: NOOP,
    environmentUnavailable:
      environmentConnection.phase === "connected"
        ? null
        : { label: environmentLabel, connection: environmentConnection },
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
    activeTasksProgress: null,
    activeTaskSteps: null,
    threadSyncPhase: null,
    runtimeMode,
    interactionMode,
    lockedProvider,
    providerStatuses,
    providerCatalogKnown: environmentConfig !== undefined,
    activeProjectDefaultModelSelection: project?.defaultModelSelection,
    activeThreadModelSelection: summary.modelSelection,
    activeProjectId: summary.projectId,
    activeContextWindow: null,
    compactThreadUnavailable: false,
    compactDisabled: false,
    compactDisabledReason: null,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen: false,
    gitCwd,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    restingControlsHost: null,
    restingControlsHaveLeadingContext: false,
    onRestingControlsVisibilityChange: NOOP,
    getTimelineScrollableNode: NO_TIMELINE_SCROLLABLE_NODE,
    isTimelineAtLogicalEnd: TIMELINE_IS_AT_LOGICAL_END,
    timelineOverflows: false,
    onComposerOverlayHeightChange: NOOP,
    onRestingChange: NOOP,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    onPageScrollKeyDown: NOOP,
    onPageScrollKeyUp: NOOP,
    onPageScrollRelease: NOOP,
    editingQueuedAttachments: null,
    onRemoveEditingQueuedAttachment: NOOP,
    onCompactContext: NOOP,
    onSend: (event) => void onSend(event),
    onResume: NOOP,
    onInterrupt: () => void onInterrupt(),
    onImplementPlanInNewThread: NOOP,
    onRespondToApproval,
    onSelectActivePendingUserInputOption: NOOP,
    onAdvanceActivePendingUserInput: NOOP,
    onDismissActivePendingUserInput: NOOP,
    onPreviousActivePendingUserInputQuestion: NOOP,
    onChangeActivePendingUserInputCustomAnswer: NOOP,
    onProviderModelSelect,
    onOpenProviderSetup,
    getModelDisabledReason,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    focusComposer,
    scheduleComposerFocus: focusComposer,
    setThreadError: NOOP,
    onExpandImage,
    onFileOpen: NOOP,
    density: "compact",
  };

  return {
    chatComposerProps,
    composerRef,
    isSendBusy,
    optimisticUserMessages: pendingOptimisticUserMessages,
    timelineAnchorMessageId,
    clearTimelineAnchor,
  };
}
