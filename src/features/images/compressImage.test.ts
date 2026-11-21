import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MIN_COMPRESS_IMAGE_BYTES,
  clampImageCompressQuality,
  compressImageForUpload,
  encodeImageFileToWebpCanvas,
  shouldSkipWebpCompression,
} from "./compressImage";

function makeFakeFile(size: number, type: string, name = "image.png"): File {
  const bytes = new Uint8Array(size);
  bytes.fill(65);
  return new File([bytes], name, { type });
}

describe("compressImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("clamps compression quality into [0.60, 0.95] with 0.85 default", () => {
    expect(clampImageCompressQuality()).toBe(0.85);
    expect(clampImageCompressQuality(Number.NaN)).toBe(0.85);
    expect(clampImageCompressQuality(0.2)).toBe(0.6);
    expect(clampImageCompressQuality(1.4)).toBe(0.95);
    expect(clampImageCompressQuality(0.75)).toBe(0.75);
  });

  test("skips gif, svg, webp, and files smaller than 30 KiB", async () => {
    const encoder = vi.fn();

    for (const mime of ["image/gif", "image/svg+xml", "image/webp"]) {
      const file = makeFakeFile(MIN_COMPRESS_IMAGE_BYTES + 1024, mime);
      expect(shouldSkipWebpCompression(file)).toBe(true);
      const result = await compressImageForUpload(file, mime.split("/")[1], {
        encodeToWebp: encoder,
      });
      expect(result.compressed).toBe(false);
    }

    const smallPng = makeFakeFile(MIN_COMPRESS_IMAGE_BYTES - 1, "image/png");
    expect(shouldSkipWebpCompression(smallPng)).toBe(true);
    const smallResult = await compressImageForUpload(smallPng, "png", {
      encodeToWebp: encoder,
    });
    expect(smallResult.compressed).toBe(false);
    expect(smallResult.extension).toBe("png");
    expect(encoder).not.toHaveBeenCalled();
  });

  test("skips compression when disabled in config", async () => {
    const encoder = vi.fn();
    const png = makeFakeFile(MIN_COMPRESS_IMAGE_BYTES + 5000, "image/png");
    const result = await compressImageForUpload(png, "png", {
      enabled: false,
      encodeToWebp: encoder,
    });
    expect(result.compressed).toBe(false);
    expect(result.extension).toBe("png");
    expect(encoder).not.toHaveBeenCalled();
  });

  test("replaces original only when WebP output succeeds and is strictly smaller", async () => {
    const png = makeFakeFile(40 * 1024, "image/png");
    const smallerWebp = new Blob([new Uint8Array(12 * 1024)], { type: "image/webp" });

    const compressed = await compressImageForUpload(png, "png", {
      quality: 0.8,
      encodeToWebp: vi.fn(async () => smallerWebp),
    });
    expect(compressed.compressed).toBe(true);
    expect(compressed.extension).toBe("webp");
    expect(compressed.mimeType).toBe("image/webp");
    expect(compressed.data.byteLength).toBe(12 * 1024);

    // Equal size -> keep original
    const equalWebp = new Blob([new Uint8Array(40 * 1024)], { type: "image/webp" });
    const equalResult = await compressImageForUpload(png, "png", {
      encodeToWebp: vi.fn(async () => equalWebp),
    });
    expect(equalResult.compressed).toBe(false);
    expect(equalResult.extension).toBe("png");
    expect(equalResult.data.byteLength).toBe(40 * 1024);

    // Larger WebP -> keep original
    const largerWebp = new Blob([new Uint8Array(45 * 1024)], { type: "image/webp" });
    const largerResult = await compressImageForUpload(png, "png", {
      encodeToWebp: vi.fn(async () => largerWebp),
    });
    expect(largerResult.compressed).toBe(false);
    expect(largerResult.extension).toBe("png");
  });

  test("falls back gracefully in headless/non-canvas environments or when encoder throws", async () => {
    const png = makeFakeFile(40 * 1024, "image/png");
    await expect(encodeImageFileToWebpCanvas(png, 0.85)).resolves.toBeNull();

    const fallback = await compressImageForUpload(png, "png");
    expect(fallback.compressed).toBe(false);
    expect(fallback.extension).toBe("png");
    expect(fallback.data.byteLength).toBe(40 * 1024);

    const throwing = await compressImageForUpload(png, "png", {
      encodeToWebp: vi.fn(async () => {
        throw new Error("canvas failed");
      }),
    });
    expect(throwing.compressed).toBe(false);
    expect(throwing.extension).toBe("png");
  });

  test("encodes using document canvas and createImageBitmap when available", async () => {
    const png = makeFakeFile(40 * 1024, "image/png");
    const drawImage = vi.fn();
    const closeBitmap = vi.fn();
    const fakeBlob = new Blob([new Uint8Array(8 * 1024)], { type: "image/webp" });
    const toBlob = vi.fn((cb: (blob: Blob | null) => void) => cb(fakeBlob));

    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 800,
        height: 600,
        close: closeBitmap,
      })),
    );
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: vi.fn(() => ({ drawImage })),
        toBlob,
      })),
    });

    const result = await compressImageForUpload(png, "png", { quality: 0.72 });
    expect(drawImage).toHaveBeenCalledOnce();
    expect(closeBitmap).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.72);
    expect(result.compressed).toBe(true);
    expect(result.extension).toBe("webp");
    expect(result.data.byteLength).toBe(8 * 1024);
  });
});
