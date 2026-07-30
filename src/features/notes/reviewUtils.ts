import type { Note, NoteMetadata } from "./types";
import { extractTodos } from "./todoUtils";
import { isDailyNote, isInboxNote } from "./insights";

export interface WeeklyReview {
  weekLabel: string;
  created: number;
  updated: number;
  words: number;
  completedTodos: number;
  openTodos: number;
  inboxCount: number;
  dailyCount: number;
  topTags: string[];
}

function startOfWeek(now: Date): Date {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date;
}

function weekLabel(now: Date): string {
  const start = startOfWeek(now);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")} 至 ${end.getMonth() + 1}/${end.getDate()}`;
}

export function calculateWeeklyReview(metadata: NoteMetadata[], notes: Note[], now = new Date()): WeeklyReview {
  const start = startOfWeek(now).getTime();
  const thisWeek = metadata.filter((note) => new Date(note.updatedAt).getTime() >= start);
  const todos = notes.flatMap(extractTodos);
  const tagCounts = new Map<string, number>();
  thisWeek.forEach((note) => note.tags.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)));
  return {
    weekLabel: weekLabel(now),
    created: metadata.filter((note) => new Date(note.createdAt).getTime() >= start).length,
    updated: thisWeek.length,
    words: thisWeek.reduce((sum, note) => sum + note.wordCount, 0),
    completedTodos: todos.filter((todo) => todo.completed).length,
    openTodos: todos.filter((todo) => !todo.completed).length,
    inboxCount: metadata.filter(isInboxNote).length,
    dailyCount: metadata.filter((note) => isDailyNote(note) && new Date(note.updatedAt).getTime() >= start).length,
    topTags: [...tagCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5).map(([tag]) => tag),
  };
}

export function buildWeeklyReviewMarkdown(review: WeeklyReview): string {
  const tags = review.topTags.length ? review.topTags.map((tag) => `#${tag}`).join("、") : "（这一周还没有留下明显的主题）";
  return `# 本周回顾｜${review.weekLabel}\n\n## 这周留下\n- 新建笔记：${review.created} 篇\n- 更新笔记：${review.updated} 篇\n- 写下文字：${review.words} 字\n- 每日便笺：${review.dailyCount} 天\n\n## 待办与整理\n- 当前未完成待办：${review.openTodos} 项\n- 累计已完成待办：${review.completedTodos} 项\n- 收件箱待整理：${review.inboxCount} 条\n\n## 本周常见主题\n${tags}\n\n## 下周想推进\n- [ ] \n- [ ] \n\n## 想留给自己的话\n\n`;
}
