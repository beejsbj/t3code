import {
  type ApprovalRequestId,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type ChatMessage,
  type Thread,
} from "../../types.ts";
import {
  deriveLockedProvider,
  buildThreadTurnInterruptInput,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  getStartedThreadModelChangeBlockReason,
  readFileAsDataUrl,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  resolveThreadMetadataUpdateForNextTurn,
} from "../ChatView.logic.ts";
import {
  useComposerDraftStore,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
} from "../../composerDraftStore.ts";
import { useAssetUrls } from "../../assets/assetUrls.ts";
import { resolveAppModelSelectionForInstance } from "../../modelSelection.ts";
import type { TerminalContextDraft } from "../../lib/terminalContext.ts";
import type { ElementContextDraft } from "../../lib/elementContext.ts";
import type { ChatComposerProps } from "./ChatComposer.tsx";
import type { ExpandedImagePreview } from "./ExpandedImagePreview.tsx";
import { toastManager } from "../ui/toast.tsx";

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
const EMPTY_CHAT_MESSAGES: ReadonlyArray<ChatMessage> = [];
// Shared no-op for the handful of board composer callbacks that are inert
// (plan sidebar, focus scheduling, etc. don't apply to embedded cards). A
// zero-arg function is structurally assignable to every callback prop type
// below regardless of its arity, so one constant covers all of them.
const NOOP = () => {};

export type ThreadComposerSurface = "route" | "board";

export function resolveBoardComposerSubmission(input: {
  readonly prompt: string;
  readonly imageCount: number;
}): { readonly text: string } | null {
  const text = input.prompt.trim();
  if (text.length === 0 && input.imageCount === 0) return null;
  return { text };
}

export function boardComposerDraftCanBeRestored(
  draft: Pick<ComposerThreadDraftState, "prompt" | "images"> | null,
): boolean {
  return draft === null || (draft.prompt.length === 0 && draft.images.length === 0);
}

