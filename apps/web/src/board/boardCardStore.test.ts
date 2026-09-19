import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CARD_DEFAULT_HEIGHT,
  CARD_DEFAULT_WIDTH,
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  CARD_MIN_WIDTH,
  clampCardWidth,
  rehydrateBoardCardStoreForStorageKey,
  selectCardHeight,
  selectCardWidth,
  useBoardCardStore,
} from "./boardCardStore.ts";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useBoardCardStore.setState({ byThreadKey: {} });
});

describe("boardCardStore", () => {
  it("rehydrates card dimensions saved by another tab", () => {
    const rehydrate = vi.spyOn(useBoardCardStore.persist, "rehydrate").mockResolvedValue();
    rehydrateBoardCardStoreForStorageKey("unrelated");
    expect(rehydrate).not.toHaveBeenCalled();
    rehydrateBoardCardStoreForStorageKey("t3code:board-cards:v1");
    expect(rehydrate).toHaveBeenCalledOnce();
    rehydrate.mockRestore();
  });

  it("setHeight clamps to the min/max card height", () => {
    useBoardCardStore.getState().setHeight(refA, CARD_MIN_HEIGHT - 100);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(CARD_MIN_HEIGHT);

    useBoardCardStore.getState().setHeight(refA, CARD_MAX_HEIGHT + 100);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(CARD_MAX_HEIGHT);
  });

  it("does not let a resized card become shorter than the full default", () => {
    useBoardCardStore.getState().setHeight(refA, CARD_DEFAULT_HEIGHT - 200);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(
      CARD_DEFAULT_HEIGHT,
    );
  });

  it("selectCardHeight defaults to the full card height for an unknown thread", () => {
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refB)).toBe(
      CARD_DEFAULT_HEIGHT,
    );
  });

  it("setWidth clamps to the minimum card width without an artificial maximum", () => {
    useBoardCardStore.getState().setWidth(refA, CARD_MIN_WIDTH - 100);
    expect(selectCardWidth(useBoardCardStore.getState().byThreadKey, refA)).toBe(CARD_MIN_WIDTH);

    const wideCard = CARD_DEFAULT_WIDTH * 10;
    useBoardCardStore.getState().setWidth(refA, wideCard);
    expect(selectCardWidth(useBoardCardStore.getState().byThreadKey, refA)).toBe(wideCard);
  });

  it("rounds finite widths and defaults non-finite widths", () => {
    expect(clampCardWidth(CARD_DEFAULT_WIDTH + 0.6)).toBe(CARD_DEFAULT_WIDTH + 1);
    expect(clampCardWidth(Number.NaN)).toBe(CARD_DEFAULT_WIDTH);
    expect(clampCardWidth(Number.POSITIVE_INFINITY)).toBe(CARD_DEFAULT_WIDTH);
  });

  it("selectCardWidth defaults for an unknown thread", () => {
    expect(selectCardWidth(useBoardCardStore.getState().byThreadKey, refB)).toBe(
      CARD_DEFAULT_WIDTH,
    );
  });

  it("dimension setters preserve the other dimension", () => {
    useBoardCardStore.getState().setHeight(refA, 640);
    useBoardCardStore.getState().setWidth(refA, 560);
    expect(useBoardCardStore.getState().byThreadKey["env-1:thread-A"]).toEqual({
      heightPx: 640,
      widthPx: 560,
    });

    useBoardCardStore.getState().setHeight(refA, 720);
    expect(useBoardCardStore.getState().byThreadKey["env-1:thread-A"]).toEqual({
      heightPx: 720,
      widthPx: 560,
    });
  });

  it("removeThread clears persisted state", () => {
    useBoardCardStore.getState().setHeight(refA, CARD_MIN_HEIGHT);
    useBoardCardStore.getState().removeThread(refA);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(
      CARD_DEFAULT_HEIGHT,
    );
    expect(useBoardCardStore.getState().byThreadKey).toEqual({});
  });

  it("removeThread on an untouched thread is a no-op", () => {
    useBoardCardStore.getState().removeThread(refA);
    expect(useBoardCardStore.getState().byThreadKey).toEqual({});
  });

  it("clamps out-of-range persisted dimensions on rehydrate", () => {
    const persistApi = useBoardCardStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardCardStore.getState>,
        ) => ReturnType<typeof useBoardCardStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        byThreadKey: {
          "env-1:thread-A": { heightPx: CARD_MAX_HEIGHT + 1000 },
          "env-1:thread-B": {
            heightPx: CARD_MIN_HEIGHT - 1000,
            widthPx: CARD_MIN_WIDTH - 1000,
          },
          "env-1:thread-C": { widthPx: Number.POSITIVE_INFINITY },
        },
      },
      useBoardCardStore.getInitialState(),
    );

    expect(mergedState.byThreadKey).toEqual({
      "env-1:thread-A": { heightPx: CARD_MAX_HEIGHT },
      "env-1:thread-B": { heightPx: CARD_MIN_HEIGHT, widthPx: CARD_MIN_WIDTH },
      "env-1:thread-C": { widthPx: CARD_DEFAULT_WIDTH },
    });
  });

  it("keeps persisted entries with only a height or only a width", () => {
    const persistApi = useBoardCardStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardCardStore.getState>,
        ) => ReturnType<typeof useBoardCardStore.getState>;
      };
    };

    const mergedState = persistApi.getOptions().merge(
      {
        byThreadKey: {
          "env-1:thread-A": { heightPx: 640 },
          "env-1:thread-B": { widthPx: 560 },
        },
      },
      useBoardCardStore.getInitialState(),
    );

    expect(mergedState.byThreadKey).toEqual({
      "env-1:thread-A": { heightPx: 640 },
      "env-1:thread-B": { widthPx: 560 },
    });
  });

  it("drops malformed persisted entries on rehydrate", () => {
    const persistApi = useBoardCardStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardCardStore.getState>,
        ) => ReturnType<typeof useBoardCardStore.getState>;
      };
    };

    expect(
      persistApi.getOptions().merge(null, useBoardCardStore.getInitialState()).byThreadKey,
    ).toEqual({});
    expect(
      persistApi
        .getOptions()
        .merge(
          { byThreadKey: { "env-1:thread-A": { heightPx: "tall" } } },
          useBoardCardStore.getInitialState(),
        ).byThreadKey,
    ).toEqual({});
    expect(
      persistApi.getOptions().merge(
        {
          byThreadKey: {
            "env-1:thread-A": { heightPx: "tall", widthPx: 560 },
            "env-1:thread-B": { heightPx: 640, widthPx: "wide" },
            "env-1:thread-C": { widthPx: "wide" },
          },
        },
        useBoardCardStore.getInitialState(),
      ).byThreadKey,
    ).toEqual({
      "env-1:thread-A": { widthPx: 560 },
      "env-1:thread-B": { heightPx: 640 },
    });
  });

  it("migrates short legacy heights while preserving taller custom heights", () => {
    const persistApi = useBoardCardStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
      };
    };

    expect(
      persistApi.getOptions().migrate(
        {
          byThreadKey: {
            "env-1:thread-A": { heightPx: 260 },
            "env-1:thread-B": { heightPx: 640 },
          },
        },
        1,
      ),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": { heightPx: CARD_DEFAULT_HEIGHT },
        "env-1:thread-B": { heightPx: 640 },
      },
    });
  });

  it("migrates version 2 height-only entries without inventing a stored width", () => {
    const persistApi = useBoardCardStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
      };
    };

    expect(
      persistApi.getOptions().migrate(
        {
          byThreadKey: {
            "env-1:thread-A": { heightPx: 640 },
          },
        },
        2,
      ),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": { heightPx: 640 },
      },
    });
  });
});
