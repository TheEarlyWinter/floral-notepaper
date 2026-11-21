import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { extractOutlineHeadings } from "../features/markdown/outlineUtils";
import { BackgroundLayer } from "./BackgroundLayer";
import { showToast } from "./Toast";
import type { NotesWorkspaceMode } from "./NotesWorkspacePanel";
import { getErrorMessage } from "../features/notes/api";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import { useImagePaste } from "../features/images/useImagePaste";
import { INBOX_CATEGORY } from "../features/notes/insights";
import { getNoteContextMenuItems } from "../features/notes/noteContextMenu";
import {
  countNoteChars,
  filterNotesByTag,
  getDisplayTitle,
  groupNotesByCategory,
} from "../features/notes/noteUtils";
import { filterNotesWithSearchSyntax, parseNoteSearchQuery } from "../features/notes/todoUtils";
import { useNavigationHistory } from "../features/notes/useNavigationHistory";
import { normalizeViewMode } from "../features/settings/api";
import type { AppConfig, ViewMode } from "../features/settings/types";
import {
  openNotepadWindow,
  openQuickCaptureWindow,
  takeStartupFile,
} from "../features/windows/api";
import {
  closeCurrentWindow,
  isCurrentWindowMaximized,
  minimizeCurrentWindow,
  startCurrentWindowDrag,
  toggleMaximizeCurrentWindow,
} from "../features/windows/controls";
import { buildPaletteCommands } from "../features/mainWindow/buildPaletteCommands";
import { getToolbarButtons } from "../features/mainWindow/editorFormatting";
import { EditorPane } from "../features/mainWindow/EditorPane";
import { EditorToolbar } from "../features/mainWindow/EditorToolbar";
import { CommandPalette } from "../features/mainWindow/lazyPanels";
import { MainSidebar } from "../features/mainWindow/MainSidebar";
import { MainWindowSidePanels } from "../features/mainWindow/MainWindowSidePanels";
import { NoteHeader } from "../features/mainWindow/NoteHeader";
import { SidebarContextMenus } from "../features/mainWindow/SidebarContextMenus";
import { StatusBar } from "../features/mainWindow/StatusBar";
import { BUILT_IN_TEMPLATES } from "../features/mainWindow/templates";
import { TitleBar } from "../features/mainWindow/TitleBar";
import type { SaveState, SidePanelMode } from "../features/mainWindow/types";
import { useCategoryManagement } from "../features/mainWindow/useCategoryManagement";
import { useColumnResize } from "../features/mainWindow/useColumnResize";
import { useEditorActions } from "../features/mainWindow/useEditorActions";
import { useMainWindowShortcuts } from "../features/mainWindow/useMainWindowShortcuts";
import { useMainWindowSync } from "../features/mainWindow/useMainWindowSync";
import { useNoteOperations } from "../features/mainWindow/useNoteOperations";
import { useNoteSaveQueue } from "../features/mainWindow/useNoteSaveQueue";
import { useNoteState } from "../features/mainWindow/useNoteState";
import { useSettingsManagement } from "../features/mainWindow/useSettingsManagement";
import { useSidebarMenus } from "../features/mainWindow/useSidebarMenus";
import { useSidebarPointerDrag } from "../features/mainWindow/useSidebarPointerDrag";
import { useSplitScrollSync } from "../features/mainWindow/useSplitScrollSync";
import { useUpdateStatusSync } from "../features/mainWindow/useUpdateStatusSync";

export { applyFormat } from "../features/mainWindow/editorFormatting";
export { pinTileButtonTitle } from "../features/mainWindow/EditorToolbar";

interface MainWindowProps {
  initialSettingsOpen?: boolean;
  initialConfig?: AppConfig;
}

