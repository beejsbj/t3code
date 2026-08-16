/**
 * WebGL2 billboard renderer for the Board Palace 3D prototype.
 *
 * This module owns the GL shell: program, buffers, per-card textures, and the
 * per-frame draw loop. Cards are view-facing billboards expanded in the vertex
 * shader from the camera's right/up basis vectors, so there is no per-card
 * geometry — one 6-vertex quad is re-drawn once per card.
 *
 * It talks to WebGL directly, so every raw GL call is tucked behind a small
 * named helper and the state the scene cares about (cards, textures, camera)
 * stays readable at the top. The pure math (`perspectiveMatrix`) is exported
 * separately and unit-tested; the GL path itself is exercised in the browser.
 */

import { uploadElementToBoundTexture } from "./elementCapture.ts";

export interface Board3DRenderer {
  /** (Re)set the card set. Cards keep their texture across updates by id. */
  setCards(cards: readonly RenderCardInput[]): void;
  /**
   * Snapshot a layoutsubtree DOM element straight into the card texture via
   * html-in-canvas (texElementImage2D). No-op when the id is unknown or the
   * browser lacks the API; callers gate on elementTexturesSupported.
   */
  setCardTextureFromElement(id: string, element: HTMLElement): boolean;
  /** True when this context can snapshot DOM elements into textures. */
  readonly elementTexturesSupported: boolean;
  /** Draw every card back-to-front with alpha blending and depth test on. */
  render(view: Float32Array, proj: Float32Array): void;
  /** Resize the backing store to `width`×`height` physical pixels. */
  resize(width: number, height: number, devicePixelRatio: number): void;
  /** Free all GL resources owned by this renderer. */
  dispose(): void;
}

export interface RenderCardInput {
  id: string;
  position: [number, number, number];
}

/** World-space card size in meters: 1.4m wide × 0.9m tall. */
const CARD_WIDTH_METERS = 1.4;
const CARD_HEIGHT_METERS = 0.9;
/** Uniform size multiplier (baked into the half-size uniform each frame). */
const CARD_SCALE = 1;

/** Placeholder checkerboard resolution (power of two, tiny). */
const PLACEHOLDER_SIZE = 64;

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform mat4 uProj;
uniform mat4 uView;
uniform vec3 uRight;   // camera right basis, world space
uniform vec3 uUp;      // camera up basis, world space
uniform vec3 uPosition; // billboard center, world space
uniform vec2 uHalfSize; // half width / half height in meters
uniform float uScale;   // uniform size multiplier

in vec4 aData;          // xy = corner in [-1,1], zw = uv in [0,1]
out vec2 vUV;

