import type { AgentBoardStreamEvent } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

type StreamResult<E> = AsyncResult.AsyncResult<AgentBoardStreamEvent, E>;

/** Consumes every command event so React render batching cannot drop queued agent requests. */
export function createBoardAgentRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<StreamResult<E>>;
  readonly handle: (event: Extract<AgentBoardStreamEvent, { readonly type: "request" }>) => void;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    let version = 0;
    let disposed = false;
    const consume = (result: StreamResult<E>) => {
      if (AsyncResult.isSuccess(result) && result.value.type === "request") {
        options.handle(result.value);
      }
    };
    get.addFinalizer(() => {
      disposed = true;
    });
    const initial = get.once(options.requestsAtom);
    get.subscribe(options.requestsAtom, (result) => {
      version += 1;
      consume(result);
    });
    queueMicrotask(() => {
      if (!disposed && version === 0) consume(initial);
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