export function MainWindow({
  initialSettingsOpen = false,
  initialConfig = undefined,
}: MainWindowProps = {}) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(
    normalizeViewMode(initialConfig?.defaultViewMode ?? "split"),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [settingsConfig, setSettingsConfig] = useState<AppConfig | null>(initialConfig ?? null);
  const [savedDataDir, setSavedDataDir] = useState<string | null>(initialConfig?.dataDir ?? null);
  const [settingsOverlay, setSettingsOverlay] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 1080 : true,
  );
  const [aboutOpen, setAboutOpen] = useState(false);
  const [todosOpen, setTodosOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [knowledgeGraphOpen, setKnowledgeGraphOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [remindersRefreshKey, setRemindersRefreshKey] = useState(0);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(initialConfig?.showOutline ?? false);
  const [focusMode, setFocusMode] = useState(false);
  const [readingMode, setReadingMode] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<NotesWorkspaceMode | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteExiting, setDeleteExiting] = useState(false);
  const [pinnedTileIds, setPinnedTileIds] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isMaximized, setIsMaximized] = useState(false);

  const navHistory = useNavigationHistory();
  const handleSelectNoteRef = useRef<(id: string) => Promise<boolean>>(async () => false);
  const handleSelectExternalFileRef = useRef<(id: string) => Promise<boolean>>(async () => false);
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteOpen;
  const palettePreviousFocusRef = useRef<HTMLElement | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const windowLabelRef = useRef("main");
  const { dir: imageBaseDir, refresh: refreshImageBaseDir } = useImageBaseDir();

  const isMacOS = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      (/Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac"))
    );
  }, []);

  const noteState = useNoteState({
    settingsConfig,
    setCategories,
    navPush: navHistory.push,
  });

  const {
    notes,
    setNotes,
    externalFiles,
    setExternalFiles,
    externalImageBaseDir,
    setExternalImageBaseDir,
    selectedId,
    setSelectedId,
    noteTags,
    setNoteTags,
    isPinned,
    setIsPinned,
    content,
    setContent,
    title,
    setTitle,
    saveState,
    setSaveState,
    isLoading,
    setIsLoading,
    noteTransitionKey,
    setNoteTransitionKey,
    loadEpoch,
    externalFileMtimeRef,
    lastExternalSaveRef,
    editRevisionRef,
    saveStateRef,
    selectedIdRef,
    contentValueRef,
    titleValueRef,
    tagsValueRef,
    pinnedValueRef,
    notesRef,
    externalFilesRef,
    selectedNote,
    selectedNoteRef,
    selectedExternalFile,
    isExternal,
    allowRawHtml,
    isExternalRef,
    applyNote,
    replaceNoteMetadata,
    loadNote,
    refreshNotes,
    clearCurrentNote,
    loadExternalFile,
  } = noteState;

  const { aboutUpdateReminder, dismissUpdateReminderText } = useUpdateStatusSync();
  const {
    noteMenu,
    noteMenuClosing,
    setNoteMenuClosing,
    noteMenuMode,
    setNoteMenuMode,
    noteMenuRef,
    noteMenuPosition,
    openNoteMenu,
    categoryMenu,
    categoryMenuClosing,
    setCategoryMenuClosing,
    categoryMenuConfirmDelete,
    categoryMenuHoverSuppressed,
    categoryMenuRef,
    categoryMenuPosition,
    switchCategoryMenuPanel,
    openCategoryMenu,
  } = useSidebarMenus(categories.length);

  const noteMenuTarget = useMemo(
    () => notes.find((note) => note.id === noteMenu?.noteId) ?? null,
    [noteMenu?.noteId, notes],
  );
  const noteContextMenuItems = useMemo(() => getNoteContextMenuItems(t), [t]);
  const saveStateLabel = useMemo<Record<SaveState, string>>(
    () => ({
      idle: t("main.statusBar.saveState.idle", { defaultValue: "未选择" }),
      dirty: t("main.statusBar.saveState.dirty", { defaultValue: "未保存" }),
      saving: t("main.statusBar.saveState.saving", { defaultValue: "保存中" }),
      saved: t("main.statusBar.saveState.saved", { defaultValue: "已保存" }),
      error: t("main.statusBar.saveState.error", { defaultValue: "保存失败" }),
    }),
    [t],
  );
  const toolbarButtons = useMemo(() => getToolbarButtons(t), [t]);
  const viewModeOptions = useMemo(
    () => [
      {
        value: "edit" as ViewMode,
        label: t("settings.defaultView.edit", { defaultValue: "编辑" }),
      },
      {
        value: "split" as ViewMode,
        label: t("settings.defaultView.split", { defaultValue: "分栏" }),
      },
      {
        value: "preview" as ViewMode,
        label: t("settings.defaultView.preview", { defaultValue: "预览" }),
      },
    ],
    [t],
  );

  const visibleSidePanel: SidePanelMode | null = aboutOpen
    ? "about"
    : workspaceMode
      ? "workspace"
      : todosOpen
        ? "todos"
        : historyOpen && selectedId && !isExternal
          ? "history"
          : backlinksOpen && selectedId && !isExternal
            ? "backlinks"
            : knowledgeGraphOpen
              ? "knowledgeGraph"
              : libraryOpen
                ? "library"
                : remindersOpen && selectedId && !isExternal
                  ? "reminders"
                  : settingsOpen && settingsConfig
                    ? "settings"
                    : null;
  const effectiveViewMode: ViewMode = readingMode ? "preview" : viewMode;

  const closeAllSidePanels = useCallback(() => {
    setSettingsOpen(false);
    setAboutOpen(false);
    setTodosOpen(false);
    setHistoryOpen(false);
    setBacklinksOpen(false);
    setRemindersOpen(false);
    setLibraryOpen(false);
    setKnowledgeGraphOpen(false);
    setWorkspaceMode(null);
  }, []);

  const openCommandPalette = useCallback(() => {
    palettePreviousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(true);
  }, []);

  const closeCommandPalette = useCallback((options?: { restoreFocus?: boolean }) => {
    setPaletteOpen(false);
    if (options?.restoreFocus) {
      const previous = palettePreviousFocusRef.current;
      palettePreviousFocusRef.current = null;
      requestAnimationFrame(() => {
        previous?.focus();
      });
    } else {
      palettePreviousFocusRef.current = null;
    }
  }, []);

  const openWorkspace = useCallback((mode: NotesWorkspaceMode) => {
    setSettingsOpen(false);
    setAboutOpen(false);
    setTodosOpen(false);
    setHistoryOpen(false);
    setBacklinksOpen(false);
    setRemindersOpen(false);
    setLibraryOpen(false);
    setKnowledgeGraphOpen(false);
    setWorkspaceMode(mode);
  }, []);

  const openAboutPanel = useCallback(() => {
    setSettingsOpen(false);
    setAboutOpen(true);
    dismissUpdateReminderText();
  }, [dismissUpdateReminderText]);

  const templates = useMemo(
    () => [...BUILT_IN_TEMPLATES, ...(settingsConfig?.templates ?? [])],
    [settingsConfig?.templates],
  );

  // showOutline 配置变更时同步大纲面板开关
  useEffect(() => {
    setOutlineOpen(Boolean(settingsConfig?.showOutline));
  }, [settingsConfig?.showOutline]);

  const filteredNotes = useMemo(
    () =>
      filterNotesByTag(
        filterNotesWithSearchSyntax(notes, searchQuery, (note) => getDisplayTitle(note, t)),
        tagFilter,
      ),
    [notes, searchQuery, tagFilter, t],
  );
  const searchText = useMemo(() => parseNoteSearchQuery(searchQuery).text, [searchQuery]);

  useEffect(() => {
    if (searchText) {
      setWorkspaceMode("search");
    } else if (workspaceMode === "search") {
      setWorkspaceMode(null);
    }
  }, [searchText, workspaceMode]);

  // 打字时输入框优先响应：预览渲染与字数/字节统计使用延迟值
  const deferredContent = useDeferredValue(content);
  // 大纲与预览必须消费同一份延迟内容，避免快速输入标题时点到尚未渲染的锚点。
  const headings = useMemo(() => extractOutlineHeadings(deferredContent), [deferredContent]);
  const lineCount = useMemo(() => deferredContent.split("\n").length, [deferredContent]);
  const byteSize = useMemo(
    () => (new TextEncoder().encode(deferredContent).length / 1024).toFixed(1),
    [deferredContent],
  );
  const charCount = useMemo(() => countNoteChars(deferredContent), [deferredContent]);

  const { saveQueueRef, markDirty, saveCurrentNote } = useNoteSaveQueue({
    selectedId,
    content,
    title,
    isExternal,
    saveState,
    setSaveState,
    settingsConfig,
    selectedIdRef,
    titleValueRef,
    contentValueRef,
    tagsValueRef,
    pinnedValueRef,
    notesRef,
    externalFilesRef,
    saveStateRef,
    editRevisionRef,
    externalFileMtimeRef,
    lastExternalSaveRef,
    isExternalRef,
    windowLabelRef,
    replaceNoteMetadata,
    t,
  });

  const {
    collapsedCategories,
    setCollapsedCategories,
    activeCategory,
    setActiveCategory,
    showCategoryInput,
    setShowCategoryInput,
    categoryInputValue,
    setCategoryInputValue,
    renamingCategory,
    setRenamingCategory,
    renameCategoryValue,
    setRenameCategoryValue,
    expandCategory,
    handleCreateCategory,
    handleRenameCategory,
    handleDeleteCategory,
    toggleCategoryCollapse,
  } = useCategoryManagement(refreshNotes, setCategories);

  const {
    sidebarActionOrder,
    sidebarCategoryOrder,
    handleOpenSettings,
    handleCloseSettings,
    openSettingsFromPalette,
    handleMigrateDataDir,
    handleSettingsChange,
    reorderSidebarAction,
    reorderSidebarCategory,
  } = useSettingsManagement({
    t,
    settingsOpen,
    setSettingsOpen,
    settingsConfig,
    setSettingsConfig,
    savedDataDir,
    setSavedDataDir,
    categories,
    editRevisionRef,
    setViewMode,
    setIsLoading,
    saveCurrentNote,
    refreshImageBaseDir,
    refreshNotes,
    loadNote,
    clearCurrentNote,
    closeAllSidePanels,
    setAboutOpen,
  });

  const categoryGroups = useMemo(() => {
    const groups = groupNotesByCategory(
      filteredNotes.filter((note) => note.category !== INBOX_CATEGORY),
      categories.filter((category) => category !== INBOX_CATEGORY),
    );
    const positions = new Map(sidebarCategoryOrder.map((category, index) => [category, index]));
    return [...groups].sort((left, right) => {
      if (!left.category) return -1;
      if (!right.category) return 1;
      return (
        (positions.get(left.category) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.category) ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }, [filteredNotes, categories, sidebarCategoryOrder]);
  const inboxCount = useMemo(
    () => notes.filter((note) => note.category === INBOX_CATEGORY).length,
    [notes],
  );

  const {
    handleNewNote,
    handleToggleTodo,
    handleOpenDailyNote,
    handleRestoreNoteVersion,
    handleImportNote,
    handleSelectNote,
    handleSelectExternalFile,
    handleRemoveExternalFile,
    handleDeleteNote,
    handleMoveNote,
    handleMergeNotes,
    handleOpenWorkspaceNote,
    handleCreateNoteWithTitle,
    ensureNoteSaved,
  } = useNoteOperations({
    t,
    loadEpoch,
    selectedId,
    title,
    content,
    isExternal,
    saveState,
    notes,
    externalFiles,
    templates,
    selectedTemplateId,
    activeCategory,
    searchText,
    contentRef,
    selectedIdRef,
    titleValueRef,
    contentValueRef,
    tagsValueRef,
    pinnedValueRef,
    saveStateRef,
    editRevisionRef,
    externalFileMtimeRef,
    setExternalFiles,
    setIsLoading,
    setSelectedId,
    setTitle,
    setContent,
    setNoteTags,
    setIsPinned,
    setExternalImageBaseDir,
    setSaveState,
    setNoteTransitionKey,
    setDeleteConfirm,
    setActiveCategory,
    setNoteMenuClosing,
    expandCategory,
    applyNote,
    replaceNoteMetadata,
    loadNote,
    refreshNotes,
    clearCurrentNote,
    saveCurrentNote,
    navPush: navHistory.push,
    navRemove: navHistory.remove,
  });

  handleSelectExternalFileRef.current = handleSelectExternalFile;
  handleSelectNoteRef.current = async (id: string) => {
    if (externalFilesRef.current.some((file) => file.id === id)) {
      return handleSelectExternalFileRef.current(id);
    }
    return handleSelectNote(id);
  };

  useMainWindowSync({
    t,
    loadEpoch,
    saveQueueRef,
    saveStateRef,
    selectedIdRef,
    selectedNoteRef,
    isExternalRef,
    contentValueRef,
    editRevisionRef,
    externalFileMtimeRef,
    lastExternalSaveRef,
    windowLabelRef,
    contentRef,
    handleSelectNoteRef,
    selectedExternalFile,
    setIsLoading,
    setSettingsConfig,
    setSavedDataDir,
    setViewMode,
    setNotes,
    setCategories,
    setCollapsedCategories,
    setContent,
    setSaveState,
    setSettingsOverlay,
    setPinnedTileIds,
    setRemindersRefreshKey,
    setIsMaximized,
    applyNote,
    replaceNoteMetadata,
    loadNote,
    refreshNotes,
    clearCurrentNote,
    loadExternalFile,
    openAboutPanel,
    navPush: navHistory.push,
    navReplaceCurrent: navHistory.replaceCurrent,
    takeStartupFile,
  });

  useMainWindowShortcuts({
    commandPaletteShortcut: settingsConfig?.commandPaletteShortcut,
    closeTabShortcut: settingsConfig?.closeTabShortcut,
    paletteOpenRef,
    openCommandPalette,
    closeCommandPalette,
    onSave: () => {
      void saveCurrentNote(true);
    },
    onCloseTab: () => {
      void (async () => {
        // 关闭标签前先落盘：防抖窗口内的输入不能静默丢弃，保存失败则保留编辑器。
        // dirty 与 error（上次保存失败）都需要强制重试保存
        const needsSave = saveStateRef.current === "dirty" || saveStateRef.current === "error";
        const saved = needsSave ? await saveCurrentNote(true) : true;
        if (saved) clearCurrentNote();
      })();
    },
    onGoBack: () => {
      const noteId = navHistory.goBack();
      if (noteId) void handleSelectNoteRef.current(noteId);
    },
    onGoForward: () => {
      const noteId = navHistory.goForward();
      if (noteId) void handleSelectNoteRef.current(noteId);
    },
  });

  const [isResizingSidebar, setIsResizingSidebar] = useColumnResize((event) => {
    setSidebarWidth(Math.min(Math.max(event.clientX, 180), 500));
  });
  const [isResizingSplit, setIsResizingSplit] = useColumnResize((event) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    setSplitRatio(Math.min(Math.max(ratio, 0.2), 0.8));
  });

  const { handleEditorScroll, handlePreviewScroll } = useSplitScrollSync({
    contentRef,
    previewScrollRef,
    splitContainerRef,
    effectiveViewMode,
    scrollSyncEnabled: settingsConfig?.splitScrollSync ?? true,
    deferredContent,
    selectedId,
    fontSize: settingsConfig?.fontSize,
    renderHtmlMarkdown: settingsConfig?.renderHtmlMarkdown,
    splitRatio,
  });

  const {
    sidebarScrollRef,
    activeSidebarPointerDrag,
    dragOverCategory,
    consumeSidebarPointerClick,
    beginSidebarPointerDrag,
    beginSidebarNotePointerDrag,
    sidebarActionDragClass,
  } = useSidebarPointerDrag({
    onReorderAction: reorderSidebarAction,
    onReorderCategory: reorderSidebarCategory,
    onMoveNote: (noteId, targetCategory) => {
      void handleMoveNote(noteId, targetCategory);
    },
  });

  const {
    handlePaste: imagePasteHandler,
    handleDrop: imageDropHandler,
    handleDragOver: imageDragOverHandler,
  } = useImagePaste({
    noteId: selectedId,
    textareaRef: contentRef,
    setContent,
    markDirty,
    onEnsureNoteSaved: ensureNoteSaved,
    disabled: isExternal,
    onError: showToast,
    t,
  });

  const {
    handleSaveAsTemplate,
    handleExportHtml,
    handleExportPdf,
    handleNoteMenuAction,
    handleCleanUnusedImages,
    handleUndo,
    handleRedo,
    handleCopyStableLink,
    handleOpenWikiLink,
    handleInsertWikiLink,
    handlePinEntry,
  } = useEditorActions({
    t,
    selectedId,
    title,
    content,
    isExternal,
    selectedNote,
    selectedExternalFile,
    noteMenuTarget,
    settingsConfig,
    allowRawHtml,
    imageBaseDir,
    externalImageBaseDir,
    activeCategory,
    pinnedTileIds,
    contentRef,
    titleValueRef,
    contentValueRef,
    notesRef,
    setContent,
    setExternalFiles,
    setPinnedTileIds,
    setSelectedTemplateId,
    setNoteMenuClosing,
    setNoteMenuMode,
    markDirty,
    saveCurrentNote,
    handleSettingsChange,
    handleSelectNote,
    handleDeleteNote,
    applyNote,
    replaceNoteMetadata,
    navPush: navHistory.push,
    navRemove: navHistory.remove,
  });

  const handleOpenAbout = useCallback(() => {
    setAboutOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setSettingsOpen(false);
        setKnowledgeGraphOpen(false);
        dismissUpdateReminderText();
      }
      return nextOpen;
    });
  }, [dismissUpdateReminderText]);

  const handleToggleTodos = useCallback(() => {
    setTodosOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setSettingsOpen(false);
        setAboutOpen(false);
        setHistoryOpen(false);
        setBacklinksOpen(false);
        setKnowledgeGraphOpen(false);
      }
      return nextOpen;
    });
  }, []);

  const handleToggleLibrary = useCallback(() => {
    setSettingsOpen(false);
    setAboutOpen(false);
    setTodosOpen(false);
    setHistoryOpen(false);
    setBacklinksOpen(false);
    setRemindersOpen(false);
    setKnowledgeGraphOpen(false);
    setWorkspaceMode(null);
    setLibraryOpen((open) => !open);
  }, []);

  const toggleMaximize = () => {
    void toggleMaximizeCurrentWindow().then(() => isCurrentWindowMaximized().then(setIsMaximized));
  };

  const handleTitleBarMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.button !== 0) return;
    if (event.detail === 2) {
      toggleMaximize();
      return;
    }
    void startCurrentWindowDrag().catch(() => undefined);
  };

  const handleToggleOutline = () => {
    // 自动切到分栏模式 + 切换大纲
    if (effectiveViewMode === "edit") {
      setViewMode("split");
    }
    setOutlineOpen((o) => {
      const next = !o;
      if (next && settingsConfig && !settingsConfig.showOutline) {
        // 如果设置里没开，自动开启
        handleSettingsChange({ ...settingsConfig, showOutline: true });
      }
      return next;
    });
  };

  const paletteCommands = buildPaletteCommands({
    t,
    selectedId,
    isExternal,
    quickCaptureShortcut: settingsConfig?.quickCaptureShortcut,
    onNewNote: () => handleNewNote(),
    onOpenDailyNote: () => handleOpenDailyNote(),
    onOpenWorkspace: openWorkspace,
    onOpenTodos: () => {
      closeAllSidePanels();
      setTodosOpen(true);
    },
    onOpenKnowledgeGraph: () => {
      closeAllSidePanels();
      setKnowledgeGraphOpen(true);
    },
    onToggleFocusMode: () => {
      setReadingMode(false);
      setFocusMode((active) => !active);
    },
    onToggleReadingMode: () => {
      setFocusMode(false);
      setReadingMode((active) => !active);
    },
    onOpenReminders: () => {
      if (!selectedId || isExternal) return;
      closeAllSidePanels();
      setRemindersOpen(true);
    },
    onExportPdf: () => handleExportPdf(),
    onOpenSettings: openSettingsFromPalette,
    onOpenQuickCapture: async () => {
      if (saveStateRef.current === "dirty") {
        await saveCurrentNote();
      }
      await openQuickCaptureWindow().catch((error) => {
        showToast(getErrorMessage(error));
      });
    },
  });

  return (
    <div className="w-full h-screen flex flex-col">
      <div className="relative noise-bg bg-cloud overflow-hidden flex flex-col flex-1">
        <BackgroundLayer config={settingsConfig} />
        <TitleBar
          t={t}
          isMacOS={isMacOS}
          isMaximized={isMaximized}
          noteTitle={
            title ||
            selectedNote?.preview ||
            t("common.untitledNote", { defaultValue: "无标题笔记" })
          }
          aboutUpdateReminder={aboutUpdateReminder}
          onMouseDown={handleTitleBarMouseDown}
          onOpenNotepad={() =>
            void openNotepadWindow().catch((error) => showToast(getErrorMessage(error)))
          }
          onOpenSettings={() => void handleOpenSettings()}
          onOpenAbout={handleOpenAbout}
          onMinimize={() => void minimizeCurrentWindow()}
          onMaximize={toggleMaximize}
          onClose={() => void closeCurrentWindow()}
        />

        <div className="relative z-10 flex flex-1 min-h-0 main-layout-row">
          <MainSidebar
            t={t}
            sidebarCollapsed={sidebarCollapsed}
            focusMode={focusMode}
            sidebarWidth={sidebarWidth}
            isResizingSidebar={isResizingSidebar}
            onStartResizeSidebar={() => setIsResizingSidebar(true)}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            notes={notes}
            filteredNotes={filteredNotes}
            externalFiles={externalFiles}
            selectedId={selectedId}
            hoveredId={hoveredId}
            onHoverId={setHoveredId}
            tagFilter={tagFilter}
            tagFilterOpen={tagFilterOpen}
            onToggleTagFilter={() => setTagFilterOpen((open) => !open)}
            onSelectTagFilter={(tag) => setTagFilter(tag === tagFilter ? "" : tag)}
            selectedTemplateId={selectedTemplateId}
            onSelectTemplateId={setSelectedTemplateId}
            templates={templates}
            sidebarActionOrder={sidebarActionOrder}
            inboxCount={inboxCount}
            categoryGroups={categoryGroups}
            collapsedCategories={collapsedCategories}
            dragOverCategory={dragOverCategory}
            activeSidebarPointerDrag={activeSidebarPointerDrag}
            showCategoryInput={showCategoryInput}
            categoryInputValue={categoryInputValue}
            onCategoryInputValueChange={setCategoryInputValue}
            onOpenCategoryInput={() => setShowCategoryInput(true)}
            onCancelCategoryInput={() => {
              setShowCategoryInput(false);
              setCategoryInputValue("");
            }}
            onCreateCategory={() => void handleCreateCategory()}
            renamingCategory={renamingCategory}
            renameCategoryValue={renameCategoryValue}
            onRenameCategoryValueChange={setRenameCategoryValue}
            onCommitRenameCategory={(oldName) => void handleRenameCategory(oldName)}
            onCancelRenameCategory={() => setRenamingCategory(null)}
            isLoading={isLoading}
            sidebarScrollRef={sidebarScrollRef}
            consumeSidebarPointerClick={consumeSidebarPointerClick}
            beginSidebarPointerDrag={beginSidebarPointerDrag}
            beginSidebarNotePointerDrag={beginSidebarNotePointerDrag}
            sidebarActionDragClass={sidebarActionDragClass}
            onOpenDailyNote={() => void handleOpenDailyNote()}
            onOpenWorkspace={openWorkspace}
            onNewNote={(category) => void handleNewNote(category)}
            onToggleTodos={handleToggleTodos}
            onImportNote={() => void handleImportNote()}
            onSelectExternalFile={(id) => void handleSelectExternalFile(id)}
            onRemoveExternalFile={(id) => void handleRemoveExternalFile(id)}
            onSelectNote={(id) => void handleSelectNote(id)}
            onOpenNoteMenu={(event, noteId) => {
              setHoveredId(noteId);
              openNoteMenu(event, noteId);
            }}
            onToggleCategoryCollapse={toggleCategoryCollapse}
            onOpenCategoryMenu={openCategoryMenu}
          />

          <div className="flex-1 flex flex-col min-w-0">
            <EditorToolbar
              t={t}
              settingsOpen={settingsOpen}
              aboutOpen={aboutOpen}
              focusMode={focusMode}
              readingMode={readingMode}
              toolbarCollapsed={toolbarCollapsed}
              sidebarCollapsed={sidebarCollapsed}
              effectiveViewMode={effectiveViewMode}
              outlineOpen={outlineOpen}
              selectedId={selectedId}
              isExternal={isExternal}
              selectedNote={selectedNote}
              content={content}
              isPinned={isPinned}
              selectedTilePinned={selectedId ? pinnedTileIds.has(selectedId) : false}
              saveState={saveState}
              deleteConfirm={deleteConfirm}
              deleteExiting={deleteExiting}
              viewMode={viewMode}
              viewModeOptions={viewModeOptions}
              onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
              onToggleOutline={handleToggleOutline}
              onToggleHistory={() => {
                setHistoryOpen((open) => {
                  const nextOpen = !open;
                  if (nextOpen) {
                    setSettingsOpen(false);
                    setAboutOpen(false);
                    setTodosOpen(false);
                    setBacklinksOpen(false);
                    setKnowledgeGraphOpen(false);
                  }
                  return nextOpen;
                });
              }}
              onToggleBacklinks={() => {
                setBacklinksOpen((open) => {
                  const nextOpen = !open;
                  if (nextOpen) {
                    setSettingsOpen(false);
                    setAboutOpen(false);
                    setTodosOpen(false);
                    setHistoryOpen(false);
                    setKnowledgeGraphOpen(false);
                  }
                  return nextOpen;
                });
              }}
              onToggleKnowledgeGraph={() => {
                setKnowledgeGraphOpen((open) => {
                  const nextOpen = !open;
                  if (nextOpen) {
                    setSettingsOpen(false);
                    setAboutOpen(false);
                    setTodosOpen(false);
                    setHistoryOpen(false);
                    setBacklinksOpen(false);
                    setLibraryOpen(false);
                    setRemindersOpen(false);
                    setWorkspaceMode(null);
                  }
                  return nextOpen;
                });
              }}
              onCopyStableLink={() => void handleCopyStableLink()}
              onToggleReminders={() => {
                setRemindersOpen((open) => {
                  const nextOpen = !open;
                  if (nextOpen) {
                    setSettingsOpen(false);
                    setAboutOpen(false);
                    setTodosOpen(false);
                    setHistoryOpen(false);
                    setBacklinksOpen(false);
                    setKnowledgeGraphOpen(false);
                  }
                  return nextOpen;
                });
              }}
              onToggleLibrary={handleToggleLibrary}
              onToggleFocusMode={() => {
                setReadingMode(false);
                setFocusMode((active) => !active);
              }}
              onExitFocusMode={() => setFocusMode(false)}
              onToggleReadingMode={() => {
                setFocusMode(false);
                setReadingMode((active) => !active);
              }}
              onExitReadingMode={() => setReadingMode(false)}
              onSaveAsTemplate={handleSaveAsTemplate}
              onTogglePinNote={() => {
                const next = !isPinned;
                setIsPinned(next);
                pinnedValueRef.current = next;
                markDirty();
              }}
              onPinEntry={() => void handlePinEntry()}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onSave={() => void saveCurrentNote(true)}
              onExportHtml={() => void handleExportHtml()}
              onExportPdf={() => void handleExportPdf()}
              onRequestDelete={() => setDeleteConfirm(true)}
              onConfirmDelete={() => {
                setDeleteExiting(true);
                setTimeout(() => {
                  setDeleteExiting(false);
                  setDeleteConfirm(false);
                  void handleDeleteNote();
                }, 150);
              }}
              onCancelDelete={() => {
                setDeleteExiting(true);
                setTimeout(() => {
                  setDeleteExiting(false);
                  setDeleteConfirm(false);
                }, 150);
              }}
              onViewModeChange={setViewMode}
              onSetToolbarCollapsed={setToolbarCollapsed}
              onToggleToolbarCollapsed={() => setToolbarCollapsed((collapsed) => !collapsed)}
            />

            <NoteHeader
              t={t}
              noteTransitionKey={noteTransitionKey}
              focusMode={focusMode}
              title={title}
              selectedId={selectedId}
              isExternal={isExternal}
              noteTags={noteTags}
              selectedExternalFile={selectedExternalFile}
              selectedNote={selectedNote}
              charCount={charCount}
              saveState={saveState}
              saveStateLabel={saveStateLabel}
              contentRef={contentRef}
              onTitleChange={(nextTitle) => {
                setTitle(nextTitle);
                markDirty();
              }}
              onTagsChange={(newTags) => {
                setNoteTags(newTags);
                tagsValueRef.current = newTags;
                markDirty();
              }}
            />

            <EditorPane
              t={t}
              effectiveViewMode={effectiveViewMode}
              splitContainerRef={splitContainerRef}
              contentRef={contentRef}
              previewScrollRef={previewScrollRef}
              selectedId={selectedId}
              isLoading={isLoading}
              isExternal={isExternal}
              notes={notes}
              focusMode={focusMode}
              settingsOpen={settingsOpen}
              aboutOpen={aboutOpen}
              splitRatio={splitRatio}
              isResizingSplit={isResizingSplit}
              onStartResizeSplit={() => setIsResizingSplit(true)}
              toolbarButtons={toolbarButtons}
              content={content}
              deferredContent={deferredContent}
              contentValueRef={contentValueRef}
              onContentChange={(nextContent) => {
                setContent(nextContent);
                markDirty();
              }}
              setContent={setContent}
              markDirty={markDirty}
              fontSize={settingsConfig?.fontSize ?? 14}
              allowRawHtml={allowRawHtml}
              imageBaseDir={imageBaseDir}
              externalImageBaseDir={externalImageBaseDir}
              selectedExternalFile={selectedExternalFile}
              outlineOpen={outlineOpen}
              headings={headings}
              onToggleOutline={() => setOutlineOpen((o) => !o)}
              onCloseOutline={() => setOutlineOpen(false)}
              onPaste={imagePasteHandler}
              onDrop={imageDropHandler}
              onDragOver={imageDragOverHandler}
              onEditorScroll={handleEditorScroll}
              onPreviewScroll={handlePreviewScroll}
              onOpenWikiLink={handleOpenWikiLink}
            />

            <StatusBar
              t={t}
              focusMode={focusMode}
              canGoBack={navHistory.canGoBack}
              canGoForward={navHistory.canGoForward}
              lineCount={lineCount}
              byteSize={byteSize}
              showCleanUnusedImages={Boolean(
                selectedId && !isExternal && content.includes("images/"),
              )}
              onGoBack={() => {
                const noteId = navHistory.goBack();
                if (noteId) void handleSelectNoteRef.current(noteId);
              }}
              onGoForward={() => {
                const noteId = navHistory.goForward();
                if (noteId) void handleSelectNoteRef.current(noteId);
              }}
              onCleanUnusedImages={() => void handleCleanUnusedImages()}
            />
          </div>

          <MainWindowSidePanels
            visibleSidePanel={visibleSidePanel}
            initialMountedPanel={initialSettingsOpen && initialConfig ? "settings" : null}
            settingsOpen={settingsOpen}
            settingsOverlay={settingsOverlay}
            settingsConfig={settingsConfig}
            selectedId={selectedId}
            isExternal={isExternal}
            title={title}
            notes={notes}
            categories={categories}
            workspaceMode={workspaceMode}
            searchText={searchText}
            remindersRefreshKey={remindersRefreshKey}
            onCloseAbout={() => setAboutOpen(false)}
            onCloseSettings={handleCloseSettings}
            onSettingsChange={handleSettingsChange}
            onMigrateDataDir={() => void handleMigrateDataDir()}
            onCloseHistory={() => setHistoryOpen(false)}
            onRestoreNoteVersion={handleRestoreNoteVersion}
            onCloseBacklinks={() => setBacklinksOpen(false)}
            onOpenBacklinkNote={(noteId) => {
              setBacklinksOpen(false);
              void handleSelectNote(noteId);
            }}
            onInsertRelatedLink={handleInsertWikiLink}
            onCloseReminders={() => setRemindersOpen(false)}
            onCloseLibrary={() => setLibraryOpen(false)}
            onBeforeRestoreBackup={async () => {
              // 恢复会替换整个数据目录：先把当前编辑落盘，内容进入恢复前自动备份，
              // 即使恢复失败也能从保护备份找回，不会丢未保存的修改。
              // dirty 与 error 状态都需要强制重试保存
              const needsSave =
                saveStateRef.current === "dirty" || saveStateRef.current === "error";
              const saved = needsSave ? await saveCurrentNote(true) : true;
              if (!saved) {
                showToast("当前笔记保存失败，已取消恢复");
              }
              return saved;
            }}
            onRestoredBackup={() => {
              setLibraryOpen(false);
              void refreshNotes();
              clearCurrentNote();
            }}
            onCloseTodos={() => setTodosOpen(false)}
            onOpenTodoNote={(noteId) => {
              setTodosOpen(false);
              void handleSelectNote(noteId);
            }}
            onToggleTodo={handleToggleTodo}
            onCloseWorkspace={() => setWorkspaceMode(null)}
            onOpenWorkspaceNote={(noteId, hit) => {
              if (workspaceMode !== "search") setWorkspaceMode(null);
              void handleOpenWorkspaceNote(noteId, hit?.matchStart, hit?.matchLength);
            }}
            onMoveNote={(noteId, category) => void handleMoveNote(noteId, category)}
            onMergeNotes={(targetId, sourceId) => void handleMergeNotes(targetId, sourceId)}
            onWeeklyReviewCreated={(note) => {
              replaceNoteMetadata(note);
              applyNote(note);
              setWorkspaceMode(null);
            }}
            onCloseKnowledgeGraph={() => setKnowledgeGraphOpen(false)}
            onOpenKnowledgeGraphNote={(noteId) => {
              setKnowledgeGraphOpen(false);
              void handleSelectNoteRef.current(noteId);
            }}
          />
        </div>
      </div>

      <SidebarContextMenus
        t={t}
        noteMenu={noteMenu}
        noteMenuTarget={noteMenuTarget}
        noteMenuClosing={noteMenuClosing}
        noteMenuMode={noteMenuMode}
        noteMenuRef={noteMenuRef}
        noteMenuPosition={noteMenuPosition}
        noteContextMenuItems={noteContextMenuItems}
        categories={categories}
        onSetNoteMenuMode={setNoteMenuMode}
        onNoteMenuAction={handleNoteMenuAction}
        onMoveNote={(noteId, targetCategory) => void handleMoveNote(noteId, targetCategory)}
        categoryMenu={categoryMenu}
        categoryMenuClosing={categoryMenuClosing}
        categoryMenuConfirmDelete={categoryMenuConfirmDelete}
        categoryMenuHoverSuppressed={categoryMenuHoverSuppressed}
        categoryMenuRef={categoryMenuRef}
        categoryMenuPosition={categoryMenuPosition}
        onSwitchCategoryMenuPanel={switchCategoryMenuPanel}
        onConfirmDeleteCategory={(category) => {
          void handleDeleteCategory(category);
          setCategoryMenuClosing(true);
        }}
        onStartRenameCategory={(category) => {
          setCategoryMenuClosing(true);
          setRenamingCategory(category);
          setRenameCategoryValue(category);
        }}
      />

      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            notes={notes}
            commands={paletteCommands}
            onSelectNote={(noteId, matchStart, matchLength) => {
              void handleOpenWorkspaceNote(noteId, matchStart, matchLength);
            }}
            onCreateNote={handleCreateNoteWithTitle}
            onClose={closeCommandPalette}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
