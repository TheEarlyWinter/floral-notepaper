import type { Note, NoteMetadata } from "./types";
import { extractTodos } from "./todoUtils";

export const INBOX_CATEGORY = "收件箱";
export const DAILY_TAG = "daily";

export interface SearchHit {
  noteId: string;
  title: string;
  category: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
}

export interface DuplicateSuggestion {
  noteId: string;
  title: string;
  score: number;
}

export interface DuplicatePair {
  first: DuplicateSuggestion;
  second: DuplicateSuggestion;
}

export interface DashboardStats {
  inboxCount: number;
  createdToday: number;
  updatedToday: number;
  totalWords: number;
  openTodos: number;
  completedTodos: number;
  dailyStreak: number;
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function startOfLocalDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function dateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate(),
  ).padStart(2, "0")}`;
}

export function isInboxNote(note: Pick<NoteMetadata, "category">): boolean {
  return note.category.trim() === INBOX_CATEGORY;
}

export function isDailyNote(note: Pick<NoteMetadata, "tags" | "category">): boolean {
  return note.tags.some((tag) => tag.trim().toLowerCase() === DAILY_TAG) || note.category === "每日便笺";
}

export function buildSearchHits(notes: Note[], query: string): SearchHit[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  return notes.flatMap((note) => {
    const title = note.title.trim() || "无标题笔记";
    const haystack = `${note.title}\n${note.content}`;
    const index = haystack.toLocaleLowerCase().indexOf(normalizedQuery);
    if (index < 0) return [];

    const contentIndex = note.content.toLocaleLowerCase().indexOf(normalizedQuery);
    const source = contentIndex >= 0 ? note.content : note.title;
    const matchStart = contentIndex >= 0 ? contentIndex : 0;
    const beforeStart = Math.max(0, matchStart - 34);
    const afterEnd = Math.min(source.length, matchStart + normalizedQuery.length + 58);
    const prefix = beforeStart > 0 ? "…" : "";
    const suffix = afterEnd < source.length ? "…" : "";

    return [
      {
        noteId: note.id,
        title,
        category: note.category,
        snippet: `${prefix}${source.slice(beforeStart, afterEnd).replace(/\s+/g, " ")}${suffix}`,
        matchStart: contentIndex >= 0 ? contentIndex : -1,
        matchLength: normalizedQuery.length,
      },
    ];
  });
}

function tokens(value: string): Set<string> {
  const normalized = normalizeText(value);
  const parts = normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return new Set(parts);
}

export function findDuplicateSuggestions(
  current: Note,
  candidates: Note[],
  limit = 3,
): DuplicateSuggestion[] {
  const currentTokens = tokens(`${current.title} ${current.content.slice(0, 1200)}`);
  if (currentTokens.size === 0) return [];

  return candidates
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate) => {
      const candidateTokens = tokens(`${candidate.title} ${candidate.content.slice(0, 1200)}`);
      const shared = [...currentTokens].filter((token) => candidateTokens.has(token)).length;
      const total = new Set([...currentTokens, ...candidateTokens]).size;
      const titleMatch = normalizeText(candidate.title) === normalizeText(current.title) && current.title.trim();
      const score = total === 0 ? 0 : shared / total + (titleMatch ? 0.45 : 0);
      return {
        noteId: candidate.id,
        title: candidate.title.trim() || "无标题笔记",
        score,
      };
    })
    .filter((item) => item.score >= 0.28)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function findDuplicatePairs(notes: Note[], limit = 8): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  const seen = new Set<string>();

  for (const note of notes) {
    for (const suggestion of findDuplicateSuggestions(note, notes, 3)) {
      const pairKey = [note.id, suggestion.noteId].sort().join(":");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      pairs.push({
        first: { noteId: note.id, title: note.title.trim() || "无标题笔记", score: suggestion.score },
        second: suggestion,
      });
    }
  }

  return pairs.sort((left, right) => right.second.score - left.second.score).slice(0, limit);
}

export function calculateDailyStreak(notes: NoteMetadata[], now = new Date()): number {
  const dailyKeys = new Set(
    notes
      .filter(isDailyNote)
      .map((note) => dateKey(new Date(note.createdAt))),
  );
  let cursor = startOfLocalDay(now);
  let streak = 0;
  while (dailyKeys.has(dateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function calculateDashboardStats(
  metadata: NoteMetadata[],
  loadedNotes: Note[],
  now = new Date(),
): DashboardStats {
  const today = startOfLocalDay(now).getTime();
  const todos = loadedNotes.flatMap(extractTodos);
  return {
    inboxCount: metadata.filter(isInboxNote).length,
    createdToday: metadata.filter((note) => new Date(note.createdAt).getTime() >= today).length,
    updatedToday: metadata.filter((note) => new Date(note.updatedAt).getTime() >= today).length,
    totalWords: metadata.reduce((sum, note) => sum + note.wordCount, 0),
    openTodos: todos.filter((todo) => !todo.completed).length,
    completedTodos: todos.filter((todo) => todo.completed).length,
    dailyStreak: calculateDailyStreak(metadata, now),
  };
}
