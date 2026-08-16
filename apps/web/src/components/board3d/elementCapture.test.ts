import { describe, expect, it, vi } from "vite-plus/test";

import { uploadElementToBoundTexture } from "./elementCapture.ts";

const element = {} as HTMLElement;

describe("uploadElementToBoundTexture", () => {
  it("uses the current three-argument API first", () => {
    const texElementImage2D = vi.fn();
    const pixelStorei = vi.fn();
    const gl = {
      TEXTURE_2D: 0x0de1,
      RGBA8: 0x8058,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      pixelStorei,
      texElementImage2D,
    } as unknown as WebGL2RenderingContext;

    expect(uploadElementToBoundTexture(gl, element)).toBe(true);
    expect(pixelStorei).toHaveBeenCalledWith(gl.UNPACK_FLIP_Y_WEBGL, true);
    expect(texElementImage2D).toHaveBeenCalledOnce();
    expect(texElementImage2D).toHaveBeenCalledWith(gl.TEXTURE_2D, gl.RGBA8, element);
  });

  it("falls back to the legacy six-argument API", () => {
    const texElementImage2D = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new TypeError("current overload unavailable");
      })
      .mockImplementationOnce(() => undefined);
    const gl = {
      TEXTURE_2D: 0x0de1,
      RGBA8: 0x8058,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      pixelStorei: vi.fn(),
      texElementImage2D,
    } as unknown as WebGL2RenderingContext;

    expect(uploadElementToBoundTexture(gl, element)).toBe(true);
    expect(texElementImage2D).toHaveBeenNthCalledWith(1, gl.TEXTURE_2D, gl.RGBA8, element);
    expect(texElementImage2D).toHaveBeenNthCalledWith(
      2,
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      element,
    );
  });

  it("returns false when neither overload is available", () => {
    const gl = {
      TEXTURE_2D: 0x0de1,
      RGBA8: 0x8058,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      pixelStorei: vi.fn(),
      texElementImage2D: vi.fn(() => {
        throw new TypeError("unsupported");
      }),
    } as unknown as WebGL2RenderingContext;

    expect(uploadElementToBoundTexture(gl, element)).toBe(false);
  });
});
