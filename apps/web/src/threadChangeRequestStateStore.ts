import type { ChangeRequestState } from "@t3tools/contracts";
import { create } from "zustand";

interface ThreadChangeRequestStateStore {
  readonly byThreadKey: ReadonlyMap<string, ChangeRequestState>;
  readonly setThreadState: (threadKey: string, state: ChangeRequestState | null) => void;
}

/**
 * Change-request state discovered by the sidebar's existing VCS subscriptions.
 * Shared so every client projection classifies settlement from the same data.
 */
export const useThreadChangeRequestStateStore = create<ThreadChangeRequestStateStore>()((set) => ({
  byThreadKey: new Map(),
  setThreadState: (threadKey, state) =>
    set((current) => {
      if ((current.byThreadKey.get(threadKey) ?? null) === state) return current;
      const byThreadKey = new Map(current.byThreadKey);
      if (state === null) {
        byThreadKey.delete(threadKey);
      } else {
        byThreadKey.set(threadKey, state);
      }
      return { byThreadKey };
    }),
}));