void main() {
  vec3 offset = aData.x * uRight * uHalfSize.x * uScale
              + aData.y * uUp    * uHalfSize.y * uScale;
  gl_Position = uProj * uView * vec4(uPosition + offset, 1.0);
  vUV = aData.zw;
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision mediump float;

uniform sampler2D uTexture;
in vec2 vUV;
out vec4 outColor;

void main() {
  outColor = texture(uTexture, vUV);
}
`;

/** One card the renderer draws: world position + its current GL texture. */
interface RenderCard {
  id: string;
  position: Float32Array; // 3 elements
  texture: WebGLTexture;
}

// ---------------------------------------------------------------------------
// GL helpers — keep the raw WebGL calls in one place so the rest of this file
// reads as intent, not as buffer bookkeeping.
// ---------------------------------------------------------------------------

function getContext(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  return canvas.getContext("webgl2");
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown error";
    console.error(`[board3d] shader compile failed: ${log}`);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown error";
    console.error(`[board3d] program link failed: ${log}`);
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** Build the single shared billboard quad (two triangles, corner+uv packed). */
function createQuad(gl: WebGL2RenderingContext): WebGLBuffer | null {
  const vertices = new Float32Array([
    // corner (xy)         uv (zw)
    -1, -1, 0, 0, 1, -1, 1, 0, 1, 1, 1, 1, -1, -1, 0, 0, 1, 1, 1, 1, -1, 1, 0, 1,
  ]);
  const buffer = gl.createBuffer();
  if (!buffer) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  return buffer;
}

/** Convert an HSL colour to an 8-bit RGB tuple. `h` in [0, 1]. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Procedural 64×64 checkerboard tinted by the card index. Each card gets its
 * own placeholder so the scene reads as distinct cards before real DOM
 * snapshots land. Tinted hues differ per index to make the space legible.
 */
function createPlaceholderTexture(gl: WebGL2RenderingContext, index: number): WebGLTexture | null {
  const data = new Uint8Array(PLACEHOLDER_SIZE * PLACEHOLDER_SIZE * 4);
  const hue = (index * 47) / 360;
  const [darkR, darkG, darkB] = hslToRgb(hue, 0.6, 0.45);
  const [lightR, lightG, lightB] = hslToRgb(hue, 0.6, 0.72);
  for (let y = 0; y < PLACEHOLDER_SIZE; y += 1) {
    for (let x = 0; x < PLACEHOLDER_SIZE; x += 1) {
      const on = (((x >> 3) + (y >> 3)) & 1) === 0;
      const r = on ? lightR : darkR;
      const g = on ? lightG : darkG;
      const b = on ? lightB : darkB;
      const offset = (y * PLACEHOLDER_SIZE + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    PLACEHOLDER_SIZE,
    PLACEHOLDER_SIZE,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data,
  );
  configureTextureSampling(gl);
  return texture;
}

/**
 * Texture sampling state. Deliberately NPOT-safe: LINEAR min/mag, no mipmaps,
 * CLAMP_TO_EDGE — valid for both the POT placeholder and arbitrary-size DOM
 * snapshots without special-casing.
 */
function configureTextureSampling(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** Sort card indices farthest-first for correct alpha blending. */
function sortBackToFront(order: Int32Array, depth: Float32Array, count: number): void {
  for (let i = 0; i < count; i += 1) order[i] = i;
  // Insertion sort: allocation-free, and at ~100 cards the worst case is
  // ~5k comparisons — noise against a draw call per card.
  for (let i = 1; i < count; i += 1) {
    const key = order[i]!;
    const keyDepth = depth[key]!;
    let j = i - 1;
    while (j >= 0 && depth[order[j]!]! < keyDepth) {
      order[j + 1] = order[j]!;
      j -= 1;
    }
    order[j + 1] = key;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a board renderer for `canvas`, or `null` when WebGL2 is unavailable.
 */
export function createRenderer(canvas: HTMLCanvasElement): Board3DRenderer | null {
  const gl = getContext(canvas);
  if (!gl) return null;

  const program = linkProgram(gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);
  if (!program) return null;

  const quad = createQuad(gl);
  if (!quad) return null;

  const vao = gl.createVertexArray();
  if (!vao) return null;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  const aData = gl.getAttribLocation(program, "aData");
  gl.enableVertexAttribArray(aData);
  gl.vertexAttribPointer(aData, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const uProj = gl.getUniformLocation(program, "uProj");
  const uView = gl.getUniformLocation(program, "uView");
  const uRight = gl.getUniformLocation(program, "uRight");
  const uUp = gl.getUniformLocation(program, "uUp");
  const uPosition = gl.getUniformLocation(program, "uPosition");
  const uHalfSize = gl.getUniformLocation(program, "uHalfSize");
  const uScale = gl.getUniformLocation(program, "uScale");
  const uTexture = gl.getUniformLocation(program, "uTexture");

  gl.useProgram(program);
  gl.uniform1i(uTexture, 0);
  gl.useProgram(null);

  // GL state that never changes frame-to-frame.
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return new WebGLBillboardRenderer(gl, {
    program,
    quad,
    vao,
    uProj,
    uView,
    uRight,
    uUp,
    uPosition,
    uHalfSize,
    uScale,
  });
}

interface ProgramHandles {
  program: WebGLProgram;
  quad: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uProj: WebGLUniformLocation | null;
  uView: WebGLUniformLocation | null;
  uRight: WebGLUniformLocation | null;
  uUp: WebGLUniformLocation | null;
  uPosition: WebGLUniformLocation | null;
  uHalfSize: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
}

class WebGLBillboardRenderer implements Board3DRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly handles: ProgramHandles;
  private readonly cardsById = new Map<string, RenderCard>();
  private cards: RenderCard[] = [];

  // Preallocated per-frame scratch — render() must not allocate.
  private readonly vec3 = new Float32Array(3);
  private depth: Float32Array = new Float32Array(0);
  private order: Int32Array = new Int32Array(0);

  constructor(gl: WebGL2RenderingContext, handles: ProgramHandles) {
    this.gl = gl;
    this.handles = handles;
  }

  setCards(cards: readonly RenderCardInput[]): void {
    const gl = this.gl;
    const next: RenderCard[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < cards.length; i += 1) {
      const input = cards[i]!;
      seen.add(input.id);
      let card = this.cardsById.get(input.id);
      if (card) {
        card.position[0] = input.position[0];
        card.position[1] = input.position[1];
        card.position[2] = input.position[2];
      } else {
        // Fresh card: create a placeholder tinted by its index.
        const texture = createPlaceholderTexture(gl, i);
        if (!texture) continue;
        card = {
          id: input.id,
          position: Float32Array.from(input.position),
          texture,
        };
      }
      next.push(card);
    }

    // Drop cards that disappeared from the new set and free their textures.
    for (const [id, card] of this.cardsById) {
      if (!seen.has(id)) {
        gl.deleteTexture(card.texture);
        this.cardsById.delete(id);
      }
    }

    this.cards = next;
    this.cardsById.clear();
    for (const card of next) this.cardsById.set(card.id, card);

    // Resize scratch when the card count grows.
    const count = next.length;
    if (this.depth.length < count) this.depth = new Float32Array(count);
    if (this.order.length < count) this.order = new Int32Array(count);
  }

  readonly elementTexturesSupported: boolean =
    typeof (
      WebGL2RenderingContext.prototype as unknown as {
        texElementImage2D?: unknown;
      }
    ).texElementImage2D === "function";

  setCardTextureFromElement(id: string, element: HTMLElement): boolean {
    const card = this.cardsById.get(id);
    if (!card) return false;
    const gl = this.gl;
    if (typeof gl.texElementImage2D !== "function") return false;
    gl.bindTexture(gl.TEXTURE_2D, card.texture);
    if (!uploadElementToBoundTexture(gl, element)) return false;
    configureTextureSampling(gl);
    return true;
  }
  render(view: Float32Array, proj: Float32Array): void {
    const gl = this.gl;
    const { handles } = this;
    const count = this.cards.length;
    if (count === 0) return;

    gl.useProgram(handles.program);
    gl.uniformMatrix4fv(handles.uProj, false, proj);
    gl.uniformMatrix4fv(handles.uView, false, view);

    // The view matrix carries the camera basis directly: column 0 is right,
    // column 1 is up (world space). Feed those to the billboard shader.
    const vec3 = this.vec3;
    vec3[0] = view[0]!;
    vec3[1] = view[1]!;
    vec3[2] = view[2]!;
    gl.uniform3fv(handles.uRight, vec3);
    vec3[0] = view[4]!;
    vec3[1] = view[5]!;
    vec3[2] = view[6]!;
    gl.uniform3fv(handles.uUp, vec3);

    gl.uniform2f(handles.uHalfSize, CARD_WIDTH_METERS / 2, CARD_HEIGHT_METERS / 2);
    gl.uniform1f(handles.uScale, CARD_SCALE);

    // Back-to-front sort by view-space depth. camera_z = forward·p + tz where
    // forward = view column 2 and tz = view[14]; larger camera_z = farther.
    const depth = this.depth;
    const fwdX = view[8]!;
    const fwdY = view[9]!;
    const fwdZ = view[10]!;
    const tz = view[14]!;
    for (let i = 0; i < count; i += 1) {
      const p = this.cards[i]!.position;
      depth[i] = fwdX * p[0]! + fwdY * p[1]! + fwdZ * p[2]! + tz;
    }
    sortBackToFront(this.order, depth, count);

    gl.bindVertexArray(handles.vao);
    for (let k = 0; k < count; k += 1) {
      const card = this.cards[this.order[k]!]!;
      gl.bindTexture(gl.TEXTURE_2D, card.texture);
      const p = card.position;
      vec3[0] = p[0]!;
      vec3[1] = p[1]!;
      vec3[2] = p[2]!;
      gl.uniform3fv(handles.uPosition, vec3);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindVertexArray(null);
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const w = Math.max(1, Math.round(width * devicePixelRatio));
    const h = Math.max(1, Math.round(height * devicePixelRatio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.gl.viewport(0, 0, canvas.width, canvas.height);
  }

  dispose(): void {
    const gl = this.gl;
    for (const card of this.cards) gl.deleteTexture(card.texture);
    this.cards = [];
    this.cardsById.clear();
    gl.deleteBuffer(this.handles.quad);
    gl.deleteVertexArray(this.handles.vao);
    gl.deleteProgram(this.handles.program);
  }
}

/**
 * Build a column-major perspective projection matrix (right-handed, OpenGL
 * depth range [-1, 1]). Near-plane camera-space z maps to NDC -1 and far-plane
 * z maps to NDC +1; x/y scaling follows fovY and the aspect ratio.
 */
export function perspectiveMatrix(
  fovYDeg: number,
  aspect: number,
  near: number,
  far: number,
): Float32Array {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 180 / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}
