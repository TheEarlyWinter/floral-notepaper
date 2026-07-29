import type { Note, NoteMetadata } from "./types";

export interface TodoItem {
  noteId: string;
  noteTitle: string;
  category: string;
  line: number;
  text: string;
  completed: boolean;
}

const TODO_LINE_PATTERN = /^(\s*(?:[-*+]\s+|\d+[.)]\s+))\[([ xX])\]\s+(.*)$/;

/**
 * 从 Markdown 中提取任务列表。行号从 1 开始，方便跳回原笔记时定位。
 */
export function extractTodos(
  note: Pick<Note, "id" | "title" | "category" | "content">,
): TodoItem[] {
  return note.content.split("\n").flatMap((lineText, index) => {
    const match = TODO_LINE_PATTERN.exec(lineText);
    if (!match) return [];

    const text = match[3].trim();
    if (!text) return [];

    return [
      {
        noteId: note.id,
        noteTitle: note.title.trim() || "无标题笔记",
        category: note.category,
        line: index + 1,
        text,
        completed: match[2].toLowerCase() === "x",
      },
    ];
  });
}

export function toggleTodoInContent(content: string, line: number, completed: boolean): string {
  const lines = content.split("\n");
  const lineIndex = line - 1;
  const target = lines[lineIndex];
  if (target == null) return content;

  const match = TODO_LINE_PATTERN.exec(target);
  if (!match) return content;

  lines[lineIndex] = `${match[1]}[${completed ? "x" : " "}] ${match[3]}`;
  return lines.join("\n");
}

export interface NoteSearchQuery {
  text: string;
  tag?: string;
  category?: string;
  pinned?: boolean;
}

/**
 * 支持 `tag:标签`、`in:分类`、`pinned` / `unpinned` 与普通关键词的组合搜索。
 * 未识别的 token 仍作为普通文本搜索，避免用户输入时意外丢失结果。
 */
export function parseNoteSearchQuery(query: string): NoteSearchQuery {
  const terms: string[] = [];
  const parsed: NoteSearchQuery = { text: "" };

  for (const token of query.trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith("tag:") && token.slice(4)) {
      parsed.tag = token.slice(4).toLowerCase();
    } else if (token.startsWith("in:") && token.slice(3)) {
      parsed.category = token.slice(3).toLowerCase();
    } else if (token === "pinned" || token === "置顶") {
      parsed.pinned = true;
    } else if (token === "unpinned" || token === "未置顶") {
      parsed.pinned = false;
    } else {
      terms.push(token);
    }
  }

  parsed.text = terms.join(" ").toLowerCase();
  return parsed;
}

export function filterNotesWithSearchSyntax(
  notes: NoteMetadata[],
  query: string,
  getDisplayTitle: (note: NoteMetadata) => string,
): NoteMetadata[] {
  const parsed = parseNoteSearchQuery(query);

  return notes.filter((note) => {
    if (parsed.tag && !note.tags.some((tag) => tag.trim().toLowerCase() === parsed.tag)) {
      return false;
    }
    if (parsed.category && note.category.trim().toLowerCase() !== parsed.category) {
      return false;
    }
    if (parsed.pinned !== undefined && note.pinned !== parsed.pinned) {
      return false;
    }
    if (!parsed.text) return true;

    const haystack = [note.title, note.preview, note.fileName, getDisplayTitle(note)]
      .join(" ")
      .toLowerCase();
    return haystack.includes(parsed.text);
  });
}
