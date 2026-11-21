import { describe, expect, test, vi } from "vitest";
import { processImageFile } from "./useImagePaste";

describe("useImagePaste processImageFile", () => {
  test("passes compressWebp and compressQuality options and saves returned format", async () => {
    const file = new File([new Uint8Array(40 * 1024)], "photo.png", { type: "image/png" });
    const compressedData = new Uint8Array(10 * 1024);
    const compress = vi.fn(async () => ({
      data: compressedData,
      extension: "webp",
      mimeType: "image/webp",
      compressed: true,
    }));
    const save = vi.fn(async () => "images/note-1/abc.webp");

    const relPath = await processImageFile(file, "note-1", undefined, true, 0.78, {
      compress,
      save,
    });

    expect(compress).toHaveBeenCalledWith(file, "png", { enabled: true, quality: 0.78 });
    expect(save).toHaveBeenCalledWith("note-1", compressedData, "webp");
    expect(relPath).toBe("images/note-1/abc.webp");
  });

  test("preserves original extension when compression is disabled", async () => {
    const file = new File([new Uint8Array(40 * 1024)], "photo.jpg", { type: "image/jpeg" });
    const save = vi.fn(async () => "images/note-1/orig.jpg");

    const relPath = await processImageFile(file, "note-1", undefined, false, 0.85, { save });

    expect(save).toHaveBeenCalledWith("note-1", expect.any(Uint8Array), "jpg");
    expect(relPath).toBe("images/note-1/orig.jpg");
  });
});
