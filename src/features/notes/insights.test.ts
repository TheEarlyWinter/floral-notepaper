import { describe, expect, it } from "vitest";
import {
  buildSearchHits,
  calculateDashboardStats,
  calculateDailyStreak,
  findDuplicatePairs,
  findDuplicateSuggestions,
  INBOX_CATEGORY,
  isDailyNote,
  isInboxNote,
} from "./insights";
import type { Note, NoteMetadata } from "./types";

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "one",
    title: "春日计划",
    fileName: "one.md",
    category: "",
    createdAt: "2026-07-29T01:00:00Z",
    updatedAt: "2026-07-29T02:00:00Z",
    wordCount: 12,
    content: "今天整理机械设计笔记，并完成一道练习题。\n- [ ] 复习齿轮",
    tags: [],
    pinned: false,
    ...overrides,
  };
}

function metadata(source: Note): NoteMetadata {
  const { content, ...result } = source;
  return { ...result, preview: content.slice(0, 80) };
}

describe("note insights", () => {
  it("recognizes inbox and daily notes without changing ordinary notes", () => {
    expect(isInboxNote(note({ category: INBOX_CATEGORY }))).toBe(true);
    expect(isInboxNote(note({ category: "学习" }))).toBe(false);
    expect(isDailyNote(note({ tags: ["daily"] }))).toBe(true);
    expect(isDailyNote(note({ category: "每日便笺" }))).toBe(true);
    expect(isDailyNote(note({ category: "学习" }))).toBe(false);
  });

  it("builds a contextual search hit from the note body", () => {
    const hits = buildSearchHits([note()], "齿轮");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ noteId: "one", matchStart: expect.any(Number) });
    expect(hits[0].snippet).toContain("齿轮");
  });

  it("suggests only materially similar notes", () => {
    const current = note({ id: "current", title: "机械设计复习", content: "齿轮 强度 机械设计 传动" });
    const similar = note({ id: "similar", title: "机械设计复习", content: "齿轮传动与强度计算" });
    const unrelated = note({ id: "other", title: "旅行清单", content: "雨伞 水杯 车票" });
    expect(findDuplicateSuggestions(current, [similar, unrelated]).map((item) => item.noteId)).toEqual(["similar"]);
  });

  it("deduplicates pair suggestions across the full note library", () => {
    const first = note({ id: "first", title: "齿轮强度", content: "机械设计 齿轮 强度 传动" });
    const second = note({ id: "second", title: "齿轮强度", content: "齿轮传动强度计算 机械设计" });
    expect(findDuplicatePairs([first, second])).toHaveLength(1);
  });

  it("counts a continuous local daily streak and dashboard totals", () => {
    const today = new Date("2026-07-29T12:00:00");
    const yesterday = note({ id: "yesterday", createdAt: "2026-07-28T02:00:00Z", tags: ["daily"] });
    const dailyToday = note({ id: "today", createdAt: "2026-07-29T02:00:00Z", tags: ["daily"], category: "每日便笺" });
    expect(calculateDailyStreak([metadata(yesterday), metadata(dailyToday)], today)).toBe(2);
    const stats = calculateDashboardStats(
      [metadata(note({ category: INBOX_CATEGORY })), metadata(dailyToday)],
      [note({ category: INBOX_CATEGORY }), dailyToday],
      today,
    );
    expect(stats).toMatchObject({ inboxCount: 1, createdToday: 2, openTodos: 2, dailyStreak: 1 });
  });
});
