import { createFileRoute } from "@tanstack/react-router";

import { SessionBoard } from "../components/board/SessionBoard.tsx";
import { useAllEnvironmentShellsBootstrapped } from "../state/entities";

function BoardRouteView() {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  return bootstrapped ? <SessionBoard /> : null;
}

export const Route = createFileRoute("/_chat/board")({
  component: BoardRouteView,
});
