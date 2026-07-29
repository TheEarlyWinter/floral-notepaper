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
