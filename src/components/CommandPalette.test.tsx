import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";
import { i18n } from "../locales";
import type { IndexedSearchResult, NoteMetadata } from "../features/notes/types";
import type { AppConfig } from "../features/settings/types";
import { SettingsPanel } from "./SettingsPanel";
import {
  CommandPalette,
  type PaletteCommand,
  buildPaletteItems,
  filterPaletteCommands,
  firstSelectablePaletteIndex,
  handlePaletteKeyDown,
  isCommandOnlyQuery,
  nextSelectablePaletteIndex,
  toggleCommandOnlyQuery,
} from "./CommandPalette";

const sampleNotes: NoteMetadata[] = [
  {
    id: "n1",
    title: "项目周报",
    fileName: "n1.md",
    category: "工作",
    createdAt: "2026-11-20T09:00:00Z",
    updatedAt: "2026-11-21T09:00:00Z",
    wordCount: 120,
    preview: "本周完成了命令面板设计",
    tags: ["weekly", "planning"],
    pinned: true,
  },
  {
    id: "n2",
    title: "读书笔记",
    fileName: "n2.md",
    category: "阅读",
    createdAt: "2026-11-19T09:00:00Z",
    updatedAt: "2026-11-20T08:00:00Z",
    wordCount: 85,
    preview: "摘录一些段落",
    tags: ["books"],
    pinned: false,
  },
  {
    id: "n3",
    title: "灵感草稿",
    fileName: "n3.md",
    category: "收件箱",
    createdAt: "2026-11-18T09:00:00Z",
    updatedAt: "2026-11-19T08:00:00Z",
    wordCount: 40,
    preview: "快速捕获想法",
    tags: ["idea"],
    pinned: false,
  },
];

function makeCommands(): PaletteCommand[] {
  return [
    {
      id: "new-note",
      label: "新建笔记",
      description: "在当前分类创建一篇空白笔记",
      keywords: ["new note", "create"],
      onExecute: vi.fn(),
    },
    {
      id: "open-daily",
      label: "打开每日便笺",
      keywords: ["daily"],
      onExecute: vi.fn(),
    },
    {
      id: "open-inbox",
      label: "打开收件箱",
      keywords: ["inbox"],
      onExecute: vi.fn(),
    },
    {
      id: "open-journal",
      label: "打开日记流",
      keywords: ["journal"],
      onExecute: vi.fn(),
    },
    {
      id: "open-todos",
      label: "打开待办面板",
      keywords: ["todo"],
      onExecute: vi.fn(),
    },
    {
      id: "open-knowledge-graph",
      label: "打开知识图谱",
      keywords: ["graph"],
      onExecute: vi.fn(),
    },
    {
      id: "open-weekly-review",
      label: "打开本周回顾",
      keywords: ["weekly", "review"],
      onExecute: vi.fn(),
    },
    {
      id: "toggle-focus-mode",
      label: "切换专注模式",
      keywords: ["focus"],
      onExecute: vi.fn(),
    },
    {
      id: "toggle-reading-mode",
      label: "切换沉浸阅读",
      keywords: ["reading"],
      onExecute: vi.fn(),
    },
    {
      id: "open-reminders",
      label: "打开提醒",
      keywords: ["reminders"],
      disabled: true,
      onExecute: vi.fn(),
    },
    {
      id: "export-pdf",
      label: "导出 PDF",
      keywords: ["pdf", "export"],
      onExecute: vi.fn(),
    },
    {
      id: "open-settings",
      label: "打开设置",
      keywords: ["settings"],
      onExecute: vi.fn(),
    },
    {
      id: "open-quick-capture",
      label: "打开快速捕获",
      keywords: ["quick capture"],
      shortcut: "Alt+Shift+Space",
      onExecute: vi.fn(),
    },
  ];
}

