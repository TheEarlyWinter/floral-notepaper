import { describe, expect, test, vi } from "vitest";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import type { Note, NoteMetadata } from "./types";
import {
  NOTES_EXTERNAL_CHANGED_EVENT,
  REMINDERS_EXTERNAL_CHANGED_EVENT,
  subscribeExternalSync,
} from "./useExternalSync";

function createFakeEventBus() {
  const handlers = new Map<string, EventCallback<unknown>>();
  const unlistenSpies = new Map<string, ReturnType<typeof vi.fn<UnlistenFn>>>();

  const listenEvent = vi.fn(async (eventName: string, handler: EventCallback<unknown>) => {
    handlers.set(eventName, handler);
    const unlisten = vi.fn<UnlistenFn>();
    unlistenSpies.set(eventName, unlisten);
    return unlisten;
  });

  const emit = async (eventName: string, payload: unknown = undefined) => {
    const handler = handlers.get(eventName);
    if (!handler) throw new Error(`Missing handler for ${eventName}`);
    handler({ event: eventName, id: 1, payload });
    // Flush microtasks for async handler chains.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  return { listenEvent, emit, unlistenSpies };
}

const meta: NoteMetadata = {
  id: "note-1",
  title: "Updated Title",
  fileName: "note-1.md",
  category: "work",
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-21T00:00:00Z",
  wordCount: 5,
  preview: "hello",
  tags: ["cli"],
  pinned: false,
};

const fullNote: Note = {
  ...meta,
  content: "Updated content from CLI",
};

describe("useExternalSync / subscribeExternalSync", () => {
  test("reloads metadata and active note content when editor is clean", async () => {
    const bus = createFakeEventBus();
    const refreshNotes = vi.fn(async () => [meta]);
    const fetchNote = vi.fn(async () => fullNote);
    const onApplyNote = vi.fn();
    const onDirtyConflict = vi.fn();

    const cleanup = subscribeExternalSync({
      refreshNotes,
      getActiveNoteId: () => "note-1",
      isDirty: () => false,
      fetchNote,
      onApplyNote,
      onDirtyConflict,
      listenEvent: bus.listenEvent as never,
    });

    await bus.emit(NOTES_EXTERNAL_CHANGED_EVENT);

    expect(refreshNotes).toHaveBeenCalledTimes(1);
    expect(fetchNote).toHaveBeenCalledWith("note-1");
    expect(onApplyNote).toHaveBeenCalledWith(fullNote);
    expect(onDirtyConflict).not.toHaveBeenCalled();

    cleanup();
    expect(bus.unlistenSpies.get(NOTES_EXTERNAL_CHANGED_EVENT)).toHaveBeenCalledTimes(1);
    expect(bus.unlistenSpies.get(REMINDERS_EXTERNAL_CHANGED_EVENT)).toHaveBeenCalledTimes(1);
  });

  test("preserves local edits and shows warning when editor is dirty", async () => {
    const bus = createFakeEventBus();
    const refreshNotes = vi.fn(async () => [meta]);
    const fetchNote = vi.fn(async () => fullNote);
    const onApplyNote = vi.fn();
    const onDirtyConflict = vi.fn();
    const onActiveNoteDeleted = vi.fn();

    const cleanup = subscribeExternalSync({
      refreshNotes,
      getActiveNoteId: () => "note-1",
      isDirty: () => true,
      fetchNote,
      onApplyNote,
      onActiveNoteDeleted,
      onDirtyConflict,
      listenEvent: bus.listenEvent as never,
    });

    await bus.emit(NOTES_EXTERNAL_CHANGED_EVENT);

    expect(refreshNotes).toHaveBeenCalledTimes(1);
    expect(fetchNote).not.toHaveBeenCalled();
    expect(onApplyNote).not.toHaveBeenCalled();
    expect(onActiveNoteDeleted).not.toHaveBeenCalled();
    expect(onDirtyConflict).toHaveBeenCalledTimes(1);

    cleanup();
  });

  test("aborts apply and triggers conflict notice if editor becomes dirty during async fetch", async () => {
    const bus = createFakeEventBus();
    let dirty = false;
    let resolveNote!: (note: Note) => void;
    const fetchNote = vi.fn(
      () =>
        new Promise<Note>((resolve) => {
          resolveNote = resolve;
        }),
    );
    const onApplyNote = vi.fn();
    const onDirtyConflict = vi.fn();

    const cleanup = subscribeExternalSync({
      refreshNotes: async () => [meta],
      getActiveNoteId: () => "note-1",
      isDirty: () => dirty,
      fetchNote,
      onApplyNote,
      onDirtyConflict,
      listenEvent: bus.listenEvent as never,
    });

    const emitPromise = bus.emit(NOTES_EXTERNAL_CHANGED_EVENT);
    await Promise.resolve();
    await Promise.resolve();

    dirty = true;
    resolveNote(fullNote);
    await emitPromise;

    expect(onApplyNote).not.toHaveBeenCalled();
    expect(onDirtyConflict).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("notifies onActiveNoteDeleted when clean active note disappears externally", async () => {
    const bus = createFakeEventBus();
    const onApplyNote = vi.fn();
    const onActiveNoteDeleted = vi.fn();

    const cleanup = subscribeExternalSync({
      refreshNotes: async () => [],
      getActiveNoteId: () => "note-1",
      isDirty: () => false,
      onApplyNote,
      onActiveNoteDeleted,
      onDirtyConflict: vi.fn(),
      listenEvent: bus.listenEvent as never,
    });

    await bus.emit(NOTES_EXTERNAL_CHANGED_EVENT);

    expect(onApplyNote).not.toHaveBeenCalled();
    expect(onActiveNoteDeleted).toHaveBeenCalledWith([]);
    cleanup();
  });

  test("refreshes reminders when reminders-external-changed fires", async () => {
    const bus = createFakeEventBus();
    const onRefreshReminders = vi.fn(async () => undefined);

    const cleanup = subscribeExternalSync({
      refreshNotes: async () => [],
      getActiveNoteId: () => null,
      isDirty: () => false,
      onApplyNote: vi.fn(),
      onDirtyConflict: vi.fn(),
      onRefreshReminders,
      listenEvent: bus.listenEvent as never,
    });

    await bus.emit(REMINDERS_EXTERNAL_CHANGED_EVENT);

    expect(onRefreshReminders).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
