import type { Note, NoteMetadata } from "./types";

export interface WikiLink {
  target: string;
  label: string;
}

const WIKI_LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/** Extracts [[title]] and [[note:id|label]] links without changing Markdown content. */
export function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of content.matchAll(WIKI_LINK_PATTERN)) {
    const raw = match[1].trim();
    if (!raw) continue;
    const separator = raw.indexOf("|");
    const target = (separator >= 0 ? raw.slice(0, separator) : raw).trim();
    const label = (separator >= 0 ? raw.slice(separator + 1) : target).trim();
    if (target && label) links.push({ target, label });
  }
  return links;
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

  const matches = notes.filter((note) => note.title.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase());
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