describe("CommandPalette", () => {
  test("renders nothing when closed and renders dialog, notes, commands, and shortcuts when open", () => {
    const commands = makeCommands();
    const closedMarkup = renderToStaticMarkup(
      <CommandPalette
        open={false}
        notes={sampleNotes}
        commands={commands}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(closedMarkup).toBe("");

    const openMarkup = renderToStaticMarkup(
      <CommandPalette
        open={true}
        notes={sampleNotes}
        commands={commands}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(openMarkup).toContain('role="dialog"');
    expect(openMarkup).toContain('role="combobox"');
    expect(openMarkup).toContain('role="listbox"');
    expect(openMarkup).toContain("项目周报");
    expect(openMarkup).toContain("导出 PDF");
    expect(openMarkup).toContain("Alt+Shift+Space");
    expect(openMarkup).toContain("仅命令");
  });

  test("renders command-only mode and localized create-note label", async () => {
    const commands = makeCommands();
    const cmdMarkup = renderToStaticMarkup(
      <CommandPalette
        open={true}
        notes={sampleNotes}
        commands={commands}
        initialQuery=">pdf"
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(cmdMarkup).toContain('aria-pressed="true"');
    expect(cmdMarkup).toContain("导出 PDF");
    expect(cmdMarkup).not.toContain("项目周报");
    expect(cmdMarkup).not.toContain("创建笔记");

    const enInstance = i18n.cloneInstance({ lng: "en-US" });
    await enInstance.changeLanguage("en-US");
    const enMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={enInstance}>
        <CommandPalette
          open={true}
          notes={sampleNotes}
          commands={commands}
          initialQuery="sprint notes"
          onSelectNote={vi.fn()}
          onCreateNote={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(enMarkup).toContain("Create note: sprint notes");
  });

  test("detects and toggles command-only prefix", () => {
    expect(isCommandOnlyQuery(">")).toBe(true);
    expect(isCommandOnlyQuery("  >pdf")).toBe(true);
    expect(isCommandOnlyQuery("pdf")).toBe(false);

    expect(toggleCommandOnlyQuery("")).toBe(">");
    expect(toggleCommandOnlyQuery("pdf")).toBe(">pdf");
    expect(toggleCommandOnlyQuery(">pdf")).toBe("pdf");
    expect(toggleCommandOnlyQuery("  >  settings")).toBe("settings");
  });

  test("filters commands by label, description, and keywords", () => {
    const commands = makeCommands();

    expect(filterPaletteCommands(commands, "")).toHaveLength(13);
    expect(filterPaletteCommands(commands, "pdf").map((c) => c.id)).toEqual(["export-pdf"]);
    expect(filterPaletteCommands(commands, "focus").map((c) => c.id)).toEqual([
      "toggle-focus-mode",
    ]);
    expect(filterPaletteCommands(commands, "空白笔记").map((c) => c.id)).toEqual(["new-note"]);
  });

  test("matches local notes by title, category, and tags, merges FTS5 snippets without duplicates, and appends create-note action", () => {
    const commands = makeCommands();
    const t = i18n.getFixedT("zh-CN");

    // Category match + tag match
    const categoryItems = buildPaletteItems({
      query: "阅读",
      notes: sampleNotes,
      ftsHits: [],
      commands,
      t,
    });
    expect(categoryItems.some((item) => item.kind === "note" && item.noteId === "n2")).toBe(true);
    expect(categoryItems[categoryItems.length - 1]).toEqual({
      kind: "create-note",
      id: "create:阅读",
      title: "阅读",
    });

    const tagItems = buildPaletteItems({
      query: "#weekly",
      notes: sampleNotes,
      ftsHits: [],
      commands,
      t,
    });
    expect(tagItems.some((item) => item.kind === "note" && item.noteId === "n1")).toBe(true);

    // Merge FTS5 content matches: enrich n1 without duplicating, plus body-only hit n3
    const ftsHits: IndexedSearchResult[] = [
      {
        noteId: "n1",
        title: "项目周报",
        category: "工作",
        snippet: "本周完成了…周报汇总",
        matchStart: 5,
        matchLength: 2,
        score: 10,
      },
      {
        noteId: "n3",
        title: "灵感草稿",
        category: "收件箱",
        snippet: "在正文里提到了周报想法",
        matchStart: 7,
        matchLength: 2,
        score: 8,
      },
    ];

    const merged = buildPaletteItems({
      query: "周报",
      notes: sampleNotes,
      ftsHits,
      commands,
      t,
    });
    const noteRows = merged.filter(
      (item): item is Extract<typeof item, { kind: "note" }> => item.kind === "note",
    );
    expect(noteRows.map((row) => row.noteId)).toEqual(["n1", "n3"]);
    expect(noteRows[0].snippet).toBe("本周完成了…周报汇总");
    expect(noteRows[0].matchStart).toBe(5);
    expect(noteRows[1].tags).toEqual(["idea"]);
    expect(noteRows[1].matchStart).toBe(7);
  });

  test("navigates with ArrowUp/ArrowDown skipping disabled commands, executes with Enter, and closes on Esc while respecting IME", () => {
    const commands = makeCommands();
    const t = i18n.getFixedT("zh-CN");
    const items = buildPaletteItems({
      query: ">",
      notes: sampleNotes,
      ftsHits: [],
      commands,
      t,
    });

    // Disabled command at index 9 ("open-reminders") should be skipped
    expect(firstSelectablePaletteIndex(items)).toBe(0);
    expect(nextSelectablePaletteIndex(items, 8, 1)).toBe(10);
    expect(nextSelectablePaletteIndex(items, 10, -1)).toBe(8);
    expect(nextSelectablePaletteIndex(items, 12, 1)).toBe(0);
    expect(nextSelectablePaletteIndex(items, 0, -1)).toBe(12);

    const onMove = vi.fn();
    const onExecute = vi.fn();
    const onClose = vi.fn();

    // ArrowDown
    const downPrevent = vi.fn();
    expect(
      handlePaletteKeyDown(
        {
          key: "ArrowDown",
          keyCode: 40,
          nativeEvent: { isComposing: false },
          preventDefault: downPrevent,
          stopPropagation: vi.fn(),
        },
        { items, activeIndex: 0, isComposing: false, onMove, onExecute, onClose },
      ),
    ).toBe(true);
    expect(downPrevent).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith(1);

    // ArrowUp
    expect(
      handlePaletteKeyDown(
        {
          key: "ArrowUp",
          keyCode: 38,
          nativeEvent: { isComposing: false },
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
        { items, activeIndex: 0, isComposing: false, onMove, onExecute, onClose },
      ),
    ).toBe(true);
    expect(onMove).toHaveBeenCalledWith(12);

    // Enter during IME composing is ignored
    expect(
      handlePaletteKeyDown(
        {
          key: "Enter",
          keyCode: 13,
          nativeEvent: { isComposing: true },
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
        { items, activeIndex: 0, isComposing: false, onMove, onExecute, onClose },
      ),
    ).toBe(false);
    expect(onExecute).not.toHaveBeenCalled();

    // Enter executes non-disabled item
    expect(
      handlePaletteKeyDown(
        {
          key: "Enter",
          keyCode: 13,
          nativeEvent: { isComposing: false },
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
        { items, activeIndex: 0, isComposing: false, onMove, onExecute, onClose },
      ),
    ).toBe(true);
    expect(onExecute).toHaveBeenCalledWith(items[0]);

    // Enter on disabled item does NOT execute
    onExecute.mockClear();
    expect(
      handlePaletteKeyDown(
        {
          key: "Enter",
          keyCode: 13,
          nativeEvent: { isComposing: false },
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
        { items, activeIndex: 9, isComposing: false, onMove, onExecute, onClose },
      ),
    ).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();

    // Escape closes and stops propagation
    const escStop = vi.fn();
    expect(
      handlePaletteKeyDown(
        {
          key: "Escape",
          keyCode: 27,
          nativeEvent: { isComposing: false },
          preventDefault: vi.fn(),
          stopPropagation: escStop,
        },
        { items, activeIndex: 0, isComposing: false, onMove, onExecute, onClose },
      ),
    ).toBe(true);
    expect(escStop).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("renders quickCaptureShortcut recorder row in SettingsPanel", () => {
    const config: AppConfig = {
      locale: "zh-CN",
      dataDir: "D:\\notes",
      globalShortcut: "Ctrl+Space",
      closeToTray: true,
      closeTabShortcut: "Ctrl+W",
      autostart: false,
      defaultViewMode: "split",
      noteAutoSave: true,
      noteSurfaceAutoSave: true,
      tileColor: "#f6f3ec",
      tileColorMode: "system",
      theme: "light",
      fontSize: 14,
      surfaceFontSize: 14,
      tabIndentSize: 2,
      externalFileAutoSave: true,
      rememberSurfaceSize: true,
      tileCtrlClose: true,
      tileDoubleClickToEdit: false,
      tileSaveReturnsToPin: false,
      tileRenderMarkdown: false,
      tileDesktopOnly: false,
      renderHtmlMarkdown: false,
      splitScrollSync: true,
      toggleVisibilityShortcut: "",
      quickCaptureShortcut: "Alt+Shift+Space",
      openAtCursor: true,
      presetTheme: "default",
      accentColor: "",
      codeTheme: "light",
      editorFontFamily: "",
      editorLineHeight: 1.8,
      editorParagraphSpacing: 0,
      editorWidth: "normal",
      sidebarPosition: "left",
      windowOpacity: 1,
      rememberWindowSize: false,
      showOutline: false,
      codeLineNumbers: false,
      linkPreview: true,
      customCss: "",
      templates: [],
    };

    const markup = renderToStaticMarkup(
      <SettingsPanel
        config={config}
        onChange={vi.fn()}
        onMigrateDataDir={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("快速捕获快捷键");
    expect(markup).toContain("Alt+Shift+Space");
    expect(markup).toContain("用于呼出桌面快速捕获输入框");
  });
});
