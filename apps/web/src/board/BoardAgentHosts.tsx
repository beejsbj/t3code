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

import { boardLaneController } from "./boardLaneController";
import { createBoardAgentRequestConsumerAtom } from "./boardAgentRequestConsumer";

function executeBoardCommand(
  environmentId: EnvironmentId,
  request: AgentBoardHostRequest,
): AgentBoardResult {
  const ref: ScopedThreadRef = { environmentId, threadId: request.threadId };
  switch (request.command.type) {
    case "lanes":
      return { type: "lanes", lanes: boardLaneController.list() };
    case "placement":
      return { type: "placement", placement: boardLaneController.placement(ref) };
    case "place": {
      const result = boardLaneController.place(ref, request.command.lane);
      if (result.type === "error") throw new Error(result.message);
      return { type: "place", placement: result.placement };
    }
    case "unplace":
      return { type: "unplace", placement: boardLaneController.unplace(ref) };
  }
}

export function BoardAgentHosts() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <BoardAgentHost key={environment.environmentId} environmentId={environment.environmentId} />
  ));
}

function BoardAgentHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const requestsAtom = agentBoardEnvironment.requests({ environmentId, input: {} });
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
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            });
        },
      }),
    [environmentId, requestsAtom, respond],
  );
  useAtomValue(consumerAtom);

  return null;
}
