# HTML-in-Canvas: intended usage patterns vs. Board Palace

Research note for the Board Palace joy prototype. Scope: how Chromium's
experimental HTML-in-canvas API is _meant_ to be used, compared against our
current implementation in apps/web/src/components/board3d/. No code changes
were made; this is a source-cited report.

## TL;DR

Our prototype works, but two of its "discovered API contract" facts are stale,
and the intended pattern is materially simpler than what we built:

- layoutsubtree canvas children are **not painted to screen until they are
  drawn**. The "tile real DOM below the viewport fold" trick in
  elementCapture.ts is unnecessary.
- The update loop is the **paint event**, not a rAF dirty-poll with a manual
  one-frame deferral. canvas.onpaint + canvas.requestPaint() replace
  consumeDirty() / framesSinceChange.
- texElementImage2D is a **three-argument** call:
  gl.texElementImage2D(target, internalformat, element[, config]). The
  six-argument texImage2D-style overload we use is the old shape, kept only
  as a compat fallback in the spec's own example.

## Primary sources

- WICG explainer: https://github.com/WICG/html-in-canvas/blob/main/README.md
- WICG examples: https://github.com/WICG/html-in-canvas/tree/main/Examples
- Chromium IDL/impl: html_canvas_element.idl, webgl_rendering_context_base.idl,
  webgl_copy_element_image_config.idl, canvas_paint_event.idl,
  webgl_rendering_context_base.cc, html_canvas_element.cc,
  runtime_enabled_features.json5
- three.js HTMLTexture experiment: PR https://github.com/mrdoob/three.js/pull/31233
- Chrome Platform Status: https://chromestatus.com/feature/5172548013916160

## The intended loop (canonical shape)

1. Mark the canvas with the boolean layoutsubtree attribute and put each card
   as a **direct child** of that canvas.
2. Register canvas.onpaint and call canvas.requestPaint() after the DOM has
   been committed, to force the first paint event.
3. Inside onpaint, bind a texture and call
   gl.texElementImage2D(gl.TEXTURE_2D, gl.RGBA8, element).
4. For interactive elements, either set the child inert (skip browser
   hit-testing) or sync element.style.transform to the drawn location so the
   browser dispatches pointer events natively.

The WICG WebGL demo is the closest reference to what Board Palace does. Its
structure: canvas.onpaint = () => { main(); } then canvas.requestPaint(),
with texElementImage2D(gl.TEXTURE_2D, internalFormat, draw_element) inside
loadTexture. It also sets inert on the child because that example does not
sync transforms:
https://github.com/WICG/html-in-canvas/blob/main/Examples/webGL.html

## Key facts

### DOM ownership and layoutsubtree placement

- "layoutsubtree must be specified on the <canvas>." The **canvas** is the
  thing that opts in; children do not carry their own layoutsubtree.
  WICG README: https://github.com/WICG/html-in-canvas/blob/main/README.md
- The drawn element "must be a **direct child** of the <canvas>."
  Chromium relaxes this for deeper descendants only when they carry a new
  drawable attribute, and its TODO notes that check "purposely skips immediate
  canvas children" for now: html_canvas_element.cc, VerifyDrawElementImageEligibility.
- Our per-card el.setAttribute("layoutsubtree", "") is redundant; only the
  canvas attribute matters for direct children.

### Visibility (this kills the tile grid)

- "Canvas element children behave as if they are visible, but their rendering
  **is not visible to the user unless and until they are explicitly drawn**
  into the canvas." WICG README.
- Therefore the layoutTiles() grid that parks cards at left/top coordinates
  "below the viewport fold" in elementCapture.ts is solving a problem the API
  does not have. Cards can be appended as plain children with no positioning.

### Paint timing

- "A snapshot of the rendering of all children of the canvas is recorded just
  prior to the paint event." Drawing inside onpaint uses the current
  frame's snapshot; drawing outside it uses the previous frame's snapshot.
