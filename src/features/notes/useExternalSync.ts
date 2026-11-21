import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getNote } from "./api";
import type { Note, NoteMetadata } from "./types";

export const NOTES_EXTERNAL_CHANGED_EVENT = "notes-external-changed";
export const REMINDERS_EXTERNAL_CHANGED_EVENT = "reminders-external-changed";

export interface ExternalSyncOptions {
  /** Refresh the note metadata list (sidebar / open panel). */
  refreshNotes: () => Promise<NoteMetadata[]>;
  /** Return the active internal note ID, or null if none / external file / standby. */
  getActiveNoteId: () => string | null;
  /** Return true when the active editor holds unsaved local edits or an in-flight save. */
  isDirty: () => boolean;
  /** Optional epoch counter to discard stale async reloads after user navigation. */
  getSyncEpoch?: () => number;
  /** Fetch full note content by ID (defaults to Tauri `getNote`). */
  fetchNote?: (id: string) => Promise<Note>;
  /** Apply the reloaded note into editor or tile state. */
  onApplyNote: (note: Note) => void;
  /** Optional handler when the active note no longer exists after refresh (only when clean). */
  onActiveNoteDeleted?: (remainingNotes: NoteMetadata[]) => void;
  /** Show a non-destructive notice when external changes arrive while local edits are dirty. */
  onDirtyConflict: () => void;
  /** Optional handler to refresh reminders when `reminders-external-changed` arrives. */
  onRefreshReminders?: () => void | Promise<void>;
  /** Optional event listener override for unit testing. */
  listenEvent?: typeof listen;
}

export function subscribeExternalSync(options: ExternalSyncOptions): () => void {
  const subscribe = options.listenEvent ?? listen;
  let disposed = false;
  const unlistenFns: UnlistenFn[] = [];

  const handleNotesExternalChanged = async () => {
    const epochAtEvent = options.getSyncEpoch?.();
    const isStale = () =>
      disposed || (epochAtEvent !== undefined && options.getSyncEpoch?.() !== epochAtEvent);

    try {
      const loadedNotes = await options.refreshNotes();
      if (isStale()) return;

      const activeId = options.getActiveNoteId();
      if (!activeId) return;

      if (options.isDirty()) {
        options.onDirtyConflict();
        return;
      }

      const stillExists = loadedNotes.some((note) => note.id === activeId);
      if (!stillExists) {
        options.onActiveNoteDeleted?.(loadedNotes);
        return;
      }

      const fetchNote = options.fetchNote ?? getNote;
      const note = await fetchNote(activeId);
      if (isStale()) return;
      if (options.getActiveNoteId() !== activeId) return;

      if (options.isDirty()) {
        options.onDirtyConflict();
        return;
      }

      options.onApplyNote(note);
    } catch {
      // Ignore transient IPC errors during background sync; next change will retry.
    }
  };

  const handleRemindersExternalChanged = async () => {
    if (disposed || !options.onRefreshReminders) return;
    try {
      await options.onRefreshReminders();
    } catch {
      // Ignore transient IPC errors during background sync.
    }
  };

  void subscribe(NOTES_EXTERNAL_CHANGED_EVENT, () => {
    void handleNotesExternalChanged();
  })
    .then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenFns.push(unlisten);
      }
    })
    .catch(() => undefined);

  void subscribe(REMINDERS_EXTERNAL_CHANGED_EVENT, () => {
    void handleRemindersExternalChanged();
  })
    .then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenFns.push(unlisten);
      }
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    for (const unlisten of unlistenFns.splice(0)) {
      unlisten();
    }
  };
}

export function useExternalSync(options: ExternalSyncOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    return subscribeExternalSync({
      refreshNotes: () => optionsRef.current.refreshNotes(),
      getActiveNoteId: () => optionsRef.current.getActiveNoteId(),
      isDirty: () => optionsRef.current.isDirty(),
      getSyncEpoch: optionsRef.current.getSyncEpoch
        ? () => optionsRef.current.getSyncEpoch?.() ?? 0
        : undefined,
      fetchNote: (id) => (optionsRef.current.fetchNote ?? getNote)(id),
      onApplyNote: (note) => optionsRef.current.onApplyNote(note),
      onActiveNoteDeleted: (remaining) => optionsRef.current.onActiveNoteDeleted?.(remaining),
      onDirtyConflict: () => optionsRef.current.onDirtyConflict(),
      onRefreshReminders: () => optionsRef.current.onRefreshReminders?.(),
      listenEvent: optionsRef.current.listenEvent,
    });
  }, []);
}
