export interface NoteMetadata {
  id: string;
  title: string;
  fileName: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  wordCount: number;
  preview: string;
  tags: string[];
  pinned: boolean;
}

export interface Note extends Omit<NoteMetadata, "preview"> {
  content: string;
}

export interface NoteVersion {
  id: string;
  createdAt: string;
  preview: string;
}

export interface Reminder {
  id: string;
  noteId: string;
  message: string;
  remindAt: string;
  notified: boolean;
}

export interface SaveNoteRequest {
  title: string;
  content: string;
  category: string;
  tags?: string[];
  pinned?: boolean;
}

export interface MergeNotesRequest {
  targetId: string;
  sourceId: string;
}

export interface ExternalFile {
  id: string;
  title: string;
  filePath: string;
}

export interface Attachment {
  id: string;
  noteId: string;
  name: string;
  fileName: string;
  size: number;
  createdAt: string;
}

export interface BackupInfo {
  fileName: string;
  createdAt: string;
  size: number;
  automatic: boolean;
}

export interface IndexedSearchResult {
  noteId: string;
  title: string;
  category: string;
  snippet: string;
  /** UTF-16 offset in the note body; -1 means the hit only matched the title. */
  matchStart: number;
  score: number;
}