export function mergeBoardTimelineMessages(
  serverMessages: ReadonlyArray<ChatMessage>,
  optimisticUserMessages: ReadonlyArray<ChatMessage>,
  attachmentPreviewHandoffByMessageId: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<ChatMessage> {
  const serverMessagesWithPreviewHandoff = serverMessages.map((message) => {
    const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
    if (
      message.role !== "user" ||
      !handoffPreviewUrls ||
      !message.attachments ||
      message.attachments.length === 0
    ) {
      return message;
    }
    let imageIndex = 0;
    let changed = false;
    const attachments = message.attachments.map((attachment) => {
      if (attachment.type !== "image") return attachment;
      const previewUrl = handoffPreviewUrls[imageIndex];
      imageIndex += 1;
      if (!previewUrl || attachment.previewUrl === previewUrl) return attachment;
      changed = true;
      return { ...attachment, previewUrl };
    });
    return changed ? { ...message, attachments } : message;
  });
  if (optimisticUserMessages.length === 0) return serverMessagesWithPreviewHandoff;
  const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
  const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
  return pendingMessages.length === 0
    ? serverMessagesWithPreviewHandoff
    : [...serverMessagesWithPreviewHandoff, ...pendingMessages];
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
  readonly environmentLabel: string;
  readonly environmentConnection: EnvironmentConnectionPresentation;
  readonly resolvedTheme: "light" | "dark";
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
};

export function useBoardThreadComposer(input: UseBoardThreadComposerInput) {
  const {
    threadRef,
    thread,
    summary,
    environmentLabel,
    environmentConnection,
    resolvedTheme,
    onExpandImage,
  } = input;
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
  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, []);

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

  const providerStatuses = useMemo<ServerProvider[]>(
    () => [...(serverConfigs.get(environmentId)?.providers ?? EMPTY_PROVIDER_STATUSES)],
    [environmentId, serverConfigs],
  );

  const project = useProject(scopeProjectRef(summary.environmentId, summary.projectId));
  const gitCwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: summary.worktreePath ?? null,
      })
    : null;

  const lockedProvider = deriveLockedProvider({
    thread,
    selectedProvider: null,
    threadProvider: summary.modelSelection.instanceId,
  });

  const phase: SessionPhase = derivePhase(summary.session ?? null);
  const isConnecting = phase === "connecting";
  const sendInFlightRef = useRef(false);
  const [isSendBusy, setIsSendBusy] = useState(false);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  const attachmentPreviewHandoffByMessageIdRef = useRef(attachmentPreviewHandoffByMessageId);
  attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  const [timelineAnchorMessageId, setTimelineAnchorMessageId] = useState<MessageId | null>(null);
  const clearTimelineAnchor = useCallback(() => setTimelineAnchorMessageId(null), []);

  const serverMessages = thread?.messages ?? EMPTY_CHAT_MESSAGES;
  const serverAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const message of serverMessages) {
      for (const attachment of message.attachments ?? []) {
        attachmentIds.add(attachment.id);
      }
    }
    return [...attachmentIds];
  }, [serverMessages]);
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(
    () =>
      serverMessages.map((message) => {
        if (!message.attachments || message.attachments.length === 0) return message;
        return {
          ...message,
          attachments: message.attachments.map((attachment) => {
            const previewUrl = serverAttachmentUrlById.get(attachment.id);
            return previewUrl ? { ...attachment, previewUrl } : attachment;
          }),
        };
      }),
    [serverAttachmentUrlById, serverMessages],
  );

  const timelineMessages = useMemo(
    () =>
      mergeBoardTimelineMessages(
        displayServerMessages,
        optimisticUserMessages,
        attachmentPreviewHandoffByMessageId,
      ),
    [attachmentPreviewHandoffByMessageId, displayServerMessages, optimisticUserMessages],
  );

  useEffect(() => {
    const serverIds = new Set(serverMessages.map((message) => message.id));
    if (serverIds.size === 0) return;
    const projectedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (projectedMessages.length === 0) return;
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const additions: Record<string, ReadonlyArray<string>> = {};
      for (const message of projectedMessages) {
        const previewUrls = collectUserMessageBlobPreviewUrls(message);
        if (previewUrls.length === 0) {
          revokeUserMessagePreviewUrls(message);
          continue;
        }
        additions[message.id] = previewUrls;
      }
      return Object.keys(additions).length === 0 ? existing : { ...existing, ...additions };
    });
    setOptimisticUserMessages((existing) =>
      existing.filter((message) => !serverIds.has(message.id)),
    );
  }, [optimisticUserMessages, serverMessages]);

  useEffect(() => {
    if (typeof Image === "undefined") return;
    const cleanups: Array<() => void> = [];
    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      const serverMessage = displayServerMessages.find((message) => message.id === messageId);
      const serverPreviewUrls = (serverMessage?.attachments ?? []).flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }
      let cancelled = false;
      const images: HTMLImageElement[] = [];
      void Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              images.push(image);
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => reject(), { once: true });
              image.src = previewUrl;
            }),
        ),
      ).then(
        () => {
          if (cancelled) return;
          setAttachmentPreviewHandoffByMessageId((existing) => {
            if (!(messageId in existing)) return existing;
            const next = { ...existing };
            delete next[messageId];
            return next;
          });
          for (const previewUrl of handoffPreviewUrls) revokeBlobPreviewUrl(previewUrl);
        },
        () => {},
      );
      cleanups.push(() => {
        cancelled = true;
        for (const image of images) image.src = "";
      });
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [attachmentPreviewHandoffByMessageId, displayServerMessages]);

  useEffect(
    () => () => {
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
      for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
        for (const previewUrl of previewUrls) revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );

  const runtimeMode = summary.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = summary.interactionMode ?? DEFAULT_INTERACTION_MODE;

  const onSend = useCallback(
    async (event?: { preventDefault: () => void }) => {
      event?.preventDefault();
      if (!canBeginBoardComposerSend(environmentConnection, sendInFlightRef.current)) return;

      sendInFlightRef.current = true;
      setIsSendBusy(true);
      let optimisticMessageId: MessageId | null = null;
      let sentDraft: {
        readonly prompt: string;
        readonly images: ComposerImageAttachment[];
      } | null = null;
      let sendSucceeded = false;
      let sendError: unknown = null;
      try {
        const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
        if (!draft) return;
        const submission = resolveBoardComposerSubmission({
          prompt: draft.prompt,
          imageCount: draft.images.length,
        });
        if (submission === null) return;
        const requestedModelSelection = resolveBoardComposerModelSelection(
          draft,
          summary.modelSelection,
        );
        const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
          providers: providerStatuses,
          hasStartedSession: summary.session !== null,
          currentModelSelection: summary.modelSelection,
          currentProviderInstanceId: summary.session?.providerInstanceId ?? null,
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
        const attachmentsPromise = Promise.all(
          draft.images.map(async (image) => ({
            type: "image" as const,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
          })),
        );

        optimisticMessageId = messageId;
        sentDraft = { prompt: draft.prompt, images: [...draft.images] };
        setTimelineAnchorMessageId(messageId);
        setOptimisticUserMessages((existing) => [
          ...existing,
          {
            id: messageId,
            role: "user",
            text: submission.text,
            ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
            turnId: null,
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
        const attachments = await attachmentsPromise;
        const result = await startThreadTurn({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            message: {
              messageId,
              role: "user",
              text: submission.text,
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
          setTimelineAnchorMessageId((current) =>
            current === optimisticMessageId ? null : current,
          );

          const currentDraft = useComposerDraftStore.getState().getComposerDraft(threadRef);
          if (boardComposerDraftCanBeRestored(currentDraft)) {
            const retryImages = sentDraft.images.map(cloneComposerImageForRetry);
            for (const image of sentDraft.images) revokeBlobPreviewUrl(image.previewUrl);
            promptRef.current = sentDraft.prompt;
            composerImagesRef.current = retryImages;
            const draftStore = useComposerDraftStore.getState();
            draftStore.setPrompt(threadRef, sentDraft.prompt);
            draftStore.addImages(threadRef, retryImages);
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
    },
    [
      environmentConnection.phase,
      environmentId,
      providerStatuses,
      startThreadTurn,
      summary,
      threadRef,
      updateThreadMetadata,
    ],
  );

  const onInterrupt = useCallback(async () => {
    await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(summary),
    });
  }, [environmentId, interruptThreadTurn, summary]);

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      await respondToThreadApproval({
        environmentId,
        input: { threadId: threadRef.threadId, requestId, decision },
      });
    },
    [environmentId, respondToThreadApproval, threadRef],
  );

  const setComposerDraftModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
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
      if (lockedProvider !== null && summary.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === summary.session?.providerInstanceId,
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
        hasStartedSession: summary.session !== null,
        currentModelSelection: summary.modelSelection,
        currentProviderInstanceId: summary.session?.providerInstanceId ?? null,
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
    },
    [
      focusComposer,
      lockedProvider,
      providerStatuses,
      setComposerDraftModelSelection,
      settings,
      summary,
      threadRef,
    ],
  );

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: summary.session !== null,
        currentModelSelection: summary.modelSelection,
        currentProviderInstanceId: summary.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [providerStatuses, summary],
  );

  const toggleInteractionMode = useCallback(() => {
    const next: ProviderInteractionMode =
      interactionMode === "plan" ? DEFAULT_INTERACTION_MODE : "plan";
    void setThreadInteractionMode({
      environmentId,
      input: { threadId: threadRef.threadId, interactionMode: next },
    });
  }, [environmentId, interactionMode, setThreadInteractionMode, threadRef]);

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      void setThreadRuntimeMode({
        environmentId,
        input: { threadId: threadRef.threadId, runtimeMode: mode },
      });
    },
    [environmentId, setThreadRuntimeMode, threadRef],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      void setThreadInteractionMode({
        environmentId,
        input: { threadId: threadRef.threadId, interactionMode: mode },
      });
    },
    [environmentId, setThreadInteractionMode, threadRef],
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
      activeThreadId: summary.id,
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
      focusComposer,
      scheduleComposerFocus: focusComposer,
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
      environmentConnection,
      environmentLabel,
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
      focusComposer,
      onExpandImage,
    ],
  );

  return {
    chatComposerProps,
    composerRef,
    timelineMessages,
    timelineAnchorMessageId,
    clearTimelineAnchor,
  };
}
