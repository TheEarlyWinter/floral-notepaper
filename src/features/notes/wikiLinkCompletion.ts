import type { TFunction } from "i18next";
import type { NoteMetadata } from "./types";
import { wikiLinkSyntax } from "./wikiLinks";

export interface WikiLinkTrigger {
  /** UTF-16 offset where `[[` starts in the editor value. */
  startOffset: number;
  /** UTF-16 offset of the active cursor. */
  endOffset: number;
  /** Text typed after `[[` up to the cursor. */
  query: string;
}

export interface WikiLinkKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export interface WikiLinkKeyHandlers {
  isOpen: boolean;
  candidateCount: number;
  isComposing?: boolean;
  onMove: (delta: 1 | -1) => void;
  onSelectActive: () => void;
  onDismiss: () => void;
}

export function isInsideFencedCodeBlock(content: string, cursorOffset: number): boolean {
  const clamped = Math.max(0, Math.min(cursorOffset, content.length));
  const lines = content.split("\n");
  let openFence: { char: "`" | "~"; length: number } | null = null;
  let offset = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineEnd = offset + rawLine.length;
    const cursorOnLine = clamped >= offset && clamped <= lineEnd;

    if (openFence) {
      if (cursorOnLine) {
        return true;
      }
      const closePattern =
        openFence.char === "`"
          ? new RegExp(`^\\s{0,3}\`{${openFence.length},}\\s*$`)
          : new RegExp(`^\\s{0,3}~{${openFence.length},}\\s*$`);
      if (closePattern.test(line)) {
        openFence = null;
      }
    } else {
      const backtickMatch = line.match(/^\s{0,3}(`{3,})([^`]*)$/);
      const tildeMatch = !backtickMatch ? line.match(/^\s{0,3}(~{3,})(.*)$/) : null;

      if (backtickMatch) {
        openFence = { char: "`", length: backtickMatch[1].length };
        if (cursorOnLine) {
          return true;
        }
      } else if (tildeMatch) {
        openFence = { char: "~", length: tildeMatch[1].length };
        if (cursorOnLine) {
          return true;
        }
      } else if (cursorOnLine) {
        return false;
      }
    }

    offset = lineEnd + 1;
  }

  return false;
}

export function detectWikiLinkTrigger(
  content: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): WikiLinkTrigger | null {
  if (selectionStart !== selectionEnd) {
    return null;
  }

  const cursor = Math.max(0, Math.min(selectionStart, content.length));
  if (isInsideFencedCodeBlock(content, cursor)) {
    return null;
  }

  const lineStart = content.lastIndexOf("\n", cursor - 1) + 1;
  const nextNewline = content.indexOf("\n", cursor);
  const lineEnd = nextNewline === -1 ? content.length : nextNewline;
  const lineBeforeCursor = content.slice(lineStart, cursor);
  const openRelIndex = lineBeforeCursor.lastIndexOf("[[");
  if (openRelIndex === -1) {
    return null;
  }

  const afterOpen = lineBeforeCursor.slice(openRelIndex + 2);
  if (afterOpen.includes("]") || afterOpen.includes("|")) {
    return null;
  }

  const lineAfterCursor = content.slice(cursor, lineEnd);
  const nextClose = lineAfterCursor.indexOf("]");
  const nextOpen = lineAfterCursor.indexOf("[[");
  if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
    return null;
  }

  return {
    startOffset: lineStart + openRelIndex,
    endOffset: cursor,
    query: afterOpen,
  };
}

