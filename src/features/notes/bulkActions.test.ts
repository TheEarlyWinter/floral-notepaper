import { describe, expect, test, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import {
  batchAddTagsToNotes,
  batchDeleteNotes,
  batchExportNotesMarkdown,
  batchMoveNotesCategory,
  buildUniqueMarkdownFileName,
  joinDirAndFile,
  mergeTagsWithoutDuplicates,
  parseTagInput,
  selectAllNoteIds,
  toggleSelectionId,
} from "./bulkActions";
import type { Note } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const mockedOpen = vi.mocked(open);

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    title: "Note 1",
    fileName: "n1.md",
    category: "",
    createdAt: "2026-11-21T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
    wordCount: 5,
    content: "Body",
    tags: [],
    pinned: false,
    ...overrides,
  };
}

describe("bulkActions", () => {
  test("parses comma-separated tags and merges without duplicates", () => {
    expect(parseTagInput(" work, #urgent，project , work , , ")).toEqual([
      "work",
      "urgent",
      "project",
    ]);
    expect(mergeTagsWithoutDuplicates(["work", "alpha"], ["alpha", "beta", "work"])).toEqual([
      "work",
      "alpha",
      "beta",
    ]);
  });

  test("toggles selection ids and selects all visible notes", () => {
    const initial = new Set<string>();
    const withA = toggleSelectionId(initial, "a");
    expect(Array.from(withA)).toEqual(["a"]);
    const withoutA = toggleSelectionId(withA, "a");
    expect(withoutA.size).toBe(0);

    const all = selectAllNoteIds([{ id: "n1" }, { id: "n2" }]);
    expect(Array.from(all)).toEqual(["n1", "n2"]);
  });

  test("sanitizes and deduplicates markdown filenames across selected notes", () => {
    const used = new Set<string>();
    expect(buildUniqueMarkdownFileName("A/B:Test", used)).toBe("A_B_Test.md");
    expect(buildUniqueMarkdownFileName("A/B:Test", used)).toBe("A_B_Test-2.md");
    expect(buildUniqueMarkdownFileName("", used)).toBe("无标题笔记.md");
    expect(buildUniqueMarkdownFileName("   ", used)).toBe("无标题笔记-2.md");
    expect(joinDirAndFile("D:\\exports", "note.md")).toBe("D:\\exports\\note.md");
    expect(joinDirAndFile("/tmp/exports/", "note.md")).toBe("/tmp/exports/note.md");
  });

  test("batch moves categories and reports partial failures", async () => {
    const move = vi.fn(async (id: string) => {
      if (id === "n2") throw new Error("fail");
    });

    const result = await batchMoveNotesCategory(["n1", "n2", "n3"], "工作", {
      moveNoteCategory: move,
    });
    expect(move).toHaveBeenCalledTimes(3);
    expect(move).toHaveBeenCalledWith("n1", "工作");
    expect(result.succeededIds).toEqual(["n1", "n3"]);
    expect(result.failedIds).toEqual(["n2"]);
  });

  test("batch adds tags while skipping notes that already contain all tags", async () => {
    const note1 = makeNote({ id: "n1", tags: ["existing"], content: "content-1", pinned: true });
    const note2 = makeNote({ id: "n2", tags: ["existing", "newtag"] });
    const getNote = vi.fn(async (id: string) => (id === "n1" ? note1 : note2));
    const updateNote = vi.fn(async (id: string, req) => ({
      ...note1,
      id,
      tags: req.tags ?? [],
    }));

    const { updatedNotes, result } = await batchAddTagsToNotes(["n1", "n2"], "existing, newtag", {
      getNote,
      updateNote,
    });

    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateNote).toHaveBeenCalledWith("n1", {
      title: "Note 1",
      content: "content-1",
      category: "",
      tags: ["existing", "newtag"],
      pinned: true,
    });
    expect(updatedNotes).toHaveLength(1);
    expect(result.succeededIds).toEqual(["n1"]);
    expect(result.skippedIds).toEqual(["n2"]);
  });

  test("batch exports markdown using directory picker and handles cancellation", async () => {
    mockedOpen.mockResolvedValueOnce(null);
    const cancelled = await batchExportNotesMarkdown([{ id: "n1", title: "Hello" }]);
    expect(cancelled.cancelled).toBe(true);
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });

    mockedOpen.mockResolvedValueOnce("D:\\exports");
    const exportFn = vi.fn(async () => undefined);
    const exported = await batchExportNotesMarkdown(
      [
        { id: "n1", title: "Hello/World" },
        { id: "n2", title: "Hello/World" },
      ],
      { exportMarkdownToPath: exportFn },
    );

    expect(exported.cancelled).toBe(false);
    expect(exported.result.succeededIds).toEqual(["n1", "n2"]);
    expect(exportFn).toHaveBeenNthCalledWith(1, "n1", "D:\\exports\\Hello_World.md");
    expect(exportFn).toHaveBeenNthCalledWith(2, "n2", "D:\\exports\\Hello_World-2.md");
  });

  test("batch deletes notes cleanly", async () => {
    const deleteFn = vi.fn(async () => undefined);
    const result = await batchDeleteNotes(["n1", "n2"], { deleteNote: deleteFn });
    expect(deleteFn).toHaveBeenCalledTimes(2);
    expect(result.succeededIds).toEqual(["n1", "n2"]);
    expect(result.failedIds).toEqual([]);
  });
});
