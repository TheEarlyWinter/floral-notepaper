import { describe, expect, it } from "vitest";
import type { Note, NoteMetadata } from "./types";
import {
  extractWikiLinks,
  findBacklinks,
  findWikiLinkAtOffset,
  resolveWikiLink,
  wikiLinkSyntax,
} from "./wikiLinks";

const metadata: NoteMetadata[] = [
  {
    id: "alpha",
    title: "春天",
    fileName: "alpha.md",
    category: "随笔",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    wordCount: 0,
    preview: "",
    tags: [],
    pinned: false,
  },
  {
    id: "beta",
    title: "夏天",
    fileName: "beta.md",
    category: "随笔",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    wordCount: 0,
    preview: "",
    tags: [],
    pinned: false,
  },
];

function note(id: string, title: string, content: string): Note {
  const { preview: _preview, ...rest } = metadata.find((item) => item.id === id) ?? metadata[0];
  return { ...rest, id, title, content };
}

describe("wiki links", () => {
  it("extracts title and stable-id link forms", () => {
    expect(extractWikiLinks("见 [[春天]]，再看 [[note:beta|夏日计划]]。")).toEqual([
      { target: "春天", label: "春天" },
      { target: "note:beta", label: "夏日计划" },
    ]);
  });

  it("only resolves a title when it is unique", () => {
    expect(resolveWikiLink("春天", metadata)).toBe("alpha");
    expect(resolveWikiLink("note:beta", metadata)).toBe("beta");
    expect(resolveWikiLink("春天", [...metadata, { ...metadata[0], id: "other" }])).toBeNull();
  });

  it("finds notes that point to a target", () => {
    const notes = [
      note("alpha", "春天", "原文"),
      note("beta", "夏天", "来自 [[春天]] 和 [[note:alpha|稳定链接]]"),
    ];
    expect(findBacklinks("alpha", notes)).toEqual([
      { noteId: "beta", noteTitle: "夏天", category: "随笔" },
    ]);
  });

  it("creates a stable syntax that survives title duplicates", () => {
    expect(wikiLinkSyntax(metadata[0])).toBe("[[note:alpha|春天]]");
  });

  it("finds a wiki link surrounding a cursor offset and ignores outside offsets", () => {
    const sample = "前缀 [[note:beta|夏日计划]] 与 [[春天]] 后缀";
    const firstStart = sample.indexOf("[[note:beta");
    const firstEnd = sample.indexOf("]]", firstStart) + 2;
    const secondStart = sample.indexOf("[[春天]]");
    const secondEnd = secondStart + "[[春天]]".length;

    expect(findWikiLinkAtOffset(sample, firstStart)).toEqual({
      target: "note:beta",
      label: "夏日计划",
    });
    expect(findWikiLinkAtOffset(sample, firstStart + 8)).toEqual({
      target: "note:beta",
      label: "夏日计划",
    });
    expect(findWikiLinkAtOffset(sample, firstEnd)).toEqual({
      target: "note:beta",
      label: "夏日计划",
    });
    expect(findWikiLinkAtOffset(sample, secondStart + 2)).toEqual({
      target: "春天",
      label: "春天",
    });
    expect(findWikiLinkAtOffset(sample, secondEnd)).toEqual({
      target: "春天",
      label: "春天",
    });
    expect(findWikiLinkAtOffset(sample, firstStart - 1)).toBeNull();
    expect(findWikiLinkAtOffset(sample, secondEnd + 1)).toBeNull();
    expect(findWikiLinkAtOffset(sample, -1)).toBeNull();
    expect(findWikiLinkAtOffset(sample, sample.length + 1)).toBeNull();
  });
});
