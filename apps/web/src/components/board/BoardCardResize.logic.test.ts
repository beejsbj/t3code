import { describe, expect, it } from "vite-plus/test";

import { resolveBoardCardResize } from "./BoardCardResize.logic.ts";

const row = { preferredWidth: 340, renderedWidth: 496, availableWidth: 1000, rowCount: 2 };

describe("resolveBoardCardResize", () => {
  it("moves the preview by the pointer distance and compensates the saved preference", () => {
    expect(resolveBoardCardResize({ ...row, deltaX: 50 })).toEqual({
      previewWidth: 546,
      preferredWidth: 440,
    });
  });

  it.each([0, 1, 50])("preserves a clipped preference with %ipx of outward movement", (deltaX) => {
    expect(
      resolveBoardCardResize({
        preferredWidth: 600,
        renderedWidth: 364,
        availableWidth: 364,
        rowCount: 1,
        deltaX,
      }),
    ).toEqual({ previewWidth: 364, preferredWidth: 600 });
  });

  it("shrinks a clipped card starting from its visible edge", () => {
    expect(
      resolveBoardCardResize({
        preferredWidth: 900,
        renderedWidth: 600,
        availableWidth: 600,
        rowCount: 1,
        deltaX: -50,
      }),
    ).toEqual({ previewWidth: 550, preferredWidth: 550 });
  });

  it("preserves fractional rendered widths on a height-only drag", () => {
    expect(resolveBoardCardResize({ ...row, renderedWidth: 496.5, deltaX: 0 })).toEqual({
      previewWidth: 496.5,
      preferredWidth: 340,
    });
  });

  it("keeps the preview within a container narrower than the card minimum", () => {
    expect(
      resolveBoardCardResize({
        preferredWidth: 428,
        renderedWidth: 300,
        availableWidth: 300,
        rowCount: 1,
        deltaX: 30,
      }),
    ).toEqual({ previewWidth: 300, preferredWidth: 428 });
  });

  it("respects the minimum while shrinking", () => {
    expect(resolveBoardCardResize({ ...row, deltaX: -300 })).toEqual({
      previewWidth: 340,
      preferredWidth: 340,
    });
  });
});
