/**
 * Chromium HTML-in-canvas bindings that are not yet part of TypeScript's DOM
 * library. The implementation follows the WICG WebGL cube example: upload
 * with the current three-argument overload first, then fall back to the
 * legacy six-argument overload used by older developer-trial builds.
 */

export interface CanvasPaintEvent extends Event {
  readonly changedElements: readonly Element[];
}

declare global {
  interface HTMLCanvasElement {
    onpaint: ((event: CanvasPaintEvent) => void) | null;
    requestPaint?(): void;
  }

  interface WebGL2RenderingContext {
    texElementImage2D(target: number, internalformat: number, element: HTMLElement): void;
    texElementImage2D(
      target: number,
      level: number,
      internalformat: number,
      format: number,
      type: number,
      element: HTMLElement,
    ): void;
  }
}

/** True when this browser exposes Chromium's HTML-to-WebGL upload API. */
export function isElementCaptureSupported(): boolean {
  return (
    typeof WebGL2RenderingContext !== "undefined" &&
    typeof WebGL2RenderingContext.prototype.texElementImage2D === "function"
  );
}

/**
 * Upload a direct canvas child into the currently-bound texture. Chrome's API
 * changed during the developer trial, so current builds use three arguments
 * while older builds require the texImage2D-shaped six-argument form.
 */
export function uploadElementToBoundTexture(
  gl: WebGL2RenderingContext,
  element: HTMLElement,
): boolean {
  // DOM pixels are top-to-bottom; WebGL texture coordinates are bottom-to-top.
  // Match the official cube demo so card text is not vertically inverted.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  try {
    gl.texElementImage2D(gl.TEXTURE_2D, gl.RGBA8, element);
    return true;
  } catch {
    try {
      gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, element);
      return true;
    } catch {
      return false;
    }
  }
}
