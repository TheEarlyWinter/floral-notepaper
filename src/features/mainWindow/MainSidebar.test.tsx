import { createRef } from "react";
import type { TFunction } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { NoteMetadata } from "../notes/types";
import { MainSidebar } from "./MainSidebar";

const translate = ((key: string, options?: { defaultValue?: string; count?: number }) => {
  if (options?.defaultValue) {
    return options.count != null
      ? options.defaultValue.replace("{{count}}", String(options.count))
      : options.defaultValue;
  }
  return key;
}) as unknown as TFunction;

const sampleNotes: NoteMetadata[] = [
  {
    id: "n1",
    title: "First Note",
    fileName: "n1.md",
    category: "",
    createdAt: "2026-11-21T08:00:00Z",
    updatedAt: "2026-11-21T08:00:00Z",
    wordCount: 10,
    preview: "Preview 1",
    tags: [],
    pinned: false,
  },
  {
    id: "n2",
    title: "Second Note",
    fileName: "n2.md",
    category: "Work",
    createdAt: "2026-11-21T09:00:00Z",
    updatedAt: "2026-11-21T09:00:00Z",
    wordCount: 20,
    preview: "Preview 2",
    tags: ["tag1"],
    pinned: false,
  },
];

function renderSidebar(multiSelectMode: boolean, selectedIds: string[] = []): string {
  return renderToStaticMarkup(
    <MainSidebar
      t={translate}
      sidebarCollapsed={false}
      focusMode={false}
      sidebarWidth={280}
      isResizingSidebar={false}
      onStartResizeSidebar={vi.fn()}
      searchQuery=""
      onSearchQueryChange={vi.fn()}
      notes={sampleNotes}
      filteredNotes={sampleNotes}
      externalFiles={[]}
      selectedId="n1"
      hoveredId={null}
      onHoverId={vi.fn()}
      tagFilter=""
      tagFilterOpen={false}
      onToggleTagFilter={vi.fn()}
      onSelectTagFilter={vi.fn()}
      selectedTemplateId=""
      onSelectTemplateId={vi.fn()}
      templates={[]}
      sidebarActionOrder={["daily", "inbox", "journal", "dashboard", "new-note", "todos", "import"]}
      inboxCount={0}
      categoryGroups={[
        { category: "", notes: [sampleNotes[0]], latestUpdatedAt: sampleNotes[0].updatedAt },
        { category: "Work", notes: [sampleNotes[1]], latestUpdatedAt: sampleNotes[1].updatedAt },
      ]}
      collapsedCategories={new Set()}
      dragOverCategory={null}
      activeSidebarPointerDrag={null}
      showCategoryInput={false}
      categoryInputValue=""
      onCategoryInputValueChange={vi.fn()}
      onOpenCategoryInput={vi.fn()}
      onCancelCategoryInput={vi.fn()}
      onCreateCategory={vi.fn()}
      renamingCategory={null}
      renameCategoryValue=""
      onRenameCategoryValueChange={vi.fn()}
      onCommitRenameCategory={vi.fn()}
      onCancelRenameCategory={vi.fn()}
      isLoading={false}
      sidebarScrollRef={createRef()}
      consumeSidebarPointerClick={() => false}
      beginSidebarPointerDrag={vi.fn()}
      beginSidebarNotePointerDrag={vi.fn()}
      sidebarActionDragClass={() => ""}
      onOpenDailyNote={vi.fn()}
      onOpenWorkspace={vi.fn()}
      onNewNote={vi.fn()}
      onToggleTodos={vi.fn()}
      onImportNote={vi.fn()}
      onSelectExternalFile={vi.fn()}
      onRemoveExternalFile={vi.fn()}
      onSelectNote={vi.fn()}
      onOpenNoteMenu={vi.fn()}
      onToggleCategoryCollapse={vi.fn()}
      onOpenCategoryMenu={vi.fn()}
      multiSelectMode={multiSelectMode}
      selectedNoteIds={new Set(selectedIds)}
      onToggleMultiSelectMode={vi.fn()}
      onToggleNoteSelection={vi.fn()}
      onSelectAllNotes={vi.fn()}
      onClearNoteSelection={vi.fn()}
    />,
  );
}

describe("MainSidebar multi-select", () => {
  test("renders clear multi-select text toggle in default mode without checkboxes", () => {
    const markup = renderSidebar(false);

    expect(markup).toContain("toggle-multi-select");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain(">多选<");
    expect(markup).not.toContain("sidebar-multiselect-bar");
    expect(markup).not.toContain('type="checkbox"');
  });

  test("renders multi-select toggle button, selection bar, and note checkboxes", () => {
    const markup = renderSidebar(true, ["n2"]);

    expect(markup).toContain("toggle-multi-select");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain(">完成<");
    expect(markup).toContain("sidebar-multiselect-bar");
    expect(markup).toContain("已选 1 项");
    expect(markup).toContain("全选");
    expect(markup).toContain("清空");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('aria-label="First Note"');
    expect(markup).toContain('aria-label="Second Note"');
  });
});
