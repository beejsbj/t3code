/**
 * DOM-snapshot layer for the 3D board prototype (PART 2).
 *
 * Bridges Chromium's html-in-canvas API (the `canvas-draw-element` blink
 * flag) into the board renderer. An offscreen container holds one card DOM
 * element per card id; each element carries the `layoutsubtree` attribute so
 * it can be drawn into a WebGL texture via `texElementImage2D`.
 *
 * The API is Chromium-only and not yet in TypeScript's DOM lib, so the types
 * are declared locally. Detection is defensive: every feature probe is
 * guarded so a browser without the flag never throws.
 */

/** Render a single card id into a DOM element ready for snapshotting. */
export type CardRenderCallback = (id: string) => HTMLElement;

declare global {
  interface HTMLElement {
    /** Chromium html-in-canvas opt-in for drawing this subtree into a texture. */
    layoutsubtree?: boolean;
  }

  interface WebGL2RenderingContext {
    /**
     * Uploads the current rendering of an element subtree (one carrying the
     * `layoutsubtree` attribute) into the bound texture, like
     * `texImage2D` but sourcing from live DOM instead of a bitmap.
     */
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

/**
 * True when this browser can snapshot DOM card subtrees into textures:
 * `texElementImage2D` exists on the WebGL2 prototype AND the `layoutsubtree`
 * attribute survives being set on a real element. Never throws — both probes
 * are wrapped.
 */
export function isElementCaptureSupported(): boolean {
  try {
    const prototypeHasMethod =
      typeof (WebGL2RenderingContext as { prototype?: unknown } | undefined)?.prototype !==
        "undefined" &&
      typeof (
        WebGL2RenderingContext.prototype as unknown as {
          texElementImage2D?: unknown;
        }
      ).texElementImage2D === "function";

    if (!prototypeHasMethod) return false;

    const probe = document.createElement("div");
    probe.layoutsubtree = true;
    return probe.layoutsubtree === true;
  } catch {
    return false;
  }
}

/**
 * Owns the offscreen card DOM. Cards live in a single fixed container parked
 * at (-10000, 0) so they can render offscreen while remaining real DOM.
 * `layoutsubtree` elements do not need `visibility: hidden` — they are drawn
 * by the capture API directly, not composited on screen.
 *
 * Textures are refreshed on a dirty-flag basis: the renderer marks a card
 * dirty when its state/contents change and re-snapshots only those cards.
 */
export class ElementSnapshotSource {
  /**
   * The canvas whose GL context receives the snapshots. Card elements are
   * appended as DIRECT children of this canvas: texElementImage2D only accepts
   * elements that are immediate children of the canvas, and the canvas itself
   * must carry the layoutsubtree attribute. The children are real painted DOM
   * (the API needs a cached paint record), so they are stashed behind the GL
   * output with a negative z-index rather than hidden — display:none never
   * paints and the snapshot fails with "no cached paint record".
   */
  private readonly canvas: HTMLCanvasElement;
  private readonly elements = new Map<string, HTMLElement>();
  private readonly ids = new Set<string>();
  /** Insertion order, used to tile source cards across the canvas. */
  private readonly order: string[] = [];
  /** Dirty card ids. `true` means "everything is dirty" (initial state). */
  private dirty: Set<string> | "all" = "all";
  /**
   * Frames since the card set last changed. texElementImage2D needs a cached
   * paint record, which only exists after the compositor has painted the new
   * source DOM at least once — so the first snapshot is deferred by a frame.
   */
  private framesSinceChange = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Opt the canvas into subtree capture; without this the GL call rejects.
    canvas.setAttribute("layoutsubtree", "");
    canvas.layoutsubtree = true;
  }

  /**
   * Reconcile the container to hold exactly the given card ids. New ids get a
   * freshly rendered element appended; ids no longer present are removed and
   * their elements discarded. Freshly added elements are dirty.
   *
   * @param ids - the ids to host, in any order.
   * @param render - creates the DOM element for a card id (call with the card).
   */
  setCards(ids: readonly string[], render: CardRenderCallback): void {
    const next = new Set(ids);
    const changed = this.ids.size !== next.size || ![...this.ids].every((id) => next.has(id));
    for (const id of this.ids) {
      if (!next.has(id)) {
        const el = this.elements.get(id);
        if (el) el.remove();
        this.elements.delete(id);
      }
    }
    this.ids.clear();
    this.order.length = 0;
    let index = 0;
    for (const id of next) {
      this.ids.add(id);
      this.order.push(id);
      if (!this.elements.has(id)) {
        const el = render(id);
        el.setAttribute("layoutsubtree", "");
        el.layoutsubtree = true;
        // Cards must genuinely paint before texElementImage2D succeeds (the
        // API reads a cached paint record). Stacked or display:none cards get
        // culled, so we tile them across the canvas: each gets a distinct
        // painted slot below the viewport fold. The WebGL output is composited
        // over the top of the canvas's own children, so the strip never shows.
        el.style.position = "absolute";
        el.style.pointerEvents = "none";
        this.canvas.appendChild(el);
        this.elements.set(id, el);
        this.markDirty(id);
      }
      index += 1;
    }
    this.layoutTiles();
    this.framesSinceChange = 0;
    if (changed) this.markAllDirty();
  }

  /** The DOM element backing a card id, or undefined if not hosted. */
  getElement(id: string): HTMLElement | undefined {
    return this.elements.get(id);
  }

  /** Flag a single card as needing a re-snapshot on the next frame. */
  markDirty(id: string): void {
    if (this.dirty === "all") return;
    this.dirty.add(id);
  }

  /**
   * Returns the ids needing a re-snapshot and clears the dirty state. When
   * everything is dirty (initial population or a full reconcile) all hosted
   * ids are returned once.
   */
  consumeDirty(): string[] {
    this.framesSinceChange += 1;
    // Wait until the new source DOM has painted at least once before allowing
    // any snapshot; capturing earlier yields "no cached paint record".
    if (this.framesSinceChange < 2) return [];
    if (this.dirty === "all") {
      this.dirty = new Set();
      return [...this.ids];
    }
    const result = [...this.dirty];
    this.dirty.clear();
    return result;
  }

  /** Remove every hosted card element from the canvas. */
  dispose(): void {
    for (const el of this.elements.values()) el.remove();
    this.elements.clear();
    this.ids.clear();
    this.dirty = new Set();
  }

  private markAllDirty(): void {
    this.dirty = "all";
  }

  /**
   * Tile the hosted cards in a grid below the visible canvas area so every
   * card gets its own painted region. The canvas is positioned relative by
   * the view; the cards overflow below the fold and the WebGL framebuffer is
   * composited above them, so the strip is painted but not seen.
   */
  private layoutTiles(): void {
    const cardWidth = 380;
    const cardHeight = 240;
    const perRow = Math.max(1, Math.floor(1600 / cardWidth));
    this.order.forEach((id, index) => {
      const el = this.elements.get(id);
      if (!el) return;
      const col = index % perRow;
      const row = Math.floor(index / perRow);
      el.style.left = `${col * cardWidth}px`;
      el.style.top = `${1200 + row * cardHeight}px`;
    });
  }
}