- "An exception is thrown if drawElementImage() is called with a child before
  an initial snapshot has been recorded." This is what requestPaint() +
  onpaint solves deterministically; our framesSinceChange < 2 gate reinvents it.
- Chromium's event is CanvasPaintEvent with changedElements: FrozenArray<Element>
  (canvas_paint_event.idl). The explainer calls it PaintEvent; the field is
  the useful part either way.

### Update loop

- The paint event "fires if the rendering of any canvas children has changed"
  and reports which children changed. requestPaint() causes it to fire once
  even when nothing changed -- the documented per-frame escape hatch.
  WICG README.
- This replaces our rAF loop's consumeDirty() / dirty-set / one-frame deferral
  machinery: react to changedElements instead of tracking dirty flags by hand.

### Rasterization: browser-owned, not manual

- WebGLRenderingContextBase::texElementImage2D calls GetElementImage(...)
  to produce a StaticBitmapImage, then TexImageStaticBitmapImage(...)
  (webgl_rendering_context_base.cc). The browser snapshots and rasterizes the
  subtree internally; we never draw DOM into a 2D canvas or screenshot it.
- WebGLCopyElementImageConfig = {sx, sy, swidth, sheight, width, height},
  all optional (webgl_copy_element_image_config.idl). Source/destination
  rects are a config object, not positional texture arguments.

### Interaction: two sanctioned models

- **inert + own picking** -- WICG's WebGL demo sets inert on the child and
  does not route events into it. We already do the equivalent (custom raycast +
  hover), which is legitimate but not the only option.
- **Native hit-testing via CSS transform sync** -- the three.js
  InteractionManager computes a matrix3d transform each frame from
  MVP x viewport x pixel-to-local, assigns it to element.style.transform, and
  lets the browser dispatch pointer events. Its own comment: "no raycasting or
  synthetic events needed."
  https://raw.githack.com/mrdoob/three.js/htmltexture/examples/jsm/interaction/InteractionManager.js
- The platform helper is canvas.getElementTransform(element, drawTransform)
  returning a DOMMatrix (html_canvas_element.idl).

## The three.js reference

PR 31233 added HTMLTexture and InteractionManager:

- HTMLTexture sets needsUpdate = true, then if its parent supports
  requestPaint, registers parent.onpaint = () => { this.needsUpdate = true }
  and calls parent.requestPaint(). That is the entire update contract.
  https://raw.githack.com/mrdoob/three.js/htmltexture/src/textures/HTMLTexture.js
- The PR body notes the renderer "automatically sets up layoutsubtree on the
  canvas and appends the element as a child."
  https://github.com/mrdoob/three.js/pull/31233
- The demo keeps a real input and button inside the texture and receives
  native click/hover through InteractionManager.update().
  https://raw.githack.com/mrdoob/three.js/htmltexture/examples/webgl_materials_texture_html.html

## Authoritative API signatures

From Chromium IDL (webgl_rendering_context_base.idl, html_canvas_element.idl,
webgl_copy_element_image_config.idl):

- void texElementImage2D(GLenum target, GLenum internalformat, (Element or ElementImage) element, optional WebGLCopyElementImageConfig config = {})
- attribute boolean layoutSubtree (reflected layoutsubtree)
- attribute EventHandler onpaint
- void requestPaint()
- ElementImage captureElementImage(Element element)
- DOMMatrix getElementTransform((Element or ElementImage) element, DOMMatrix draw_transform)

All of the canvas-side members are [RuntimeEnabled=CanvasDrawElement].

## Flags

- The only runtime feature in current Chromium is CanvasDrawElement
  (origin_trial_feature_name: "HTMLInCanvas", status: "experimental").
  https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/runtime_enabled_features.json5
- There is **no** CanvasDrawElementInSubtree entry in that file. The second
  flag in our launch command
  (--enable-blink-features=CanvasDrawElement,CanvasDrawElementInSubtree) is
  stale. CanvasDrawElement alone is the current gate.
