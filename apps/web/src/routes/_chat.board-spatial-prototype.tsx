import { createFileRoute } from "@tanstack/react-router";

import { SpatialBoardPrototype } from "../components/board-spatial-prototype/SpatialBoardPrototype.tsx";

export const Route = createFileRoute("/_chat/board-spatial-prototype")({
  component: function BoardSpatialPrototypeRoute(): React.JSX.Element {
    if (!import.meta.env.DEV) return <div />;
    return <SpatialBoardPrototype />;
  },
});
