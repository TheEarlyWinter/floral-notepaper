export const MIN_COMPRESS_IMAGE_BYTES = 30 * 1024;
export const DEFAULT_IMAGE_COMPRESS_QUALITY = 0.85;
export const MIN_IMAGE_COMPRESS_QUALITY = 0.6;
export const MAX_IMAGE_COMPRESS_QUALITY = 0.95;

const SKIPPED_MIME_TYPES = new Set(["image/gif", "image/svg+xml", "image/webp"]);

export interface CompressedImageResult {
  data: Uint8Array;
  extension: string;
  mimeType: string;
  compressed: boolean;
}

export interface CompressImageOptions {
  enabled?: boolean;
  quality?: number;
  encodeToWebp?: (file: File, quality: number) => Promise<Blob | null>;
}

export function clampImageCompressQuality(quality?: number): number {
  if (typeof quality !== "number" || !Number.isFinite(quality)) {
    return DEFAULT_IMAGE_COMPRESS_QUALITY;
  }
  return Math.min(MAX_IMAGE_COMPRESS_QUALITY, Math.max(MIN_IMAGE_COMPRESS_QUALITY, quality));
}

export function shouldSkipWebpCompression(file: Pick<File, "type" | "size">): boolean {
  if (SKIPPED_MIME_TYPES.has(file.type)) {
    return true;
  }
  return file.size < MIN_COMPRESS_IMAGE_BYTES;
}

async function decodeImageSource(file: File): Promise<{
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
  cleanup: () => void;
} | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          width: bitmap.width,
          height: bitmap.height,
          draw: (ctx) => ctx.drawImage(bitmap, 0, 0),
          cleanup: () => {
            if (typeof bitmap.close === "function") {
              bitmap.close();
            }
          },
        };
      }
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
    } catch {
      // Fall back to HTMLImageElement decoding below.
    }
  }

  if (
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = objectUrl;
    });
    if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      draw: (ctx) => ctx.drawImage(img, 0, 0),
      cleanup: () => {
        URL.revokeObjectURL(objectUrl);
      },
    };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
}

export async function encodeImageFileToWebpCanvas(
  file: File,
  quality: number,
): Promise<Blob | null> {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }

  const canvas = document.createElement("canvas");
  if (!canvas || typeof canvas.getContext !== "function" || typeof canvas.toBlob !== "function") {
    return null;
  }

  const decoded = await decodeImageSource(file);
  if (!decoded) {
    return null;
  }

  try {
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    decoded.draw(ctx);

    const clampedQuality = clampImageCompressQuality(quality);
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((result) => resolve(result), "image/webp", clampedQuality);
      } catch {
        resolve(null);
      }
    });

    if (!blob || (blob.type && blob.type !== "image/webp")) {
      return null;
    }
    return blob;
  } catch {
    return null;
  } finally {
    decoded.cleanup();
  }
}

/**
 * Optionally compresses raster images to WebP via WebView2 native `<canvas>`.
 * Always falls back cleanly to original bytes when disabled, unsupported,
 * smaller than 30 KiB, or when WebP is not strictly smaller.
 */
export async function compressImageForUpload(
  file: File,
  originalExtension: string,
  options: CompressImageOptions = {},
): Promise<CompressedImageResult> {
  const originalBuffer = await file.arrayBuffer();
  const originalBytes = new Uint8Array(originalBuffer);
  const fallback: CompressedImageResult = {
    data: originalBytes,
    extension: originalExtension,
    mimeType: file.type,
    compressed: false,
  };

  if (options.enabled === false) {
    return fallback;
  }

  if (
    SKIPPED_MIME_TYPES.has(file.type) ||
    file.size < MIN_COMPRESS_IMAGE_BYTES ||
    originalBytes.byteLength < MIN_COMPRESS_IMAGE_BYTES
  ) {
    return fallback;
  }

  const encoder = options.encodeToWebp ?? encodeImageFileToWebpCanvas;
  const quality = clampImageCompressQuality(options.quality);

  try {
    const webpBlob = await encoder(file, quality);
    if (!webpBlob || (webpBlob.type && webpBlob.type !== "image/webp")) {
      return fallback;
    }

    const webpBytes = new Uint8Array(await webpBlob.arrayBuffer());
    if (webpBytes.byteLength === 0 || webpBytes.byteLength >= originalBytes.byteLength) {
      return fallback;
    }

    return {
      data: webpBytes,
      extension: "webp",
      mimeType: "image/webp",
      compressed: true,
    };
  } catch {
    return fallback;
  }
}