- The chrome://flags entry is #canvas-draw-element; the origin trial is
  html-in-canvas / HTMLInCanvas
  (https://chromestatus.com/feature/5172548013916160).

## Comparison with apps/web/src/components/board3d/

| Concern                                  | Our code                                 | Intended pattern                                 | Delta                        |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------ | ---------------------------- |
| Card DOM is a direct child of the canvas | Yes (elementCapture.ts)                  | Required                                         | None                         |
| layoutsubtree on the canvas              | Yes, constructor                         | Required                                         | None                         |
| layoutsubtree on each card               | Yes (setCards)                           | Not required for direct children                 | Remove                       |
| Offscreen card positioning               | layoutTiles() grid below fold            | Children are inherently not composited           | Remove                       |
| Update driver                            | rAF loop + dirty set + framesSinceChange | onpaint + changedElements + requestPaint()       | Replace                      |
| Texture upload                           | 6-arg texElementImage2D                  | 3-arg (target, internalformat, element, config?) | Update local TS types + call |
| Rasterization                            | Implicitly browser-owned                 | Browser-owned                                    | None                         |
| Picking                                  | CPU raycast + hover routing              | Optional native matrix3d sync                    | Optional simplification      |

## Exact takeaways to simplify the implementation

1. Delete layoutTiles() and the left/top "below the fold" logic in
   elementCapture.ts. Append cards as plain children; the API keeps them off
   screen until drawn.
2. Remove the per-card layoutsubtree attribute; keep it only on the canvas.
3. Replace the rAF dirty-poll (consumeDirty, framesSinceChange, markAllDirty)
   with canvas.onpaint reading changedElements and an explicit
   canvas.requestPaint() after the DOM commits.
4. Change setCardTextureFromElement to the canonical
   texElementImage2D(target, internalformat, element) signature and update the
   local global type declaration in elementCapture.ts.
5. Drop CanvasDrawElementInSubtree from the launch flag; CanvasDrawElement
   is the only real flag.
6. (Optional) Explore the InteractionManager approach -- sync each card's
   style.transform with a matrix3d derived from the billboard MVP -- to
   delete raycast.ts and the hover routing in favor of native pointer events.
   This is a larger change and not required for the joy prototype.

## Source links

- WICG explainer: https://github.com/WICG/html-in-canvas/blob/main/README.md
- WICG WebGL example: https://github.com/WICG/html-in-canvas/blob/main/Examples/webGL.html
- WICG text-input example: https://github.com/WICG/html-in-canvas/blob/main/Examples/text-input.html
- WICG complex-text example: https://github.com/WICG/html-in-canvas/blob/main/Examples/complex-text.html
- WICG pie-chart example: https://github.com/WICG/html-in-canvas/blob/main/Examples/pie-chart.html
- WICG WebGPU jelly slider: https://github.com/WICG/html-in-canvas/tree/main/Examples/webgpu-jelly-slider
- html_canvas_element.idl: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/canvas/html_canvas_element.idl
- webgl_rendering_context_base.idl: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.idl
- webgl_copy_element_image_config.idl: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgl/webgl_copy_element_image_config.idl
- canvas_paint_event.idl: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/canvas/canvas_paint_event.idl
- webgl_rendering_context_base.cc: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc
- html_canvas_element.cc: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/canvas/html_canvas_element.cc
- runtime_enabled_features.json5: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/runtime_enabled_features.json5
- three.js PR 31233: https://github.com/mrdoob/three.js/pull/31233
- HTMLTexture.js: https://raw.githack.com/mrdoob/three.js/htmltexture/src/textures/HTMLTexture.js
- InteractionManager.js: https://raw.githack.com/mrdoob/three.js/htmltexture/examples/jsm/interaction/InteractionManager.js
- three.js HTML texture example: https://raw.githack.com/mrdoob/three.js/htmltexture/examples/webgl_materials_texture_html.html
- Chrome Platform Status: https://chromestatus.com/feature/5172548013916160