function scoreCandidate(note: NoteMetadata, normalizedQuery: string, terms: string[]): number {
  const titleLower = note.title.trim().toLowerCase();
  const categoryLower = note.category.trim().toLowerCase();
  const tagsLower = (note.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const previewLower = note.preview.trim().toLowerCase();
  const haystack = [
    titleLower,
    categoryLower,
    ...tagsLower,
    ...tagsLower.map((tag) => `#${tag}`),
    previewLower,
  ].join(" ");

  if (!terms.every((term) => haystack.includes(term))) {
    return 0;
  }

  if (titleLower === normalizedQuery) return 100;
  if (titleLower.startsWith(normalizedQuery)) return 80;
  if (titleLower.includes(normalizedQuery)) return 60;
  if (
    categoryLower.includes(normalizedQuery) ||
    tagsLower.some((tag) => tag.includes(normalizedQuery) || `#${tag}`.includes(normalizedQuery))
  ) {
    return 40;
  }
  if (previewLower.includes(normalizedQuery)) return 25;
  return terms.some((term) => titleLower.includes(term)) ? 30 : 15;
}

export function filterWikiLinkCandidates(
  notes: NoteMetadata[],
  query: string,
  excludeNoteId?: string | null,
  limit = 8,
): NoteMetadata[] {
  if (limit <= 0) {
    return [];
  }

  const pool = excludeNoteId ? notes.filter((note) => note.id !== excludeNoteId) : [...notes];
  const trimmed = query.trim();
  if (!trimmed) {
    return pool.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  const normalized = trimmed.toLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  const scored: Array<{ note: NoteMetadata; score: number }> = [];

  for (const note of pool) {
    const score = scoreCandidate(note, normalized, terms);
    if (score > 0) {
      scored.push({ note, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt));
  return scored.slice(0, limit).map((entry) => entry.note);
}

export function formatWikiLinkCompletion(
  note: Pick<NoteMetadata, "id" | "title">,
  translate?: TFunction,
): string {
  if (!translate) {
    return wikiLinkSyntax(note);
  }
  const label =
    note.title.trim() || translate("common.untitledNote", { defaultValue: "无标题笔记" });
  return `[[note:${note.id}|${label}]]`;
}

export function insertTextRangeInTextarea(
  textarea: HTMLTextAreaElement,
  startOffset: number,
  endOffset: number,
  insertion: string,
  setContent: (value: string) => void,
  markDirty: () => void,
): string {
  const { value, scrollTop, scrollLeft } = textarea;
  const start = Math.max(0, Math.min(startOffset, value.length));
  const end = Math.max(start, Math.min(endOffset, value.length));
  const nextValue = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  const nextCursor = start + insertion.length;

  textarea.focus();
  textarea.setSelectionRange(start, end);

  let appliedWithExecCommand = false;
  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    try {
      appliedWithExecCommand =
        document.execCommand("insertText", false, insertion) && textarea.value === nextValue;
    } catch {
      appliedWithExecCommand = false;
    }
  }

  if (!appliedWithExecCommand) {
    textarea.setRangeText(insertion, start, end, "end");
  }

  setContent(nextValue);
  markDirty();

  const restoreCursorAndScroll = () => {
    textarea.setSelectionRange(nextCursor, nextCursor);
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  };

  restoreCursorAndScroll();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(restoreCursorAndScroll);
  }

  return nextValue;
}

export function insertWikiLinkCompletion(
  textarea: HTMLTextAreaElement,
  trigger: WikiLinkTrigger,
  note: Pick<NoteMetadata, "id" | "title">,
  setContent: (value: string) => void,
  markDirty: () => void,
  translate?: TFunction,
): string {
  const linkText = formatWikiLinkCompletion(note, translate);
  return insertTextRangeInTextarea(
    textarea,
    trigger.startOffset,
    trigger.endOffset,
    linkText,
    setContent,
    markDirty,
  );
}

export function handleWikiLinkKeyDown(
  event: WikiLinkKeyEvent,
  handlers: WikiLinkKeyHandlers,
): boolean {
  if (!handlers.isOpen) {
    return false;
  }

  const composing = Boolean(
    handlers.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229,
  );
  if (composing) {
    return false;
  }

  if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation?.();
    handlers.onDismiss();
    return true;
  }

  if (handlers.candidateCount <= 0) {
    return false;
  }

  if (event.key === "ArrowDown" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation?.();
    handlers.onMove(1);
    return true;
  }

  if (event.key === "ArrowUp" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation?.();
    handlers.onMove(-1);
    return true;
  }

  if (
    (event.key === "Enter" || event.key === "Tab") &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    event.preventDefault();
    event.stopPropagation?.();
    handlers.onSelectActive();
    return true;
  }

  return false;
}
