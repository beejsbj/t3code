import { create } from "zustand";

/**
 * Which session the board is pointed at, shared with the sidebar.
 *
 * The sidebar and the board render the same sessions, so clicking a sidebar row
 * while the board is open must move the board rather than route away from it —
 * there is nowhere to navigate to when the card already *is* the chat.
 *
 * The sidebar cannot see the board's viewport, so it only ever *requests*
 * focus. The board decides what a request means (scroll the card into view, or
 * open it if it is already on screen) because it is the only surface that knows
 * where its cards are. Deliberately not persisted: focus is about this glance
 * at this screen.
 */

export interface BoardFocusRequest {
  readonly threadKey: string;
  /** Always open the card, skipping the scroll-first step (double click). */
  readonly open: boolean;
  /** Bumped per request so clicking the same row twice re-runs the effect. */
  readonly nonce: number;
}

interface BoardFocusStoreState {
  readonly request: BoardFocusRequest | null;
  readonly focusedThreadKey: string | null;
  readonly expandedThreadKey: string | null;
  readonly requestFocus: (threadKey: string, options?: { readonly open?: boolean }) => void;
  readonly setFocused: (threadKey: string | null) => void;
  readonly setExpanded: (threadKey: string | null) => void;
}

export const useBoardFocusStore = create<BoardFocusStoreState>()((set) => ({
  request: null,
  focusedThreadKey: null,
  expandedThreadKey: null,
  requestFocus: (threadKey, options) =>
    set((state) => ({
      request: {
        threadKey,
        open: options?.open === true,
        nonce: (state.request?.nonce ?? 0) + 1,
      },
    })),
  setFocused: (threadKey) =>
    set((state) =>
      state.focusedThreadKey === threadKey ? state : { focusedThreadKey: threadKey },
    ),
  setExpanded: (threadKey) =>
    set((state) =>
      state.expandedThreadKey === threadKey ? state : { expandedThreadKey: threadKey },
    ),
}));

/** Points the board at a session from outside it (the sidebar, today). */
export function requestBoardFocus(threadKey: string, options?: { readonly open?: boolean }): void {
  useBoardFocusStore.getState().requestFocus(threadKey, options);
}
