import { describe, expect, it } from "vitest";
import type { Note, NoteMetadata } from "./types";
import {
  extractTodos,
  filterNotesWithSearchSyntax,
  parseNoteSearchQuery,
  toggleTodoInContent,
} from "./todoUtils";

const note: Note = {
  id: "note-1",
  title: "计划",
  fileName: "note-1.md",
  category: "学习",
  createdAt: "2026-07-29T00:00:00Z",
  updatedAt: "2026-07-29T00:00:00Z",
  wordCount: 10,
  content: "# 今天\n- [ ] 复习机械设计\n  - [x] 整理公式\n1. [ ] 写错题总结",
  tags: ["考研"],
  pinned: true,
};

const metadata: NoteMetadata[] = [
  {
    ...note,
    preview: "复习机械设计",
  },
  {
    ...note,
    id: "note-2",
    title: "生活",
    fileName: "note-2.md",
    category: "日常",
    preview: "采购清单",
    tags: ["生活"],
    pinned: false,
  },
];

describe("todo utilities", () => {
  it("extracts checked and unchecked Markdown tasks with 1-based line numbers", () => {
    expect(extractTodos(note)).toEqual([
      expect.objectContaining({ text: "复习机械设计", line: 2, completed: false }),
      expect.objectContaining({ text: "整理公式", line: 3, completed: true }),
      expect.objectContaining({ text: "写错题总结", line: 4, completed: false }),
    ]);
  });

  it("toggles only the requested task line", () => {
    expect(toggleTodoInContent(note.content, 2, true)).toContain("- [x] 复习机械设计");
    expect(toggleTodoInContent(note.content, 3, false)).toContain("  - [ ] 整理公式");
    expect(toggleTodoInContent(note.content, 99, true)).toBe(note.content);
  });

  it("parses structured search filters without losing normal keywords", () => {
    expect(parseNoteSearchQuery("tag:考研 in:学习 pinned 齿轮")).toEqual({
      tag: "考研",
      category: "学习",
      pinned: true,
      text: "齿轮",
    });
  });

  it("filters notes by tag, category, pin state, and text", () => {
    const displayTitle = (entry: NoteMetadata) => entry.title;
    expect(filterNotesWithSearchSyntax(metadata, "tag:考研 in:学习 pinned", displayTitle)).toEqual([
      metadata[0],
    ]);
    expect(filterNotesWithSearchSyntax(metadata, "unpinned 采购", displayTitle)).toEqual([
      metadata[1],
    ]);
  });
});
