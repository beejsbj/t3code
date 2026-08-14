import { describe, expect, it } from "vite-plus/test";

import {
  boardCardVisitTimestamp,
  resolveBoardTimelineFollowCancellation,
  shouldShowBoardStatusIcon,
} from "./BoardSessionCard.logic.ts";

describe("board card focus", () => {
  it("acknowledges the completed turn currently on screen", () => {
    expect(
      boardCardVisitTimestamp({
        latestTurn: {
          completedAt: "2026-08-15T05:00:00.000Z",
        },
      }),
    ).toBe("2026-08-15T05:00:00.000Z");
    expect(boardCardVisitTimestamp({ latestTurn: null })).toBeNull();
  });
});

describe("board card status glyph", () => {
  it("matches the sidebar by omitting seen idle while retaining Done", () => {
    expect(shouldShowBoardStatusIcon("idle")).toBe(false);
    expect(shouldShowBoardStatusIcon("done")).toBe(true);
    expect(shouldShowBoardStatusIcon("working")).toBe(true);
  });
});

describe("board timeline follow cancellation", () => {
  it("does not re-arm while a cancelled gesture remains inside the end band", () => {
    expect(
      resolveBoardTimelineFollowCancellation({
        state: { cancelled: true, leftEndBand: false },
        isAtEnd: true,
      }),
    ).toEqual({ cancelled: true, leftEndBand: false });
  });

  it("re-arms after leaving the end band and returning", () => {
    const away = resolveBoardTimelineFollowCancellation({
      state: { cancelled: true, leftEndBand: false },
      isAtEnd: false,
    });
    expect(away).toEqual({ cancelled: true, leftEndBand: true });
    expect(resolveBoardTimelineFollowCancellation({ state: away, isAtEnd: true })).toEqual({
      cancelled: false,
      leftEndBand: false,
    });
  });

  it("re-arms on an explicit return to the end", () => {
    expect(
      resolveBoardTimelineFollowCancellation({
        state: { cancelled: true, leftEndBand: false },
        isAtEnd: true,
        explicitReturn: true,
      }),
    ).toEqual({ cancelled: false, leftEndBand: false });
  });
});
