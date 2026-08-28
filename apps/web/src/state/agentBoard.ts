import { createAgentBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-board";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentBoardEnvironment = createAgentBoardEnvironmentAtoms(connectionAtomRuntime);
