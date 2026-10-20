import type { OrchestrationV2Command, ThreadId } from "@t3tools/contracts";

/**
 * The thread whose run a client command starts or continues, so the broker can
 * route that thread's agent board commands to the sending window. Commands
 * that only organize or configure a thread return undefined: they do not say
 * which board the user is watching the agent from.
 */
export const boardOriginThreadId = (command: OrchestrationV2Command): ThreadId | undefined => {
  switch (command.type) {
    case "message.dispatch":
    case "queued-message.promote-to-steer":
    case "queue.resume":
    case "prepared-run.retry":
    case "runtime-request.respond":
      return command.threadId;
    case "thread.fork":
    case "thread.merge_back":
      return command.targetThreadId;
    default:
      return undefined;
  }
};
