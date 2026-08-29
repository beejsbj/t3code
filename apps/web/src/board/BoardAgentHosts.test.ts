import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { executeBoardCommand } from "./BoardAgentHosts.tsx";
import {
  DEFAULT_BOARD_LANES,
  DEFAULT_BOARD_ORGANIZATION,
  selectBoardPlacement,
  useBoardLaneStore,
} from "./boardLaneStore.ts";

const environmentId = "env-a" as EnvironmentId;
const threadId = ThreadId.make("thread-1");
const ref = scopeThreadRef(environmentId, threadId);

beforeEach(() => {
  useBoardLaneStore.setState({
    lanes: DEFAULT_BOARD_LANES,
    placementByThreadKey: {},
    laneEntryByThreadKey: {},
    orderByLaneId: {},
    byLaneColumnKey: {},
    collapsedLifecycleLaneIds: [],
    organization: DEFAULT_BOARD_ORGANIZATION,
  });
});

it("rejects an expired move before mutating the client-local store", () => {
  expect(() =>
    executeBoardCommand(environmentId, {
      requestId: "request-1",
      expiresAtMs: Date.now() - 1,
      threadId,
      command: { type: "move", lane: "review" },
    }),
  ).toThrow("expired");

  expect(
    selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, ref),
  ).toBeUndefined();
});
