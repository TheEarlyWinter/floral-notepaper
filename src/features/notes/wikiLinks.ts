import type { Note, NoteMetadata } from "./types";

export interface WikiLink {
  target: string;
  label: string;
}

const WIKI_LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

function parseWikiLinkInner(rawInner: string): WikiLink | null {
  const raw = rawInner.trim();
  if (!raw) return null;
  const separator = raw.indexOf("|");
  const target = (separator >= 0 ? raw.slice(0, separator) : raw).trim();
  const label = (separator >= 0 ? raw.slice(separator + 1) : target).trim();
  return target && label ? { target, label } : null;
}

/** Extracts [[title]] and [[note:id|label]] links without changing Markdown content. */
export function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of content.matchAll(WIKI_LINK_PATTERN)) {
    const parsed = parseWikiLinkInner(match[1]);
    if (parsed) links.push(parsed);
  }
  return links;
}

/** Returns the wiki link surrounding a 0-based cursor offset in raw Markdown, if any. */
export function findWikiLinkAtOffset(content: string, offset: number): WikiLink | null {
  if (offset < 0 || offset > content.length) return null;
  for (const match of content.matchAll(WIKI_LINK_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      return parseWikiLinkInner(match[1]);
    }
  }
  return null;
}

/**
 * Resolves stable [[note:<id>|label]] links first. Title links are resolved only
 * when exactly one note has that title, so duplicate titles never jump to a
 * surprising destination.
 */
export function resolveWikiLink(target: string, notes: NoteMetadata[]): string | null {
  const normalized = target.trim();
  if (normalized.startsWith("note:")) {
    const id = normalized.slice("note:".length);
    return notes.some((note) => note.id === id) ? id : null;
  }

  const matches = notes.filter(
    (note) => note.title.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase(),
  );
  return matches.length === 1 ? matches[0].id : null;
}

export interface Backlink {
  noteId: string;
  noteTitle: string;
  category: string;
}

export function findBacklinks(targetId: string, notes: Note[]): Backlink[] {
  const metadata = notes.map(({ content: _content, ...note }) => ({
    ...note,
    preview: "",
  }));
  return notes.flatMap((note) => {
    const pointsToTarget = extractWikiLinks(note.content).some(
      (link) => resolveWikiLink(link.target, metadata) === targetId,
    );
    return pointsToTarget
      ? [{ noteId: note.id, noteTitle: note.title.trim() || "无标题笔记", category: note.category }]
      : [];
  });
}

export function wikiLinkSyntax(note: Pick<NoteMetadata, "id" | "title">): string {
  const label = note.title.trim() || "无标题笔记";
  return `[[note:${note.id}|${label}]]`;
}
