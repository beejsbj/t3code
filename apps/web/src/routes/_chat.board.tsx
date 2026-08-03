import { createFileRoute, redirect } from "@tanstack/react-router";

import { SessionBoard } from "../components/board/SessionBoard.tsx";

export const Route = createFileRoute("/_chat/board")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
  component: SessionBoard,
});
