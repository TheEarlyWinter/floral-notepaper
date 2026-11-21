import type { TFunction } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { NoteMetadata } from "../notes/types";
import { EditorToolbar } from "./EditorToolbar";

const translate = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

const sampleNote: NoteMetadata = {
  id: "note-1",
  title: "测试笔记",
  fileName: "note-1.md",
  category: "学习",
  createdAt: "2026-11-21T08:00:00Z",
  updatedAt: "2026-11-21T08:00:00Z",
  wordCount: 42,
  preview: "正文摘要",
  tags: [],
  pinned: false,
};

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof EditorToolbar>> = {},
): string {
  return renderToStaticMarkup(
    <EditorToolbar
      t={translate}
      settingsOpen={false}
      aboutOpen={false}
      focusMode={false}
      readingMode={false}
      toolbarCollapsed={false}
      sidebarCollapsed={false}
      effectiveViewMode="split"
      outlineOpen={false}
      selectedId={sampleNote.id}
      isExternal={false}
      selectedNote={sampleNote}
      content="# Hello"
      isPinned={false}
      selectedTilePinned={false}
      saveState="saved"
      deleteConfirm={false}
      deleteExiting={false}
      viewMode="split"
      viewModeOptions={[
        { value: "edit", label: "编辑" },
        { value: "split", label: "分栏" },
        { value: "preview", label: "预览" },
      ]}
      onToggleSidebar={vi.fn()}
      onToggleOutline={vi.fn()}
      onToggleHistory={vi.fn()}
      onToggleBacklinks={vi.fn()}
      onToggleKnowledgeGraph={vi.fn()}
      onCopyStableLink={vi.fn()}
      onToggleReminders={vi.fn()}
      onToggleLibrary={vi.fn()}
      onToggleFocusMode={vi.fn()}
      onExitFocusMode={vi.fn()}
      onToggleReadingMode={vi.fn()}
      onExitReadingMode={vi.fn()}
      onSaveAsTemplate={vi.fn()}
      onTogglePinNote={vi.fn()}
      onPinEntry={vi.fn()}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onSave={vi.fn()}
      onExportHtml={vi.fn()}
      onExportPdf={vi.fn()}
      onRequestDelete={vi.fn()}
      onConfirmDelete={vi.fn()}
      onCancelDelete={vi.fn()}
      onViewModeChange={vi.fn()}
      onSetToolbarCollapsed={vi.fn()}
      onToggleToolbarCollapsed={vi.fn()}
      {...overrides}
    />,
  );
}

describe("EditorToolbar responsive layout", () => {
  test("renders horizontally scrollable action strip with non-shrinking action buttons", () => {
    const markup = renderToolbar();

    expect(markup).toMatch(
      /data-testid="editor-toolbar-actions"[^>]*class="[^"]*flex-1 min-w-0[^"]*overflow-x-auto[^"]*scrollbar-hidden/,
    );
    expect(markup).toMatch(/class="[^"]*shrink-0[^"]*whitespace-nowrap[^"]*"[^>]*>保存<\/button>/);
    expect(markup).toMatch(/class="[^"]*shrink-0[^"]*whitespace-nowrap[^"]*"[^>]*>HTML<\/button>/);
    expect(markup).toMatch(/class="[^"]*shrink-0[^"]*whitespace-nowrap[^"]*"[^>]*>PDF<\/button>/);
  });

  test("keeps right view-mode cluster non-shrinking and labels single-line", () => {
    const markup = renderToolbar();

    expect(markup).toMatch(/data-testid="editor-toolbar-controls"[^>]*class="[^"]*shrink-0/);
    expect(markup).toMatch(/class="[^"]*whitespace-nowrap[^"]*"[^>]*>编辑<\/button>/);
    expect(markup).toMatch(/class="[^"]*whitespace-nowrap[^"]*"[^>]*>分栏<\/button>/);
    expect(markup).toMatch(/class="[^"]*whitespace-nowrap[^"]*"[^>]*>预览<\/button>/);
  });

  test("hides left actions strip and shows collapsed status label when toolbar is collapsed", () => {
    const markup = renderToolbar({ toolbarCollapsed: true });

    expect(markup).toContain("w-0 max-w-0 flex-none opacity-0 pointer-events-none");
    expect(markup).toContain("工具栏已收纳");
    expect(markup).not.toContain(">分栏</button>");
  });
});
