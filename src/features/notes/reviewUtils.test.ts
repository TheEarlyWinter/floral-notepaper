import { describe, expect, it } from "vitest";
import { buildWeeklyReviewMarkdown, calculateWeeklyReview } from "./reviewUtils";
import type { Note, NoteMetadata } from "./types";

const now = new Date("2026-07-29T12:00:00");
const metadata: NoteMetadata[] = [
  { id: "a", title: "本周", fileName: "a.md", category: "收件箱", createdAt: "2026-07-28T12:00:00Z", updatedAt: "2026-07-29T10:00:00Z", wordCount: 120, preview: "", tags: ["学习"], pinned: false },
  { id: "b", title: "旧笔记", fileName: "b.md", category: "", createdAt: "2026-07-01T12:00:00Z", updatedAt: "2026-07-01T12:00:00Z", wordCount: 80, preview: "", tags: ["旧"], pinned: false },
];
const notes: Note[] = [
  { ...metadata[0], content: "- [ ] 未完成\n- [x] 完成" },
  { ...metadata[1], content: "" },
];

describe("weekly review", () => {
  it("summarizes this week without counting old notes", () => {
    const review = calculateWeeklyReview(metadata, notes, now);
    expect(review.created).toBe(1);
    expect(review.updated).toBe(1);
    expect(review.inboxCount).toBe(1);
    expect(review.topTags).toEqual(["学习"]);
  });

  it("creates an editable weekly review markdown", () => {
    const markdown = buildWeeklyReviewMarkdown(calculateWeeklyReview(metadata, notes, now));
    expect(markdown).toContain("本周回顾");
    expect(markdown).toContain("下周想推进");
  });
});
