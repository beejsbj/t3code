import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import {
  boardLaneForPlacementAction,
  buildBoardPlacementContextMenuItems,
} from "../board/boardPlacementMenu.ts";
import { boardLaneController } from "../board/boardLaneController.ts";
import type { BoardLane } from "../board/boardLaneStore.ts";
import { resolveSnoozePresets, snoozeWakeDescription } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readLocalApi } from "../localApi";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { useUiStateStore } from "../uiStateStore";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The per-thread action menu (pin, settle, snooze, rename, copy, delete…) as
 * a self-contained hook, for surfaces other than the sidebar row — today the
 * chat header. Renders through the native context-menu bridge and dispatches
 * through the same mutations the sidebar uses.
 *
 * Unlike the sidebar, settle and snooze here never navigate away: the caller
 * is acting on the thread they are reading, and ChatView's parked-thread
 * banner already offers the way back.
 */
export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** Fallback for "Copy path" when the thread has no worktree. */
  readonly projectCwd: string | null;
  readonly onStartRename: () => void;
  /** Board surfaces append lane placement to the otherwise shared menu. */
  readonly boardLanes?: ReadonlyArray<BoardLane>;
}) {
  const { threadRef, projectCwd, onStartRename, boardLanes } = input;
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "Branch copied", description: branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "Thread ID copied", description: threadId });
    },
    onError: (error) => failureToast("Failed to copy thread ID", error),
  });

  const settle = useCallback(async () => {
    if (threadRef === null) return false;
    const result = await settleThread(threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Failed to settle thread", squashAtomCommandFailure(result));
      return false;
    }
    return result._tag === "Success";
  }, [settleThread, threadRef]);

  const unsettle = useCallback(async () => {
    if (threadRef === null) return false;
    const result = await unsettleThread(threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Failed to un-settle thread", squashAtomCommandFailure(result));
      return false;
    }
    return result._tag === "Success";
  }, [threadRef, unsettleThread]);

  const unsnooze = useCallback(async () => {
    if (threadRef === null) return false;
    const result = await unsnoozeThread(threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Failed to wake thread", squashAtomCommandFailure(result));
      return false;
    }
    return result._tag === "Success";
  }, [threadRef, unsnoozeThread]);

  const snooze = useCallback(
    async (preset: ReturnType<typeof resolveSnoozePresets>[number]) => {
      if (threadRef === null) return false;
      const result = await snoozeThread(threadRef, preset.snoozedUntil);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          failureToast("Failed to snooze thread", squashAtomCommandFailure(result));
        }
        return false;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
          timeout: 5_000,
          actionProps: {
            children: "Undo",
            onClick: () => {
              void unsnoozeThread(threadRef).then((undone) => {
                if (undone._tag === "Failure" && !isAtomCommandInterrupted(undone)) {
                  failureToast("Failed to wake thread", squashAtomCommandFailure(undone));
                }
              });
            },
          },
        }),
      );
      return true;
    },
    [snoozeThread, threadRef, timestampFormat, unsnoozeThread],
  );

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (threadRef === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        // Snapshot at open time — the menu is modal, so state read now is
        // what the user is looking at.
        const thread = readThreadShell(threadRef);
        if (!thread) return;
        const now = new Date();
        const supports = {
          settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
          snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
          pinning: readEnvironmentSupportsPinning(threadRef.environmentId),
          titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
        };
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const snoozePresets = resolveSnoozePresets(now, timestampFormat);
        const isSnoozed = supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() });
        const isSettled = supports.settlement && thread.settledOverride === "settled";
        const items = [
          ...buildThreadActionMenuItems({
            branch: thread.branch ?? null,
            isPinned: thread.pinnedAt != null,
            isSettled,
            isSnoozed,
            canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
            isRegeneratingTitle,
            isRunning: thread.session?.status === "running" && thread.session.activeTurnId != null,
            supports,
            snoozePresets,
          }),
          ...(boardLanes ? buildBoardPlacementContextMenuItems(boardLanes) : []),
        ];
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const laneId = boardLanes
          ? boardLaneForPlacementAction(clicked.value, boardLanes)
          : undefined;
        if (laneId !== undefined) {
          // Lifecycle is server-owned. Moving a parked thread back to a
          // workflow lane performs the same reverse actions as the sidebar
          // before saving its client-local spatial placement.
          if (isSnoozed && !(await unsnooze())) return;
          if (isSettled && !(await unsettle())) return;
          boardLaneController.placeInLane(threadRef, laneId);
          return;
        }
        const action = clicked.value as ThreadActionMenuId;
        if (action.startsWith("snooze:")) {
          const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          await snooze(preset);
          return;
        }
        const reportFailure = async (
          title: string,
          run: () => Promise<AtomCommandResult<unknown, unknown>>,
        ) => {
          const result = await run();
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(title, squashAtomCommandFailure(result));
          }
        };
        switch (action) {
          case "project-settings": {
            const project = projects.find(
              (candidate) =>
                candidate.environmentId === thread.environmentId &&
                candidate.id === thread.projectId,
            );
            if (!project) return;
            const projectKey =
              logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
              deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
            void router.navigate({
              to: "/projects/$projectKey",
              params: { projectKey },
            });
            return;
          }
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              failureToast("Could not create thread", squashAtomCommandFailure(result));
            }
            return;
          }
          case "settle":
            await settle();
            return;
          case "unsettle":
            await unsettle();
            return;
          case "unsnooze":
            await unsnooze();
            return;
          case "pin":
            await reportFailure("Failed to pin thread", () => pinThread(threadRef));
            return;
          case "unpin": {
            await reportFailure("Failed to unpin thread", () => confirmAndUnpinThread(threadRef));
            return;
          }
          case "rename":
            onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle) return;
            await reportFailure("Failed to regenerate thread title", () =>
              updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              }),
            );
            return;
          case "mark-unread":
            markThreadUnread(scopedThreadKey(threadRef), thread.latestTurn?.completedAt);
            return;
          case "copy-path": {
            const workspacePath = thread.worktreePath ?? projectCwd;
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          }
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              failureToast(
                didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
                squashAtomCommandFailure(result),
              );
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const deleted = await deleteThread(threadRef);
            if (
              deleted._tag === "Failure" &&
              !isAtomCommandInterrupted(deleted) &&
              // A failure with the thread already gone is worktree cleanup
              // failing after a successful delete — deleteThread has toasted
              // that itself, and "Failed to delete thread" would be a lie.
              readThreadShell(threadRef) !== null
            ) {
              failureToast("Failed to delete thread", squashAtomCommandFailure(deleted));
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      boardLanes,
      confirmThreadArchive,
      confirmThreadDelete,
      confirmAndUnpinThread,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleNewThread,
      logicalProjectKeyByPhysicalKey,
      markThreadUnread,
      onStartRename,
      pinThread,
      projectCwd,
      projectGroupingSettings,
      projects,
      router,
      settle,
      snooze,
      threadRef,
      timestampFormat,
      unsnooze,
      unsettle,
      updateThreadMetadata,
    ],
  );

  const closeMenu = useCallback(() => {
    void readLocalApi()?.contextMenu.close();
  }, []);

  return { openMenu, closeMenu, settle, unsettle, snooze, unsnooze };
}
