import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveMarkdownImageSrc } from "./imageSrc";

describe("resolveMarkdownImageSrc", () => {
  const convertFileSrc = vi.fn((path: string) => `asset://${path}`);

  beforeEach(() => {
    convertFileSrc.mockClear();
  });

  test("resolves note image paths under the images directory", () => {
    expect(resolveMarkdownImageSrc("images/photo.png", "/notes/note-1", convertFileSrc)).toBe(
      "asset:///notes/note-1/images/photo.png",
    );
    expect(convertFileSrc).toHaveBeenCalledWith("/notes/note-1/images/photo.png");
  });

  test("normalizes Windows-style separators before resolving note images", () => {
    expect(resolveMarkdownImageSrc("images\\photo.png", "C:/notes/note-1", convertFileSrc)).toBe(
      "asset://C:/notes/note-1/images/photo.png",
    );
    expect(convertFileSrc).toHaveBeenCalledWith("C:/notes/note-1/images/photo.png");
  });

  test("resolves relative images next to an explicitly opened Markdown file", () => {
    expect(
      resolveMarkdownImageSrc(
        "./assets/diagram%20one.png",
        "/notes/note-1",
        convertFileSrc,
        "C:\\Users\\Alice\\Documents\\project",
      ),
    ).toBe("asset://C:/Users/Alice/Documents/project/assets/diagram one.png");
    expect(convertFileSrc).toHaveBeenCalledWith(
      "C:/Users/Alice/Documents/project/assets/diagram one.png",
    );
  });

  test("resolves external images before internal-note image paths", () => {
    expect(
      resolveMarkdownImageSrc(
        "images/photo.png",
        "/app-managed-data",
        convertFileSrc,
        "D:/external-note",
      ),
    ).toBe("asset://D:/external-note/images/photo.png");
    expect(convertFileSrc).toHaveBeenCalledWith("D:/external-note/images/photo.png");
  });

  test("keeps non-note image paths unchanged and rejects paths escaping an external note folder", () => {
    expect(
      resolveMarkdownImageSrc("https://example.com/photo.png", "/notes/note-1", convertFileSrc),
    ).toBe("https://example.com/photo.png");
    expect(resolveMarkdownImageSrc("./photo.png", "/notes/note-1", convertFileSrc)).toBe(
      "./photo.png",
    );
    expect(
      resolveMarkdownImageSrc("../private.png", undefined, convertFileSrc, "C:/notes/project"),
    ).toBe("../private.png");
    expect(convertFileSrc).not.toHaveBeenCalled();
  });

  test("keeps image paths unchanged when the base directory is unavailable", () => {
    expect(resolveMarkdownImageSrc("images/photo.png", undefined, convertFileSrc)).toBe(
      "images/photo.png",
    );
    expect(convertFileSrc).not.toHaveBeenCalled();
  });

  test("returns an empty string for missing sources", () => {
    expect(resolveMarkdownImageSrc(undefined, "/notes/note-1", convertFileSrc)).toBe("");
  });
});
