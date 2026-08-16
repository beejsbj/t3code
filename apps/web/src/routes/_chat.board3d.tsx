import { createFileRoute } from "@tanstack/react-router";

import { Board3DView } from "../components/board3d/Board3DView.tsx";

/**
 * Board Palace prototype route. Dev-flag gated: set
 * `localStorage["t3:board3d"] = "1"` to enable. The 2D board at /board is
 * untouched; this is a sibling so the prototype can live or die on its own.
 */
export const Route = createFileRoute("/_chat/board3d")({
  component: function Board3DRoute(): React.JSX.Element {
    if (typeof window !== "undefined" && window.localStorage.getItem("t3:board3d") !== "1") {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Board Palace is a prototype. Enable it with{" "}
          <code className="ml-1 rounded bg-muted px-1">localStorage["t3:board3d"] = "1"</code> and
          reload.
        </div>
      );
    }
    return <Board3DView />;
  },
});
