import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveExternalRelativeImagePath, resolveMarkdownImageSrc } from "./imageSrc";

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
      resolveExternalRelativeImagePath(
        "C:\\Users\\Alice\\Documents\\project",
        "./assets/diagram%20one.png",
      ),
    ).toBe("C:/Users/Alice/Documents/project/assets/diagram one.png");
  });

  test("resolves external images before internal-note image paths", () => {
    expect(resolveExternalRelativeImagePath("D:/external-note", "images/photo.png")).toBe(
      "D:/external-note/images/photo.png",
    );
    expect(convertFileSrc).not.toHaveBeenCalled();
  });

  test("blocks remote images and rejects paths escaping an external note folder", () => {
    expect(
      resolveMarkdownImageSrc("https://example.com/photo.png", "/notes/note-1", convertFileSrc),
    ).toBe("");
    expect(
      resolveMarkdownImageSrc("//example.com/photo.png", "/notes/note-1", convertFileSrc),
    ).toBe("");
    expect(resolveMarkdownImageSrc("./photo.png", "/notes/note-1", convertFileSrc)).toBe(
      "./photo.png",
    );
    expect(
      resolveExternalRelativeImagePath("C:/notes/project", "../private.png"),
    ).toBeNull();
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
