import { createFileRoute, redirect } from "@tanstack/react-router";

// The board lives at `/`. This route stays registered so existing `/board`
// links and bookmarks keep resolving, but it only ever redirects — it never
// renders, so it deliberately carries no component.
export const Route = createFileRoute("/_chat/board")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
