import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/**
 * Per-card presentation state for the session board: how large each card is.
 *
 * This is deliberately client-only, like the board lane assignment. Card
 * size is a property of this screen and should not follow a session to
 * another device.
 *
 * Keyed by `scopedThreadKey`, matching `previewMiniPlayerStore` and the other
 * per-thread client stores.
 */

const BOARD_CARD_STORAGE_KEY = "t3code:board-cards:v1";
const BOARD_CARD_STORAGE_VERSION = 3;

export const CARD_DEFAULT_HEIGHT = 520;
export const CARD_MIN_HEIGHT = CARD_DEFAULT_HEIGHT;
export const CARD_MAX_HEIGHT = 900;
export const CARD_DEFAULT_WIDTH = 428;
export const CARD_MIN_WIDTH = 340;
const LEGACY_COMPACT_HEIGHT = 260;

export interface BoardCardState {
  readonly heightPx?: number;
  readonly widthPx?: number;
}

interface BoardCardStoreState {
  readonly byThreadKey: Record<string, BoardCardState>;
  readonly setHeight: (ref: ScopedThreadRef, heightPx: number) => void;
  readonly setWidth: (ref: ScopedThreadRef, widthPx: number) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

export function clampCardHeight(heightPx: number): number {
  if (!Number.isFinite(heightPx)) return CARD_DEFAULT_HEIGHT;
  return Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, Math.round(heightPx)));
}

export function clampCardWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return CARD_DEFAULT_WIDTH;
  return Math.max(CARD_MIN_WIDTH, Math.round(widthPx));
}

/** Clamps persisted dimensions on read, since storage is not trusted blindly. */
function normalizePersistedByThreadKey(persistedState: unknown): Record<string, BoardCardState> {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  const source = (persistedState as { byThreadKey?: unknown }).byThreadKey;
  if (typeof source !== "object" || source === null) return {};
  const byThreadKey: Record<string, BoardCardState> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const height = (value as { heightPx?: unknown } | null)?.heightPx;
    const width = (value as { widthPx?: unknown } | null)?.widthPx;
    if (typeof height !== "number" && typeof width !== "number") continue;
    byThreadKey[key] = {
      ...(typeof height === "number" ? { heightPx: clampCardHeight(height) } : {}),
      ...(typeof width === "number" ? { widthPx: clampCardWidth(width) } : {}),
    };
  }
  return byThreadKey;
}

function migratePersistedBoardCardState(persistedState: unknown, version: number): unknown {
  const byThreadKey = normalizePersistedByThreadKey(persistedState);
  if (version >= 2) return { byThreadKey };

  // Version 1 exposed compact/tall preset buttons. Compact was the default,
  // so exact preset values are upgraded to the useful full-card default.
  // Taller drag-resized heights remain personal and are preserved; every
  // shorter legacy value is raised to the new minimum during normalization.
  return {
    byThreadKey: Object.fromEntries(
      Object.entries(byThreadKey).map(([key, value]) => [
        key,
        value.heightPx === LEGACY_COMPACT_HEIGHT
          ? { ...value, heightPx: CARD_DEFAULT_HEIGHT }
          : value,
      ]),
    ),
  };
}

export const useBoardCardStore = create<BoardCardStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      setHeight: (ref, heightPx) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const next = clampCardHeight(heightPx);
          if (state.byThreadKey[threadKey]?.heightPx === next) return state;
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...state.byThreadKey[threadKey], heightPx: next },
            },
          };
        }),
      setWidth: (ref, widthPx) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const next = clampCardWidth(widthPx);
          if (state.byThreadKey[threadKey]?.widthPx === next) return state;
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...state.byThreadKey[threadKey], widthPx: next },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: BOARD_CARD_STORAGE_KEY,
      version: BOARD_CARD_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      migrate: migratePersistedBoardCardState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        byThreadKey: normalizePersistedByThreadKey(persistedState),
      }),
    },
  ),
);

export function selectCardHeight(
  byThreadKey: Record<string, BoardCardState>,
  ref: ScopedThreadRef,
): number {
  return byThreadKey[scopedThreadKey(ref)]?.heightPx ?? CARD_DEFAULT_HEIGHT;
}

export function selectCardWidth(
  byThreadKey: Record<string, BoardCardState>,
  ref: ScopedThreadRef,
): number {
  return byThreadKey[scopedThreadKey(ref)]?.widthPx ?? CARD_DEFAULT_WIDTH;
}
