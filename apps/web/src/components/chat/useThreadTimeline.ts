import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import {
  deriveLatestThreadRun,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type {
  MessageId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";

import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries.ts";
import { useClientSettings } from "../../hooks/useSettings.ts";
import { deriveActiveWorkStartedAt, isLatestRunSettled } from "../../session-logic.ts";
import { useProject, useThreadCheckpointSummaries } from "../../state/entities.ts";
import type { ChatMessage, SidebarThreadSummary } from "../../types.ts";
import { deriveCommittedServerUserMessageIds } from "../ChatView.logic.ts";

/**
 * User messages the server already has. Optimistic sends retire against this,
 * including queued messages that have no turn item yet.
 */
export function deriveServerAcknowledgedUserMessageIds(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  detail: EnvironmentThread | null,
): ReadonlySet<MessageId> {
  const ids = new Set(deriveCommittedServerUserMessageIds(visibleTurnItems));
  for (const message of detail?.projection.messages ?? []) {
    if (message.role === "user") ids.add(message.id);
  }
  return ids;
}

const EMPTY_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_PENDING_REQUESTS = { approvals: [], userInputs: [] } as const;

export type UseThreadTimelineInput = {
  readonly threadRef: ScopedThreadRef;
  readonly shell: SidebarThreadSummary;
  readonly detail: EnvironmentThread | null;
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly optimisticMessages: ReadonlyArray<ChatMessage>;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly isSendBusy: boolean;
};

/**
 * The embedded-card subset of ChatView's timeline derivation: the server
 * projection's visible turn items plus this card's optimistic sends.
 */
export function useThreadTimeline(input: UseThreadTimelineInput) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { threadRef, shell } = input;
  const routeThreadKey = scopedThreadKey(threadRef);
  const projection = input.detail?.projection ?? null;

  const project = useProject(scopeProjectRef(shell.environmentId, shell.projectId));
  const markdownCwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: shell.worktreePath ?? null,
      })
    : undefined;
  const workspaceRoot = shell.worktreePath ?? project?.workspaceRoot ?? undefined;
  const skills =
    input.providerStatuses.find(
      (provider) => provider.instanceId === shell.modelSelection.instanceId,
    )?.skills ?? EMPTY_SKILLS;

  const timelineEntries = useIncrementalTimelineEntries(routeThreadKey, {
    visibleTurnItems: input.visibleTurnItems,
    optimisticMessages: input.optimisticMessages,
    ...(projection === null
      ? {}
      : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
  });

  const latestRun = projection === null ? shell.latestRun : deriveLatestThreadRun(projection);
  const activityRun = projection === null ? shell.latestRun : deriveThreadActivityRun(projection);
  const runtime = projection === null ? shell.runtime : deriveThreadRuntime(projection);
  const runlessWorkStartedAt = projection === null ? null : deriveRunlessWorkStartedAt(projection);
  const latestRunSettled = isLatestRunSettled(latestRun, runtime);
  const isRunning = runtime?.status === "running" || runtime?.status === "waiting";
  const isWorking = isRunning || input.isSendBusy || runlessWorkStartedAt !== null;
  const activeTurnStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;

  const turnDiffSummaries = useThreadCheckpointSummaries(threadRef);
  const pendingRequests =
    projection === null ? EMPTY_PENDING_REQUESTS : derivePendingThreadRequests(projection);

  return {
    timelineEntries,
    runs: projection?.runs ?? [],
    latestRun: activityRun,
    runningRunId: runtime?.activeRunId ?? null,
    runtime,
    isWorking,
    runlessWorkActive: runlessWorkStartedAt !== null,
    activeTurnInProgress: isWorking || !latestRunSettled,
    activeTurnStartedAt,
    turnDiffSummaries,
    pendingApprovals: pendingRequests.approvals,
    pendingUserInputs: pendingRequests.userInputs,
    markdownCwd,
    workspaceRoot,
    timestampFormat,
    skills,
    routeThreadKey,
  };
}
