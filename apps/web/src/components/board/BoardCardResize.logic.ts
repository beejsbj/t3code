import { clampCardWidth } from "../../board/boardCardStore.ts";

/** Separates the visible drag preview from the preference used when the row repacks. */
export function resolveBoardCardResize(input: {
  readonly preferredWidth: number;
  readonly renderedWidth: number;
  readonly availableWidth: number | null;
  readonly rowCount: number;
  readonly deltaX: number;
}) {
  const previewWidth =
    input.deltaX === 0
      ? input.renderedWidth
      : Math.min(
          input.availableWidth ?? Number.POSITIVE_INFINITY,
          clampCardWidth(input.renderedWidth + input.deltaX),
        );
  const visibleDelta = previewWidth - input.renderedWidth;
  if (visibleDelta === 0) {
    return { previewWidth, preferredWidth: input.preferredWidth };
  }
  const startingPreference = Math.min(
    input.preferredWidth,
    input.availableWidth ?? input.preferredWidth,
  );
  const compensation = input.rowCount > 1 ? input.rowCount / (input.rowCount - 1) : 1;
  return {
    previewWidth,
    preferredWidth: clampCardWidth(startingPreference + visibleDelta * compensation),
  };
}
