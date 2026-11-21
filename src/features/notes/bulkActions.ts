import { t, type TFunction } from "i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { exportMarkdownNoteToPath, safeFileStem } from "../importExport/api";
import { deleteNote, getNote, moveNoteCategory, updateNote } from "./api";
import type { Note, NoteMetadata } from "./types";

export interface BatchOperationResult {
  succeededIds: string[];
  failedIds: string[];
  skippedIds: string[];
}

export function parseTagInput(rawInput: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const part of rawInput.split(/[,，]/)) {
    const normalized = part.trim().replace(/^#+/, "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export function mergeTagsWithoutDuplicates(existingTags: string[], addedTags: string[]): string[] {
  const merged = [...existingTags];
  const seen = new Set(existingTags);

  for (const tag of addedTags) {
    const normalized = tag.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }

  return merged;
}

export function toggleSelectionId(selectedIds: Set<string>, noteId: string): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(noteId)) {
    next.delete(noteId);
  } else {
    next.add(noteId);
  }
  return next;
}

export function selectAllNoteIds(notes: ReadonlyArray<Pick<NoteMetadata, "id">>): Set<string> {
  return new Set(notes.map((note) => note.id));
}

export function buildUniqueMarkdownFileName(
  title: string,
  usedLowerNames: Set<string>,
  translate: TFunction = t,
): string {
  const stem =
    safeFileStem(title) || translate("common.untitledNote", { defaultValue: "无标题笔记" });
  let candidate = `${stem}.md`;
  let suffix = 2;

  while (usedLowerNames.has(candidate.toLowerCase())) {
    candidate = `${stem}-${suffix}.md`;
    suffix += 1;
  }

  usedLowerNames.add(candidate.toLowerCase());
  return candidate;
}

export function joinDirAndFile(dir: string, fileName: string): string {
  if (dir.endsWith("/") || dir.endsWith("\\")) {
    return `${dir}${fileName}`;
  }
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir}${separator}${fileName}`;
}

export async function batchMoveNotesCategory(
  noteIds: string[],
  targetCategory: string,
  deps: {
    moveNoteCategory?: (id: string, category: string) => Promise<unknown>;
  } = {},
): Promise<BatchOperationResult> {
  const move = deps.moveNoteCategory ?? moveNoteCategory;
  const result: BatchOperationResult = { succeededIds: [], failedIds: [], skippedIds: [] };

  for (const noteId of noteIds) {
    try {
      await move(noteId, targetCategory);
      result.succeededIds.push(noteId);
    } catch {
      result.failedIds.push(noteId);
    }
  }

  return result;
}

export async function batchAddTagsToNotes(
  noteIds: string[],
  rawTagInput: string,
  deps: {
    getNote?: (id: string) => Promise<Note>;
    updateNote?: (id: string, request: Parameters<typeof updateNote>[1]) => Promise<Note>;
  } = {},
): Promise<{ updatedNotes: Note[]; result: BatchOperationResult }> {
  const parsedTags = parseTagInput(rawTagInput);
  const result: BatchOperationResult = { succeededIds: [], failedIds: [], skippedIds: [] };
  if (parsedTags.length === 0 || noteIds.length === 0) {
    return { updatedNotes: [], result };
  }

  const readNote = deps.getNote ?? getNote;
  const saveNote = deps.updateNote ?? updateNote;
  const updatedNotes: Note[] = [];

  for (const noteId of noteIds) {
    try {
      const note = await readNote(noteId);
      const existingTags = note.tags || [];
      const mergedTags = mergeTagsWithoutDuplicates(existingTags, parsedTags);
      if (mergedTags.length === existingTags.length) {
        result.skippedIds.push(noteId);
        continue;
      }
      const updated = await saveNote(note.id, {
        title: note.title,
        content: note.content,
        category: note.category,
        tags: mergedTags,
        pinned: note.pinned,
      });
      updatedNotes.push(updated);
      result.succeededIds.push(noteId);
    } catch {
      result.failedIds.push(noteId);
    }
  }

  return { updatedNotes, result };
}

export async function batchExportNotesMarkdown(
  notes: ReadonlyArray<{ id: string; title: string }>,
  deps: {
    pickDirectory?: () => Promise<string | string[] | null>;
    exportMarkdownToPath?: (id: string, path: string) => Promise<void>;
    translate?: TFunction;
  } = {},
): Promise<{ cancelled: boolean; directory: string | null; result: BatchOperationResult }> {
  const emptyResult: BatchOperationResult = { succeededIds: [], failedIds: [], skippedIds: [] };
  if (notes.length === 0) {
    return { cancelled: true, directory: null, result: emptyResult };
  }

  const pickDir = deps.pickDirectory ?? (() => open({ directory: true, multiple: false }));
  const selected = await pickDir();
  if (typeof selected !== "string" || !selected) {
    return { cancelled: true, directory: null, result: emptyResult };
  }

  const exportFn = deps.exportMarkdownToPath ?? exportMarkdownNoteToPath;
  const translate = deps.translate ?? t;
  const usedNames = new Set<string>();
  const result: BatchOperationResult = { succeededIds: [], failedIds: [], skippedIds: [] };

  for (const note of notes) {
    const fileName = buildUniqueMarkdownFileName(note.title, usedNames, translate);
    const fullPath = joinDirAndFile(selected, fileName);
    try {
      await exportFn(note.id, fullPath);
      result.succeededIds.push(note.id);
    } catch {
      result.failedIds.push(note.id);
    }
  }

  return { cancelled: false, directory: selected, result };
}

export async function batchDeleteNotes(
  noteIds: string[],
  deps: {
    deleteNote?: (id: string) => Promise<void>;
  } = {},
): Promise<BatchOperationResult> {
  const remove = deps.deleteNote ?? deleteNote;
  const result: BatchOperationResult = { succeededIds: [], failedIds: [], skippedIds: [] };

  for (const noteId of noteIds) {
    try {
      await remove(noteId);
      result.succeededIds.push(noteId);
    } catch {
      result.failedIds.push(noteId);
    }
  }

  return result;
}
