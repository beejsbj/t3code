"use client";

import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentBoardHostRequest,
  AgentBoardResult,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironments } from "~/state/environments";
import { agentBoardEnvironment } from "~/state/agentBoard";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";

import { boardLaneController } from "./boardLaneController";
import { createBoardAgentRequestConsumerAtom } from "./boardAgentRequestConsumer";

const BOARD_AGENT_CLIENT_ID = randomUUID();

export function executeBoardCommand(
  environmentId: EnvironmentId,
  request: AgentBoardHostRequest,
): AgentBoardResult {
  if (Date.now() >= request.expiresAtMs) {
    throw new Error("The board command expired before this client could execute it.");
  }
  switch (request.command.type) {
    case "lanes":
      return { type: "lanes", lanes: boardLaneController.list() };
    case "lane": {
      if (request.threadId === undefined) throw new Error("A thread ID is required.");
      const ref: ScopedThreadRef = { environmentId, threadId: request.threadId };
      return { type: "lane", state: boardLaneController.current(ref) };
    }
    case "move": {
      if (request.threadId === undefined) throw new Error("A thread ID is required.");
      const ref: ScopedThreadRef = { environmentId, threadId: request.threadId };
      const result = boardLaneController.move(ref, request.command.lane);
      if (result.type === "error") throw new Error(result.message);
      return { type: "move", state: result.state };
    }
  }
}

export function BoardAgentHosts() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <BoardAgentHost key={environment.environmentId} environmentId={environment.environmentId} />
  ));
}

function BoardAgentHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const clientKind = window.desktopBridge ? "desktop-renderer" : "web";
  const requestsAtom = agentBoardEnvironment.requests({
    environmentId,
    input: {
      clientId: BOARD_AGENT_CLIENT_ID,
      kind: clientKind,
      label: clientKind === "desktop-renderer" ? "Desktop" : `Web (${window.location.host})`,
    },
  });
  const respond = useAtomCommand(agentBoardEnvironment.respond, "agent board response");
  const consumerAtom = useMemo(
    () =>
      createBoardAgentRequestConsumerAtom({
        requestsAtom,
        label: `agent-board-host:${environmentId}`,
        handle: ({ request }) => {
          void Promise.resolve()
            .then(() => executeBoardCommand(environmentId, request))
            .then(
              (result) =>
                respond({ environmentId, input: { requestId: request.requestId, result } }),
              (cause) =>
                respond({
                  environmentId,
                  input: {
                    requestId: request.requestId,
                    error: cause instanceof Error ? cause.message : "The board command failed.",
                  },
                }),
            )
            .then((result) => {
              if (result._tag === "Failure") {
                console.error("Could not return the board command receipt.", {
                  cause: squashAtomCommandFailure(result),
                });
              }
            })
            .catch((cause: unknown) => {
              console.error("Could not handle the board command request.", { cause });
            });
        },
      }),
    [environmentId, requestsAtom, respond],
  );
  useAtomValue(consumerAtom);

  return null;
}
