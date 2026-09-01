import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BoardCardDetailLoadFailure, resolveBoardCardVisitedAt } from "./BoardSessionCard";

describe("resolveBoardCardVisitedAt", () => {
  it("acknowledges a timer wake at its wake timestamp", () => {
    const wakeAt = "2026-09-01T12:00:00.000Z";

    expect(
      resolveBoardCardVisitedAt(
        {
          snoozedUntil: wakeAt,
          snoozedAt: "2026-09-01T11:00:00.000Z",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          session: null,
          latestTurn: null,
        },
        "2026-09-01T12:01:00.000Z",
      ),
    ).toBe(wakeAt);
  });

  it("shows the detail error and retry action", () => {
    const html = renderToStaticMarkup(
      createElement(BoardCardDetailLoadFailure, {
        error: "The remote environment did not respond.",
        onRetry: () => {},
      }),
    );

    expect(html).toContain("Could not load conversation");
    expect(html).toContain("The remote environment did not respond.");
    expect(html).toContain("Retry");
  });
});
