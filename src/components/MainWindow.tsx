import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
  lazy,
} from "react";
import type { MouseEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { exportMarkdownNote, importMarkdownNote } from "../features/importExport/api";
import { MarkdownPreviewLazy as MarkdownPreview } from "../features/markdown/MarkdownPreviewLazy";
import { showToast } from "./Toast";
import {
  blockIndexAtOffset,
  measureBlockOffsets,
  tagPreviewBlocks,
} from "../features/markdown/scrollSync";
import {
  chooseDataDirectory,
  getConfig,
  migrateDataDir,
  normalizeViewMode,
  saveConfig,
} from "../features/settings/api";
import type { AppConfig, NoteTemplate, ViewMode } from "../features/settings/types";
import { normalizeTileColor } from "../features/settings/tileColor";
import { getUpdateStatus, reportInstallPreparation } from "../features/update/api";
import {
  ABOUT_UPDATE_LABEL_DURATION_MS,
  applyAboutUpdateStatus,
  createAboutUpdateReminderState,
  dismissAboutUpdateReminderText,
  type AboutUpdateReminderState,
} from "../features/update/presentation";
import type {
  UpdateErrorPayload,
  UpdateInstallPrepareRequest,
  UpdateState,
} from "../features/update/types";
import { BackgroundLayer } from "./BackgroundLayer";
import { POPUP_VIEWPORT_MARGIN, useViewportPopupPosition } from "./popupPosition";
import { SlidingButtonGroup } from "./SlidingButtonGroup";
import { TodoPanel } from "./TodoPanel";
import { NoteHistoryPanel } from "./NoteHistoryPanel";
import { BacklinksPanel } from "./BacklinksPanel";
import { ReminderPanel } from "./ReminderPanel";
import {
  createNote,
  createCategory,
  deleteCategory,
  openDailyNote,
  restoreNoteVersion,
  deleteNote,
  getErrorMessage,
  getFileModifiedTime,
  getNote,
  listCategories,
  listNotes,
  moveNoteCategory,
  readExternalFile,
  renameCategory,
  saveExternalFile,
  updateNote,
} from "../features/notes/api";
import { cleanUnusedImages, saveImageFromPath } from "../features/images/api";
import { useImagePaste, insertTextAtCursor } from "../features/images/useImagePaste";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import type { ExternalFile, Note, NoteMetadata, Reminder } from "../features/notes/types";
import {
  collectAllTags,
  countNoteChars,
  filterNotesByTag,
  formatShortDate,
  formatTime,
  getDisplayTitle,
  groupNotesByCategory,
  metadataFromNote,
} from "../features/notes/noteUtils";
import type { CategoryGroup } from "../features/notes/noteUtils";
import {
  filterNotesWithSearchSyntax,
  toggleTodoInContent,
  type TodoItem,
} from "../features/notes/todoUtils";
import { resolveWikiLink, wikiLinkSyntax } from "../features/notes/wikiLinks";
import {
  getNoteContextMenuItems,
  type NoteContextMenuAction,
} from "../features/notes/noteContextMenu";
import { openNotepadWindow, takeStartupFile, toggleTileWindow } from "../features/windows/api";
import {
  closeCurrentWindow,
  minimizeCurrentWindow,
  toggleMaximizeCurrentWindow,
  isCurrentWindowMaximized,
  startCurrentWindowDrag,
} from "../features/windows/controls";
import {
  TILE_WINDOW_CLOSED_EVENT,
  TILE_WINDOW_UNPINNED_EVENT,
  syncPinnedTileIds,
} from "../features/windows/tileWindowEvents";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type SidePanelMode = "about" | "settings" | "todos" | "history" | "backlinks" | "reminders";

const BUILT_IN_TEMPLATES: NoteTemplate[] = [
  { id: "daily", name: "今日计划", content: "# {{date}}\n\n## 待办\n- [ ] \n\n## 随手记\n" },
  {
    id: "reading",
    name: "阅读笔记",
    content: "# 书名 / 文章\n\n## 摘录\n\n## 想法\n\n## 行动\n- [ ] ",
  },
  {
    id: "meeting",
    name: "会议记录",
    content: "# 会议主题\n\n时间：{{date}}\n\n## 结论\n\n## 待办\n- [ ] ",
  },
];

function renderTemplateContent(content: string): string {
  const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date());
  return content.replace(/\{\{date\}\}/g, date);
}

// 侧面板只在用户主动打开时挂载，懒加载可把关于面板（贡献者数据、更新设置）
// 和设置面板从首屏 bundle 中拆出
const AboutPanel = lazy(() =>
  import("./AboutPanel").then((module) => ({ default: module.AboutPanel })),
);
const SettingsPanel = lazy(() =>
  import("./SettingsPanel").then((module) => ({ default: module.SettingsPanel })),
);

interface NoteMenuState {
  x: number;
  y: number;
  noteId: string;
}

interface CategoryMenuState {
  x: number;
  y: number;
  category: string;
}

type FormatAction =
  | "bold"
  | "italic"
  | "heading"
  | "hr"
  | "ul"
  | "ol"
  | "code"
  | "quote"
  | "inlineMath"
  | "blockMath";

function applyFormat(
  textarea: HTMLTextAreaElement,
  action: FormatAction,
  translate: TFunction,
  setContent: (v: string) => void,
  markDirty: () => void,
) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  const lineStart = before.lastIndexOf("\n") + 1;
  const currentLine = before.slice(lineStart);

  let result: string;
  let cursorStart: number;
  let cursorEnd: number;

  switch (action) {
    case "bold": {
      const fallback = translate("main.formatSample.boldText", { defaultValue: "粗体文本" });
      const wrapped = `**${selected || fallback}**`;
      result = before + wrapped + after;
      cursorStart = start + 2;
      cursorEnd = cursorStart + (selected || fallback).length;
      break;
    }
    case "italic": {
      const fallback = translate("main.formatSample.italicText", { defaultValue: "斜体文本" });
      const wrapped = `*${selected || fallback}*`;
      result = before + wrapped + after;
      cursorStart = start + 1;
      cursorEnd = cursorStart + (selected || fallback).length;
      break;
    }
    case "heading": {
      const prefix = currentLine.match(/^(#{1,5})\s/);
      if (prefix) {
        const newLevel = prefix[1].length < 5 ? "#".repeat(prefix[1].length + 1) : "#";
        const beforeLine = value.slice(0, lineStart);
        const afterPrefix = value.slice(lineStart + prefix[0].length);
        result = beforeLine + newLevel + " " + afterPrefix;
        const offset = newLevel.length + 1 - prefix[0].length;
        cursorStart = start + offset;
        cursorEnd = end + offset;
      } else if (currentLine.length > 0 && start === end) {
        result = value.slice(0, lineStart) + "## " + value.slice(lineStart);
        cursorStart = start + 3;
        cursorEnd = cursorStart;
      } else if (selected) {
        result = before + `## ${selected}` + after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + selected.length;
      } else {
        result =
          before +
          `## ${translate("main.formatSample.headingText", { defaultValue: "标题" })}` +
          after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + 2;
      }
      break;
    }
    case "hr": {
      const newlineBefore = before.endsWith("\n") || before === "" ? "" : "\n";
      const newlineAfter = after.startsWith("\n") || after === "" ? "" : "\n";
      result = before + `${newlineBefore}---${newlineAfter}` + after;
      cursorStart = cursorEnd = before.length + newlineBefore.length + 3;
      break;
    }
    case "ul": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l) => `- ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.listItem", { defaultValue: "列表项" });
        const item = `- ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 2;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "ol": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l, i) => `${i + 1}. ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.listItem", { defaultValue: "列表项" });
        const item = `1. ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "code": {
      if (selected.includes("\n")) {
        const wrapped = "```\n" + selected + "\n```";
        result = before + wrapped + after;
        cursorStart = start + 4;
        cursorEnd = cursorStart + selected.length;
      } else {
        const fallback = translate("main.formatSample.codeText", { defaultValue: "代码" });
        const wrapped = `\`${selected || fallback}\``;
        result = before + wrapped + after;
        cursorStart = start + 1;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "quote": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.quoteText", { defaultValue: "引用文本" });
        const item = `> ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 2;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "inlineMath": {
      const wrapped = `$${selected || "E=mc^2"}$`;
      result = before + wrapped + after;
      cursorStart = start + 1;
      cursorEnd = cursorStart + (selected || "E=mc^2").length;
      break;
    }
    case "blockMath": {
      const wrapped = `\n$$\n${selected || "x^2 + y^2 = r^2"}\n$$\n`;
      result = before + wrapped + after;
      cursorStart = start + 4;
      cursorEnd = cursorStart + (selected || "x^2 + y^2 = r^2").length;
      break;
    }
  }

  textarea.focus();
  textarea.setSelectionRange(0, value.length);
  document.execCommand("insertText", false, result);
  setContent(result);
  markDirty();
  requestAnimationFrame(() => {
    textarea.setSelectionRange(cursorStart, cursorEnd);
  });
}

function runEditorCommand(textarea: HTMLTextAreaElement | null, command: "undo" | "redo"): boolean {
  if (!textarea || textarea.disabled) return false;
  textarea.focus();
  return document.execCommand(command);
}

export function pinTileButtonTitle(isPinned: boolean): string {
  return isPinned ? "取消钉屏" : "钉到屏幕";
}

interface LoadEpoch {
  // 开始一次新的异步加载，返回本次 epoch token；之后用 isCurrent 校验是否仍然有效
  bump: () => number;
  // 只读取当前 epoch 而不自增：用于"记录事件到达瞬间的代次，期间若发生切换则过期"
  peek: () => number;
  // 异步完成后调用：仅当期间未发生新的 bump（用户未切换/重载）时为 true
  isCurrent: (token: number) => boolean;
}

// 统一封装"加载竞态守卫"：每次切换/加载笔记自增 epoch，异步结果回来后用
// isCurrent 判断是否过期。集中此处后，新增异步加载路径只需 bump/isCurrent 两步，
// 避免裸 ref 在多处内联导致的"忘记连线 → stale 结果覆盖新选中"竞态回归
function useLoadEpoch(): LoadEpoch {
  const ref = useRef(0);
  return useMemo<LoadEpoch>(
    () => ({
      bump: () => (ref.current += 1),
      peek: () => ref.current,
      isCurrent: (token: number) => ref.current === token,
    }),
    [],
  );
}

interface MainWindowProps {
  initialSettingsOpen?: boolean;
  initialConfig?: AppConfig;
}

export function MainWindow({
  initialSettingsOpen = false,
  initialConfig = undefined,
}: MainWindowProps = {}) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [externalFiles, setExternalFiles] = useState<ExternalFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [noteTags, setNoteTags] = useState<string[]>([]);
  const [isPinned, setIsPinned] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(
    normalizeViewMode(initialConfig?.defaultViewMode ?? "split"),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [noteMenu, setNoteMenu] = useState<NoteMenuState | null>(null);
  const [noteMenuClosing, setNoteMenuClosing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [todosOpen, setTodosOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [mountedSidePanel, setMountedSidePanel] = useState<SidePanelMode | null>(
    initialSettingsOpen && initialConfig ? "settings" : null,
  );
  const [sidePanelContentVisible, setSidePanelContentVisible] = useState(
    Boolean(initialSettingsOpen && initialConfig),
  );
  const [aboutUpdateReminder, setAboutUpdateReminder] = useState<AboutUpdateReminderState>(() =>
    createAboutUpdateReminderState(null),
  );
  const [settingsConfig, setSettingsConfig] = useState<AppConfig | null>(initialConfig ?? null);
  const [savedDataDir, setSavedDataDir] = useState<string | null>(initialConfig?.dataDir ?? null);
  const [noteTransitionKey, setNoteTransitionKey] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteExiting, setDeleteExiting] = useState(false);
  const [pinnedTileIds, setPinnedTileIds] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<string[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [showCategoryInput, setShowCategoryInput] = useState(false);
  const [categoryInputValue, setCategoryInputValue] = useState("");
  const [noteMenuMode, setNoteMenuMode] = useState<"main" | "move">("main");
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renameCategoryValue, setRenameCategoryValue] = useState("");
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const [settingsOverlay, setSettingsOverlay] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 1080 : true,
  );
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [categoryMenu, setCategoryMenu] = useState<CategoryMenuState | null>(null);
  const [categoryMenuClosing, setCategoryMenuClosing] = useState(false);
  const [categoryMenuConfirmDelete, setCategoryMenuConfirmDelete] = useState(false);
  const [categoryMenuHoverSuppressed, setCategoryMenuHoverSuppressed] = useState(false);
  const { popupRef: noteMenuRef, popupPosition: noteMenuPosition } = useViewportPopupPosition(
    noteMenu,
    `${noteMenuMode}:${categories.length}`,
  );
  const { popupRef: categoryMenuRef, popupPosition: categoryMenuPosition } =
    useViewportPopupPosition(categoryMenu, categoryMenuConfirmDelete);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const windowLabelRef = useRef("main");
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const blockOffsets = useRef<number[]>([]);
  const scrollSource = useRef<"editor" | "preview" | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureRafRef = useRef<number>(0);
  const measureControllerRef = useRef<AbortController | null>(null);
  const prevSelectedIdRef = useRef(selectedId);
  const externalFileMtimeRef = useRef<number>(0);
  const lastExternalSaveRef = useRef<number>(0);
  const imageBaseDir = useImageBaseDir();
  const saveStateRef = useRef(saveState);
  const isMacOS = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      (/Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac"))
    );
  }, []);
  saveStateRef.current = saveState;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const titleValueRef = useRef(title);
  titleValueRef.current = title;
  const tagsValueRef = useRef(noteTags);
  tagsValueRef.current = noteTags;
  const pinnedValueRef = useRef(isPinned);
  pinnedValueRef.current = isPinned;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const externalFilesRef = useRef(externalFiles);
  externalFilesRef.current = externalFiles;
  // 每次"应用/切换当前笔记"都会自增；异步加载完成后若 epoch 已变化，说明用户
  // 已切换到别处，该次结果直接丢弃，避免旧的加载结果覆盖新选中的笔记
  const loadEpoch = useLoadEpoch();
  // 串行化所有保存请求，避免自动保存与切换触发的保存并发写同一篇笔记
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  );
  const selectedNoteRef = useRef(selectedNote);
  selectedNoteRef.current = selectedNote;

  const selectedExternalFile = useMemo(
    () => externalFiles.find((f) => f.id === selectedId) ?? null,
    [externalFiles, selectedId],
  );
  const updateStatusHydratedRef = useRef(false);

  const isExternal = selectedExternalFile !== null;
  const isExternalRef = useRef(isExternal);
  isExternalRef.current = isExternal;

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
  const toolbarButtons = useMemo<
    { label: string; title: string; style: string; action: FormatAction }[]
  >(
    () => [
      {
        label: "B",
        title: t("main.toolbar.bold", { defaultValue: "粗体" }),
        style: "font-bold",
        action: "bold",
      },
      {
        label: "I",
        title: t("main.toolbar.italic", { defaultValue: "斜体" }),
        style: "italic",
        action: "italic",
      },
      {
        label: "H",
        title: t("main.toolbar.heading", { defaultValue: "标题" }),
        style: "font-bold",
        action: "heading",
      },
      {
        label: "—",
        title: t("main.toolbar.hr", { defaultValue: "分割线" }),
        style: "",
        action: "hr",
      },
      {
        label: "•",
        title: t("main.toolbar.ul", { defaultValue: "无序列表" }),
        style: "",
        action: "ul",
      },
      {
        label: "1.",
        title: t("main.toolbar.ol", { defaultValue: "有序列表" }),
        style: "font-mono text-[9px]",
        action: "ol",
      },
      {
        label: "<>",
        title: t("main.toolbar.code", { defaultValue: "代码" }),
        style: "font-mono text-[9px]",
        action: "code",
      },
      {
        label: "❝",
        title: t("main.toolbar.quote", { defaultValue: "引用" }),
        style: "",
        action: "quote",
      },
      {
        label: "∑",
        title: t("main.toolbar.inlineMath", { defaultValue: "行内公式" }),
        style: "font-mono text-[11px]",
        action: "inlineMath",
      },
      {
        label: "∫",
        title: t("main.toolbar.blockMath", { defaultValue: "块级公式" }),
        style: "font-mono text-[11px]",
        action: "blockMath",
      },
    ],
    [t],
  );
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
  const syncUpdateStatus = useCallback((nextStatus: UpdateState) => {
    const shouldHydrate = !updateStatusHydratedRef.current;
    if (shouldHydrate) {
      updateStatusHydratedRef.current = true;
    }

    setAboutUpdateReminder((current) =>
      shouldHydrate
        ? createAboutUpdateReminderState(nextStatus)
        : applyAboutUpdateStatus(current, nextStatus),
    );
  }, []);
  const visibleSidePanel: SidePanelMode | null = aboutOpen
    ? "about"
    : todosOpen
      ? "todos"
      : historyOpen && selectedId && !isExternal
        ? "history"
        : backlinksOpen && selectedId && !isExternal
          ? "backlinks"
          : remindersOpen && selectedId && !isExternal
            ? "reminders"
            : settingsOpen && settingsConfig
          ? "settings"
          : null;
  const sidePanelExpanded = visibleSidePanel !== null;
  const openAboutPanel = useCallback(() => {
    setSettingsOpen(false);
    setAboutOpen(true);
    setAboutUpdateReminder((current) => dismissAboutUpdateReminderText(current));
  }, []);

  const templates = useMemo(
    () => [...BUILT_IN_TEMPLATES, ...(settingsConfig?.templates ?? [])],
    [settingsConfig?.templates],
  );

  const filteredNotes = useMemo(
    () =>
      filterNotesByTag(
        filterNotesWithSearchSyntax(notes, searchQuery, (note) => getDisplayTitle(note, t)),
        tagFilter,
      ),
    [notes, searchQuery, tagFilter, t],
  );

  const categoryGroups = useMemo(
    () => groupNotesByCategory(filteredNotes, categories),
    [filteredNotes, categories],
  );

  // 打字时输入框优先响应：预览渲染与字数/字节统计使用延迟值，
  // 连续输入期间 React 会自动合并这些重计算，停顿时再追上
  const deferredContent = useDeferredValue(content);

  const lineCount = useMemo(() => deferredContent.split("\n").length, [deferredContent]);
  const byteSize = useMemo(
    () => (new TextEncoder().encode(deferredContent).length / 1024).toFixed(1),
    [deferredContent],
  );
  const charCount = useMemo(() => countNoteChars(deferredContent), [deferredContent]);

  const applyNote = useCallback(
    (note: Note) => {
      loadEpoch.bump();
      selectedIdRef.current = note.id;
      titleValueRef.current = note.title;
      contentValueRef.current = note.content;
      saveStateRef.current = "saved";
      setSelectedId(note.id);
      setTitle(note.title);
      setContent(note.content);
      setSaveState("saved");
      setNoteTransitionKey((k) => k + 1);
      const nextTags = note.tags || [];
      const nextPinned = note.pinned || false;
      tagsValueRef.current = nextTags;
      pinnedValueRef.current = nextPinned;
      setNoteTags(nextTags);
      setIsPinned(nextPinned);
    },
    [loadEpoch],
  );

  const replaceNoteMetadata = useCallback((note: Note) => {
    const metadata = metadataFromNote(note);
    setNotes((current) => {
      const exists = current.some((item) => item.id === metadata.id);
      const next = exists
        ? current.map((item) => (item.id === metadata.id ? metadata : item))
        : [metadata, ...current];
      return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }, []);

  const loadNote = useCallback(
    async (id: string) => {
      const epoch = loadEpoch.bump();
      const note = await getNote(id);
      // 加载期间用户又切换/加载了别的笔记，丢弃本次结果
      if (!loadEpoch.isCurrent(epoch)) return;
      applyNote(note);
      replaceNoteMetadata(note);
    },
    [applyNote, replaceNoteMetadata, loadEpoch],
  );

  const refreshNotes = useCallback(async () => {
    const [loadedNotes, loadedCategories] = await Promise.all([listNotes(), listCategories()]);
    setNotes(loadedNotes);
    setCategories(loadedCategories);
    return loadedNotes;
  }, []);

  const clearCurrentNote = useCallback(() => {
    loadEpoch.bump();
    selectedIdRef.current = null;
    titleValueRef.current = "";
    contentValueRef.current = "";
    tagsValueRef.current = [];
    pinnedValueRef.current = false;
    saveStateRef.current = "idle";
    setSelectedId(null);
    setTitle("");
    setContent("");
    setNoteTags([]);
    setIsPinned(false);
    setSaveState("idle");
  }, [loadEpoch]);

  const loadExternalFile = useCallback(
    async (filePath: string) => {
      const epoch = loadEpoch.bump();
      try {
        const [fileContent, mtime] = await Promise.all([
          readExternalFile(filePath),
          getFileModifiedTime(filePath),
        ]);
        const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
        const displayTitle = fileName.replace(/\.(md|txt)$/i, "");

        setExternalFiles((current) => {
          if (current.some((f) => f.id === filePath)) {
            return current;
          }
          return [
            ...current,
            {
              id: filePath,
              title: displayTitle,
              filePath,
            },
          ];
        });

        if (!loadEpoch.isCurrent(epoch)) return;
        selectedIdRef.current = filePath;
        titleValueRef.current = displayTitle;
        contentValueRef.current = fileContent;
        saveStateRef.current = "saved";
        setSelectedId(filePath);
        setTitle(displayTitle);
        setContent(fileContent);
        setNoteTags([]);
        setIsPinned(false);
        tagsValueRef.current = [];
        pinnedValueRef.current = false;
        setSaveState("saved");
        setNoteTransitionKey((k) => k + 1);
        externalFileMtimeRef.current = mtime;
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [loadEpoch],
  );

  useEffect(() => {
    try {
      windowLabelRef.current = getCurrentWindow().label;
    } catch {
      windowLabelRef.current = "main";
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setIsLoading(true);
      try {
        const [loadedConfig, loadedNotes, loadedCategories] = await Promise.all([
          getConfig(),
          listNotes(),
          listCategories(),
        ]);
        if (cancelled) return;
        setSettingsConfig(loadedConfig);
        setSavedDataDir(loadedConfig.dataDir);
        setViewMode(normalizeViewMode(loadedConfig.defaultViewMode));
        setNotes(loadedNotes);
        setCategories(loadedCategories);
        setCollapsedCategories(new Set(loadedCategories));
        if (loadedNotes[0]) {
          const note = await getNote(loadedNotes[0].id);
          if (!cancelled) applyNote(note);
        } else {
          clearCurrentNote();
        }

        if (!cancelled) {
          const startupFile = await takeStartupFile();
          if (!cancelled && startupFile) {
            await loadExternalFile(startupFile);
          }
        }
      } catch (error) {
        if (!cancelled) showToast(getErrorMessage(error));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyNote, clearCurrentNote]);

  useEffect(() => {
    let active = true;

    void getUpdateStatus()
      .then((status) => {
        if (!active) return;
        syncUpdateStatus(status);
      })
      .catch((error) => {
        console.error("failed to load update status", error);
      });

    const bindEvents = async () => {
      const unlistenFns: UnlistenFn[] = [];
      const disposeAll = () => {
        for (const unlisten of unlistenFns.splice(0)) {
          unlisten();
        }
      };

      try {
        unlistenFns.push(
          await listen<UpdateState>("update://checking", (event) => {
            if (!active) return;
            syncUpdateStatus(event.payload);
          }),
        );

        unlistenFns.push(
          await listen<UpdateState>("update://checked", (event) => {
            if (!active) return;
            syncUpdateStatus(event.payload);
          }),
        );

        unlistenFns.push(
          await listen<UpdateState>("update://download-finished", (event) => {
            if (!active) return;
            syncUpdateStatus(event.payload);
          }),
        );

        unlistenFns.push(
          await listen<UpdateState>("update://install-finished", (event) => {
            if (!active) return;
            syncUpdateStatus(event.payload);
          }),
        );

        unlistenFns.push(
          await listen("update://error", () => {
            if (!active) return;
            void getUpdateStatus()
              .then((status) => {
                if (!active) return;
                syncUpdateStatus(status);
              })
              .catch((error) => {
                console.error("failed to refresh update status after error event", error);
              });
          }),
        );

        unlistenFns.push(
          await listen<UpdateErrorPayload>("update://auto-check-error", (event) => {
            if (!active) return;
            console.error("automatic update check failed", event.payload);
            void getUpdateStatus()
              .then((status) => {
                if (!active) return;
                syncUpdateStatus(status);
              })
              .catch((error) => {
                console.error("failed to refresh update status after automatic check error", error);
              });
          }),
        );

        return disposeAll;
      } catch (error) {
        disposeAll();
        console.error("failed to bind update event listeners", error);
        return () => undefined;
      }
    };

    const promise = bindEvents();

    return () => {
      active = false;
      void promise
        .then((dispose) => dispose())
        .catch((error) => {
          console.error("failed to dispose update event listeners", error);
        });
    };
  }, [syncUpdateStatus]);

  useEffect(() => {
    if (!aboutUpdateReminder.showText) return;
    const timer = window.setTimeout(() => {
      setAboutUpdateReminder((current) => dismissAboutUpdateReminderText(current));
    }, ABOUT_UPDATE_LABEL_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [aboutUpdateReminder.showText]);
  useEffect(() => {
    if (visibleSidePanel) {
      setMountedSidePanel(visibleSidePanel);
      setSidePanelContentVisible(false);

      const frame = window.requestAnimationFrame(() => {
        setSidePanelContentVisible(true);
      });

      return () => window.cancelAnimationFrame(frame);
    }

    setSidePanelContentVisible(false);
    if (!mountedSidePanel) return;

    const timer = window.setTimeout(() => {
      setMountedSidePanel((current) => (current === mountedSidePanel ? null : current));
    }, 320);

    return () => window.clearTimeout(timer);
  }, [mountedSidePanel, visibleSidePanel]);

  useEffect(() => {
    const unlisten = listen("notes-changed", () => {
      // 记录事件到达时的 epoch；其间用户一旦切换/加载了笔记，本次同步即过期，
      // 不再用过期的列表快照去改选中或回填内容，避免把选中"拉回"刚保存的旧笔记
      const epochAtEvent = loadEpoch.peek();
      const isStale = () => !loadEpoch.isCurrent(epochAtEvent);
      void refreshNotes()
        .then((loaded) => {
          if (isStale()) return;
          const currentId = selectedIdRef.current;
          if (!currentId) return;
          const stillExists = loaded.some((n) => n.id === currentId);
          if (stillExists) {
            if (saveStateRef.current !== "dirty" && saveStateRef.current !== "saving") {
              void getNote(currentId)
                .then((note) => {
                  if (isStale()) return;
                  if (selectedIdRef.current !== currentId) return;
                  if (saveStateRef.current === "dirty" || saveStateRef.current === "saving") {
                    return;
                  }
                  applyNote(note);
                  replaceNoteMetadata(note);
                })
                .catch(() => undefined);
            }
          } else if (selectedNoteRef.current) {
            if (loaded[0]) {
              void loadNote(loaded[0].id);
            } else {
              clearCurrentNote();
            }
          }
        })
        .catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes, loadNote, clearCurrentNote, loadEpoch, applyNote, replaceNoteMetadata]);

  useEffect(() => {
    function handleFocus() {
      void refreshNotes();
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshNotes]);

  useEffect(() => {
    const onResize = () => setSettingsOverlay(window.innerWidth < 1080);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("open-external-file", (event) => {
      void loadExternalFile(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadExternalFile]);

  useEffect(() => {
    const TEXT_RE = /\.(md|markdown|txt)$/i;
    const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const textPaths: string[] = [];
      const imagePaths: string[] = [];

      for (const p of event.payload.paths) {
        if (TEXT_RE.test(p)) textPaths.push(p);
        else if (IMAGE_RE.test(p)) imagePaths.push(p);
      }

      for (const p of textPaths) {
        void loadExternalFile(p);
      }

      if (imagePaths.length > 0 && selectedIdRef.current && !isExternalRef.current) {
        const noteId = selectedIdRef.current;
        void (async () => {
          const textarea = contentRef.current;
          if (!textarea) return;
          try {
            const rels = await Promise.all(imagePaths.map((p) => saveImageFromPath(noteId, p)));
            const markdown = rels.map((rel) => `![](${rel})`).join("\n");
            insertTextAtCursor(textarea, setContent, markdown);
            saveStateRef.current = "dirty";
            setSaveState("dirty");
          } catch (error) {
            showToast(getErrorMessage(error));
          }
        })();
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadExternalFile, setContent]);

  useEffect(() => {
    const unlisten = listen<string>("open-note", (event) => {
      void loadNote(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadNote]);

  useEffect(() => {
    const unlisten = listen("open-about-panel", () => {
      openAboutPanel();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [openAboutPanel]);

  useEffect(() => {
    const unlisten = listen<string>("shortcut-register-failed", (event) => {
      showToast(event.payload, "warning");
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>(TILE_WINDOW_CLOSED_EVENT, (event) => {
      setPinnedTileIds((previous) => syncPinnedTileIds(previous, event.payload, false));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>(TILE_WINDOW_UNPINNED_EVENT, (event) => {
      setPinnedTileIds((previous) => syncPinnedTileIds(previous, event.payload, false));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!selectedExternalFile) return;

    const interval = window.setInterval(async () => {
      // 窗口隐藏（托盘/最小化）时跳过探测，恢复可见后 1s 内自动追上
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastExternalSaveRef.current < 2000) return;
      try {
        const mtime = await getFileModifiedTime(selectedExternalFile.filePath);
        if (selectedIdRef.current !== selectedExternalFile.id) return;
        if (mtime !== externalFileMtimeRef.current) {
          externalFileMtimeRef.current = mtime;
          const fileContent = await readExternalFile(selectedExternalFile.filePath);
          if (selectedIdRef.current !== selectedExternalFile.id) return;
          contentValueRef.current = fileContent;
          saveStateRef.current = "saved";
          setContent(fileContent);
          setSaveState("saved");
        }
      } catch {
        // file may have been deleted or become inaccessible
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [selectedExternalFile]);

  useEffect(() => {
    function closeMenus() {
      setNoteMenuClosing(true);
      setCategoryMenuClosing(true);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenus();
    }

    document.addEventListener("mousedown", closeMenus);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", closeMenus);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!noteMenuClosing || !noteMenu) return;
    const timer = window.setTimeout(() => {
      setNoteMenu(null);
      setNoteMenuClosing(false);
      setNoteMenuMode("main");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [noteMenuClosing, noteMenu]);

  useEffect(() => {
    if (!categoryMenuClosing || !categoryMenu) return;
    const timer = window.setTimeout(() => {
      setCategoryMenu(null);
      setCategoryMenuClosing(false);
      setCategoryMenuConfirmDelete(false);
      setCategoryMenuHoverSuppressed(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [categoryMenuClosing, categoryMenu]);

  useEffect(() => {
    if (!categoryMenuHoverSuppressed || !categoryMenu) return;
    const releaseHover = () => setCategoryMenuHoverSuppressed(false);
    window.addEventListener("mousemove", releaseHover, { once: true });
    window.addEventListener("mousedown", releaseHover, { once: true });
    return () => {
      window.removeEventListener("mousemove", releaseHover);
      window.removeEventListener("mousedown", releaseHover);
    };
  }, [categoryMenuHoverSuppressed, categoryMenu]);

  const switchCategoryMenuPanel = useCallback((confirmDelete: boolean) => {
    setCategoryMenuHoverSuppressed(true);
    setCategoryMenuConfirmDelete(confirmDelete);
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const performSave = useCallback(
    async (force: boolean): Promise<boolean> => {
      // 非强制保存（自动保存、切换前保存）在没有未保存修改时直接视为成功
      if (!force && saveStateRef.current !== "dirty") return true;
      const id = selectedIdRef.current;
      if (!id) return false;

      // 在保存瞬间对当前笔记做快照；之后用户切换笔记不影响本次写入的内容，
      // 保存完成后也只在"仍停留在这篇笔记"时才更新保存状态
      const titleSnapshot = titleValueRef.current;
      const contentSnapshot = contentValueRef.current;
      const tagsSnapshot = tagsValueRef.current;
      const pinnedSnapshot = pinnedValueRef.current;
      const stillCurrent = () => selectedIdRef.current === id;
      const settleSaveState = (state: SaveState) => {
        if (!stillCurrent()) return;
        saveStateRef.current = state;
        setSaveState(state);
      };

      const externalFile = externalFilesRef.current.find((file) => file.id === id) ?? null;

      settleSaveState("saving");
      try {
        if (externalFile) {
          await saveExternalFile(externalFile.filePath, contentSnapshot);
          lastExternalSaveRef.current = Date.now();
          const mtime = await getFileModifiedTime(externalFile.filePath);
          if (stillCurrent()) {
            externalFileMtimeRef.current = mtime;
          }
          settleSaveState(contentValueRef.current === contentSnapshot ? "saved" : "dirty");
        } else {
          const category = notesRef.current.find((note) => note.id === id)?.category ?? "";
          const note = await updateNote(id, {
            title: titleSnapshot,
            content: contentSnapshot,
            category,
            tags: tagsSnapshot,
            pinned: pinnedSnapshot,
          });
          replaceNoteMetadata(note);
          const contentChanged =
            contentValueRef.current !== contentSnapshot || titleValueRef.current !== titleSnapshot;
          settleSaveState(contentChanged ? "dirty" : "saved");
        }
        return true;
      } catch (error) {
        settleSaveState("error");
        showToast(getErrorMessage(error));
        return false;
      }
    },
    [replaceNoteMetadata],
  );

  const saveCurrentNote = useCallback(
    (force = false): Promise<boolean> => {
      const run = saveQueueRef.current.then(() => performSave(force));
      saveQueueRef.current = run.catch(() => undefined);
      return run;
    },
    [performSave],
  );

  useEffect(() => {
    const unlisten = listen<UpdateInstallPrepareRequest>("update://prepare-install", (event) => {
      const respond = async () => {
        const windowLabel = windowLabelRef.current;
        // 无未保存修改时直接上报就绪：避免排进 saveQueueRef，被正在执行的
        // 防抖自动保存拖住、不必要地延迟安装准备响应
        if (saveStateRef.current !== "dirty") {
          await reportInstallPreparation(event.payload.requestId, windowLabel, "ready");
          return;
        }
        const saved = await saveCurrentNote();
        await reportInstallPreparation(
          event.payload.requestId,
          windowLabel,
          saved ? "ready" : "failed",
          saved
            ? undefined
            : t("settings.update.error.installSaveFailed", {
                defaultValue: "安装前自动保存失败，请先处理当前笔记后重试",
              }),
        );
      };

      void respond().catch(async (error) => {
        await reportInstallPreparation(
          event.payload.requestId,
          windowLabelRef.current,
          "failed",
          error instanceof Error
            ? error.message
            : t("settings.update.error.installSaveFailed", {
                defaultValue: "安装前自动保存失败，请先处理当前笔记后重试",
              }),
        ).catch(() => undefined);
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [saveCurrentNote, t]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void saveCurrentNote(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [saveCurrentNote]);

  useEffect(() => {
    if (!selectedId || saveState !== "dirty") return undefined;
    if (isExternal) {
      if (!settingsConfig?.externalFileAutoSave) return undefined;
    } else {
      if (!settingsConfig?.noteAutoSave) return undefined;
    }

    const timer = window.setTimeout(() => {
      void saveCurrentNote();
    }, 900);

    return () => window.clearTimeout(timer);
  }, [
    // content 与 title 用于在持续输入时不断重置防抖计时器
    content,
    title,
    isExternal,
    saveCurrentNote,
    saveState,
    selectedId,
    settingsConfig?.noteAutoSave,
    settingsConfig?.externalFileAutoSave,
  ]);

  const handleNewNote = async () => {
    await saveCurrentNote();
    try {
      const template = templates.find((item) => item.id === selectedTemplateId);
      const note = await createNote({
        title: "",
        content: template ? renderTemplateContent(template.content) : "",
        category: activeCategory,
      });
      replaceNoteMetadata(note);
      applyNote(note);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleOpenSettings = async () => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    setSettingsOpen(true);
    setAboutOpen(false);
    if (settingsConfig) return;
    try {
      const config = await getConfig();
      setSettingsConfig(config);
      setSavedDataDir(config.dataDir);
      setViewMode(normalizeViewMode(config.defaultViewMode));
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleMigrateDataDir = async () => {
    if (!settingsConfig) return;
    try {
      const dir = await chooseDataDirectory();
      if (!dir) return;
      // 后端会在所选目录下创建 floral 子目录存放数据；先告知用户，
      // 避免其在文件管理器打开所选目录看到"空文件夹"而误判数据丢失
      const confirmed = window.confirm(
        t("settings.dataDir.confirmSubdir", {
          dir,
          defaultValue: "数据将存放在「{{dir}}」下的 floral 子文件夹中，是否继续？",
        }),
      );
      if (!confirmed) return;
      const savedConfig = await migrateDataDir(dir);
      setSettingsConfig(savedConfig);
      setSavedDataDir(savedConfig.dataDir);
      const loadedNotes = await refreshNotes();
      if (loadedNotes[0]) {
        await loadNote(loadedNotes[0].id);
      } else {
        clearCurrentNote();
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistSettings = useCallback(
    (nextConfig: AppConfig) => {
      if (settingsSaveTimer.current) {
        clearTimeout(settingsSaveTimer.current);
      }
      settingsSaveTimer.current = setTimeout(async () => {
        const previousDataDir = savedDataDir ?? nextConfig.dataDir;
        const normalizedConfig = {
          ...nextConfig,
          defaultViewMode: normalizeViewMode(nextConfig.defaultViewMode),
          tileColor: normalizeTileColor(nextConfig.tileColor),
        };
        try {
          const savedConfig = await saveConfig(normalizedConfig);
          setSettingsConfig(savedConfig);
          setSavedDataDir(savedConfig.dataDir);
          setViewMode(normalizeViewMode(savedConfig.defaultViewMode));

          if (savedConfig.dataDir !== previousDataDir) {
            const loadedNotes = await refreshNotes();
            if (loadedNotes[0]) {
              await loadNote(loadedNotes[0].id);
            } else {
              clearCurrentNote();
            }
          }
        } catch (error) {
          showToast(getErrorMessage(error));
        }
      }, 300);
    },
    [savedDataDir, refreshNotes, loadNote, clearCurrentNote],
  );

  const handleSettingsChange = useCallback(
    (nextConfig: AppConfig) => {
      setSettingsConfig(nextConfig);
      void emit("config-changed", nextConfig);
      persistSettings(nextConfig);
    },
    [persistSettings],
  );

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const handleOpenAbout = useCallback(() => {
    setAboutOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setSettingsOpen(false);
        setAboutUpdateReminder((current) => dismissAboutUpdateReminderText(current));
      }
      return nextOpen;
    });
  }, []);

  const handleCloseAbout = useCallback(() => {
    setAboutOpen(false);
  }, []);

  const handleToggleTodos = useCallback(() => {
    setTodosOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setSettingsOpen(false);
        setAboutOpen(false);
        setHistoryOpen(false);
        setBacklinksOpen(false);
      }
      return nextOpen;
    });
  }, []);

  const handleToggleTodo = useCallback(
    async (note: Note, item: TodoItem, completed: boolean) => {
      const nextContent = toggleTodoInContent(note.content, item.line, completed);
      if (nextContent === note.content) return;

      const updated = await updateNote(note.id, {
        title: note.title,
        content: nextContent,
        category: note.category,
        tags: note.tags,
        pinned: note.pinned,
      });
      replaceNoteMetadata(updated);
      if (selectedIdRef.current === note.id) applyNote(updated);
    },
    [applyNote, replaceNoteMetadata],
  );

  const handleSaveAsTemplate = useCallback(() => {
    if (isExternal || !settingsConfig || !content.trim()) return;
    const name = window.prompt("模板名称", title.trim() || "未命名模板")?.trim();
    if (!name) return;

    const template: NoteTemplate = {
      id: globalThis.crypto?.randomUUID?.() ?? `template-${Date.now()}`,
      name,
      content,
    };
    handleSettingsChange({
      ...settingsConfig,
      templates: [...(settingsConfig.templates ?? []), template],
    });
    setSelectedTemplateId(template.id);
    showToast("已存为模板");
  }, [content, handleSettingsChange, isExternal, settingsConfig, title]);

  const handleOpenDailyNote = useCallback(async () => {
    try {
      const note = await openDailyNote();
      replaceNoteMetadata(note);
      applyNote(note);
      setActiveCategory(note.category);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [applyNote, replaceNoteMetadata]);

  const handleRestoreNoteVersion = useCallback(
    async (versionId: string) => {
      if (!selectedId || isExternal) return;
      const note = await restoreNoteVersion(selectedId, versionId);
      replaceNoteMetadata(note);
      applyNote(note);
      showToast("已恢复历史版本");
    },
    [applyNote, isExternal, replaceNoteMetadata, selectedId],
  );

  const handleImportNote = async () => {
    try {
      const saved = await saveCurrentNote();
      if (!saved) return;

      const note = await importMarkdownNote(activeCategory);
      if (!note) return;

      replaceNoteMetadata(note);
      applyNote(note);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleExportHtml = async () => {
    if (!selectedId) return;
    try {
      await saveCurrentNote(true);
      const filePath = await save({
        defaultPath: `${title || "未命名"}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!filePath) return;
      const html = wrapHtml(title || "未命名", content);
      await saveExternalFile(filePath, html);
      showToast(t("main.export.htmlSaved", { defaultValue: "HTML 已导出" }));
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleExportPdf = async () => {
    if (!selectedId) return;
    try {
      await saveCurrentNote(true);
      const html = wrapHtml(title || "未命名", content);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank", "width=800,height=600");
      if (win) {
        win.onload = () => {
          win.print();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleSelectNote = async (id: string) => {
    if (id === selectedId) return;
    setDeleteConfirm(false);
    // 排队保存：等待可能在途的自动保存，并把尚未落盘的修改一并存掉
    await saveCurrentNote();

    setIsLoading(true);
    try {
      await loadNote(id);
    } catch (error) {
      showToast(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const unlisten = listen<Reminder>("reminder://due", (event) => {
      const reminder = event.payload;
      showToast(`提醒：${reminder.message}`, "warning");
      if (reminder.noteId) void handleSelectNote(reminder.noteId);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [handleSelectNote]);

  const handleSelectExternalFile = async (id: string) => {
    if (id === selectedId) return;
    setDeleteConfirm(false);
    await saveCurrentNote();

    const file = externalFiles.find((f) => f.id === id);
    if (!file) return;

    setIsLoading(true);
    const epoch = loadEpoch.bump();
    try {
      const [fileContent, mtime] = await Promise.all([
        readExternalFile(file.filePath),
        getFileModifiedTime(file.filePath),
      ]);
      if (!loadEpoch.isCurrent(epoch)) return;
      selectedIdRef.current = id;
      titleValueRef.current = file.title;
      contentValueRef.current = fileContent;
      saveStateRef.current = "saved";
      setSelectedId(id);
      setTitle(file.title);
      setContent(fileContent);
      setSaveState("saved");
      setNoteTransitionKey((k) => k + 1);
      externalFileMtimeRef.current = mtime;
    } catch (error) {
      showToast(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveExternalFile = async (id: string) => {
    if (selectedId === id && saveState === "dirty") {
      const shouldSave = window.confirm(
        t("main.confirm.unsavedExternalFile", {
          title: title || t("common.untitledFile", { defaultValue: "未命名文件" }),
          defaultValue: "「{{title}}」有未保存的更改，是否保存到原文件？",
        }),
      );
      if (shouldSave) {
        const saved = await saveCurrentNote();
        if (!saved) return;
      }
    }
    setExternalFiles((current) => current.filter((f) => f.id !== id));
    if (selectedId === id) {
      clearCurrentNote();
    }
  };

  const handleDeleteNote = async (noteId = selectedId) => {
    if (!noteId) return;

    setDeleteConfirm(false);
    try {
      await deleteNote(noteId);
      const remaining = await refreshNotes();
      if (noteId === selectedId && remaining[0]) {
        await loadNote(remaining[0].id);
      } else if (noteId === selectedId) {
        clearCurrentNote();
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleOpenNoteMenu = (event: MouseEvent<HTMLElement>, noteId: string) => {
    event.preventDefault();
    event.stopPropagation();

    setNoteMenuClosing(false);
    setHoveredId(noteId);
    setNoteMenu({
      x: event.clientX,
      y: event.clientY,
      noteId,
    });
  };

  const handleExportNote = async (note: NoteMetadata) => {
    try {
      if (note.id === selectedId) {
        const saved = await saveCurrentNote();
        if (!saved) return;
      }

      await exportMarkdownNote({
        id: note.id,
        title: note.id === selectedId ? title : note.title,
      });
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleNoteMenuAction = (action: NoteContextMenuAction) => {
    const note = noteMenuTarget;
    if (!note) return;

    if (action === "export") {
      setNoteMenuClosing(true);
      void handleExportNote(note);
      return;
    }

    if (action === "move") {
      setNoteMenuMode("move");
      return;
    }

    setNoteMenuClosing(true);
    void handleDeleteNote(note.id);
  };

  const handleMoveNote = async (noteId: string, targetCategory: string) => {
    setNoteMenuClosing(true);
    try {
      await moveNoteCategory(noteId, targetCategory);
      await refreshNotes();
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleCreateCategory = async () => {
    const name = categoryInputValue.trim();
    if (!name) {
      setShowCategoryInput(false);
      return;
    }
    try {
      await createCategory(name);
      setCategories((prev) => [...prev, name].sort());
      setShowCategoryInput(false);
      setCategoryInputValue("");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleRenameCategory = async (oldName: string) => {
    const newName = renameCategoryValue.trim();
    if (!newName || newName === oldName) {
      setRenamingCategory(null);
      return;
    }

    try {
      await renameCategory(oldName, newName);
      await refreshNotes();
      setRenamingCategory(null);
      setRenameCategoryValue("");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleDeleteCategory = async (name: string) => {
    try {
      await deleteCategory(name);
      await refreshNotes();
      if (activeCategory === name) {
        setActiveCategory("");
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const toggleCategoryCollapse = (category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const markDirty = () => {
    if (!selectedId) return;
    saveStateRef.current = "dirty";
    setSaveState("dirty");
  };

  const ensureNoteSaved = useCallback(async (): Promise<string | null> => {
    if (selectedId) return selectedId;
    try {
      const note = await createNote({ title, content, category: activeCategory });
      replaceNoteMetadata(note);
      applyNote(note);
      return note.id;
    } catch {
      return null;
    }
  }, [selectedId, title, content, activeCategory, replaceNoteMetadata, applyNote]);

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

  const handleCleanUnusedImages = async () => {
    if (!selectedId || isExternal) return;
    try {
      const removed = await cleanUnusedImages(selectedId, content);
      if (removed.length > 0) {
        showToast(
          t("main.images.cleaned", {
            count: removed.length,
            defaultValue: "已清理 {{count}} 张图片",
          }),
          "info",
        );
      } else {
        showToast(t("main.images.cleanedNone", { defaultValue: "没有需要清理的图片" }), "info");
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleUndo = () => {
    if (!selectedId) return;
    const textarea = contentRef.current;
    if (runEditorCommand(textarea, "undo")) {
      setContent(textarea?.value ?? content);
      markDirty();
    }
  };

  const handleRedo = () => {
    if (!selectedId) return;
    const textarea = contentRef.current;
    if (runEditorCommand(textarea, "redo")) {
      setContent(textarea?.value ?? content);
      markDirty();
    }
  };

  const handleCopyStableLink = useCallback(async () => {
    if (!selectedNote) return;
    try {
      await navigator.clipboard.writeText(wikiLinkSyntax(selectedNote));
      showToast("已复制稳定关联链接", "info");
    } catch {
      showToast("复制失败，请检查剪贴板权限", "warning");
    }
  }, [selectedNote]);

  const handleOpenWikiLink = useCallback(
    (target: string) => {
      const noteId = resolveWikiLink(target, notesRef.current);
      if (!noteId) {
        showToast("未找到唯一匹配的关联笔记，请使用 [[note:笔记ID|标题]]", "warning");
        return;
      }
      void handleSelectNote(noteId);
    },
    [handleSelectNote],
  );

  const handleOpenNotepad = async () => {
    try {
      await openNotepadWindow();
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    void isCurrentWindowMaximized().then(setIsMaximized);
    const unlisten = getCurrentWindow().onResized(() => {
      void isCurrentWindowMaximized().then(setIsMaximized);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const newWidth = Math.min(Math.max(e.clientX, 180), 500);
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => setIsResizingSidebar(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    if (!isResizingSplit) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(Math.max(ratio, 0.2), 0.8));
    };
    const onMouseUp = () => setIsResizingSplit(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSplit]);

  const cancelScrollMeasurement = useCallback(() => {
    if (measureDebounceRef.current) clearTimeout(measureDebounceRef.current);
    cancelAnimationFrame(measureRafRef.current);
    measureControllerRef.current?.abort();
  }, []);

  const scrollSyncEnabled = settingsConfig?.splitScrollSync ?? true;

  const scheduleScrollMeasurement = useCallback(
    (delayMs: number) => {
      if (viewMode !== "split" || !scrollSyncEnabled) return;
      if (!contentRef.current || !previewScrollRef.current) return;

      // 布局和测量稳定前先清空旧偏移量
      blockOffsets.current = [];
      cancelScrollMeasurement();

      const controller = new AbortController();
      measureControllerRef.current = controller;

      const measure = async () => {
        if (!contentRef.current || !previewScrollRef.current) return;
        const offsets = await measureBlockOffsets(content, contentRef.current, controller.signal);
        if (controller.signal.aborted) return;
        blockOffsets.current = offsets;
        if (!controller.signal.aborted && previewScrollRef.current) {
          tagPreviewBlocks(previewScrollRef.current);
        }
      };

      const runAfterLayout = () => {
        measureRafRef.current = requestAnimationFrame(() => {
          void measure();
        });
      };

      if (delayMs > 0) {
        measureDebounceRef.current = setTimeout(runAfterLayout, delayMs);
      } else {
        runAfterLayout();
      }
    },
    [cancelScrollMeasurement, content, scrollSyncEnabled, viewMode],
  );

  // 切换笔记时通过 rAF 测量（不阻塞首帧渲染），编辑时 debounce 避免频繁重排
  useEffect(() => {
    if (viewMode !== "split" || !scrollSyncEnabled) {
      blockOffsets.current = [];
      cancelScrollMeasurement();
      return;
    }

    const isNoteSwitch = prevSelectedIdRef.current !== selectedId;
    prevSelectedIdRef.current = selectedId;
    scheduleScrollMeasurement(isNoteSwitch ? 0 : 250);

    return () => {
      cancelScrollMeasurement();
    };
  }, [
    cancelScrollMeasurement,
    content,
    scrollSyncEnabled,
    scheduleScrollMeasurement,
    selectedId,
    settingsConfig?.fontSize,
    settingsConfig?.renderHtmlMarkdown,
    splitRatio,
    viewMode,
  ]);

  useEffect(() => {
    if (viewMode !== "split") return;

    const observedElements: Element[] = [];
    if (splitContainerRef.current) observedElements.push(splitContainerRef.current);
    if (contentRef.current) observedElements.push(contentRef.current);
    if (previewScrollRef.current) observedElements.push(previewScrollRef.current);

    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => scheduleScrollMeasurement(120);
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    if (observedElements.length === 0) return;

    const observer = new ResizeObserver(() => {
      scheduleScrollMeasurement(120);
    });
    observedElements.forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [scheduleScrollMeasurement, viewMode]);

  // Reset preview scroll on note switch
  useEffect(() => {
    if (previewScrollRef.current) {
      previewScrollRef.current.scrollTop = 0;
    }
  }, [selectedId]);

  const handleEditorScroll = useCallback(() => {
    if (viewMode !== "split") return;
    if (scrollSource.current === "preview") return;

    const textarea = contentRef.current;
    const preview = previewScrollRef.current;
    if (!textarea || !preview) return;

    scrollSource.current = "editor";
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      scrollSource.current = null;
    }, 150);

    const offsets = blockOffsets.current;
    if (offsets.length === 0) return;

    const blockIdx = blockIndexAtOffset(offsets, textarea.scrollTop);
    const el = preview.querySelector<HTMLElement>(`[data-block-index="${blockIdx}"]`);
    if (!el) return;

    el.scrollIntoView({ block: "start", behavior: "instant" });
  }, [viewMode]);

  const handlePreviewScroll = useCallback(() => {
    if (viewMode !== "split") return;
    if (scrollSource.current === "editor") return;

    const textarea = contentRef.current;
    const preview = previewScrollRef.current;
    if (!textarea || !preview) return;

    scrollSource.current = "preview";
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      scrollSource.current = null;
    }, 150);

    const elements = preview.querySelectorAll<HTMLElement>("[data-block-index]");
    if (elements.length === 0) return;

    const containerRect = preview.getBoundingClientRect();
    let topDomIndex = 0;
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerRect.top + 1) {
        topDomIndex = parseInt(el.getAttribute("data-block-index")!, 10);
        break;
      }
    }

    const offsets = blockOffsets.current;
    if (topDomIndex >= offsets.length) return;

    textarea.scrollTop = offsets[topDomIndex];
  }, [viewMode]);

  const handlePinEntry = async () => {
    if (!selectedId) return;
    const isPinned = pinnedTileIds.has(selectedId);
    if (!isPinned) {
      await saveCurrentNote();
    }
    try {
      const pinned = await toggleTileWindow(selectedId);
      setPinnedTileIds((previous) => {
        return syncPinnedTileIds(previous, selectedId, pinned);
      });
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const selectedTilePinned = selectedId ? pinnedTileIds.has(selectedId) : false;

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

  const handleMinimize = () => {
    void minimizeCurrentWindow();
  };

  const handleMaximize = () => {
    toggleMaximize();
  };

  const handleClose = () => {
    void closeCurrentWindow();
  };
  const aboutButtonLabel = t("settings.update.title", { defaultValue: "更新" });
  const aboutButtonExpanded = aboutUpdateReminder.showText;
  const aboutButtonTitle = aboutUpdateReminder.hasPendingUpdate
    ? aboutButtonLabel
    : t("main.window.about", { defaultValue: "关于" });

  return (
    <div className="w-full h-screen flex flex-col">
      <div className="relative noise-bg bg-cloud overflow-hidden flex flex-col flex-1">
        <BackgroundLayer config={settingsConfig} />
        <div
          className={`relative z-10 flex items-center justify-between h-11 bg-paper/55 backdrop-blur-[1px] border-b border-paper-deep/30 shrink-0 select-none cursor-default ${
            isMacOS ? "pl-20 pr-5" : "pl-5 pr-0"
          }`}
          onMouseDown={handleTitleBarMouseDown}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[15px] font-serif font-medium text-ink-soft tracking-wide leading-none">
              花笺
            </span>
            <span className="text-[11px] text-ink-ghost font-body leading-none translate-y-px">
              —
            </span>
            <span className="text-[11px] text-ink-faint font-body truncate max-w-[240px] leading-none translate-y-px">
              {title ||
                selectedNote?.preview ||
                t("common.untitledNote", { defaultValue: "无标题笔记" })}
            </span>
          </div>
          <div className="flex items-center">
            <button
              onClick={() => void handleOpenNotepad()}
              className="w-10 h-11 flex items-center justify-center text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer"
              title={t("main.window.quickNotepad", { defaultValue: "快捷便签" })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 4h16v14H7l-3 3V4z" />
                <path d="M8 9h8M8 13h5" />
              </svg>
            </button>
            <button
              onClick={() => void handleOpenSettings()}
              className="w-10 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer"
              title={t("main.window.settings", { defaultValue: "设置" })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              onClick={handleOpenAbout}
              className={`h-11 flex items-center justify-center overflow-hidden text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-[width,padding,gap,background-color,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] cursor-pointer ${
                aboutButtonExpanded ? "w-[72px] gap-1.5 px-3" : "w-10 gap-0 px-0"
              }`}
              title={aboutButtonTitle}
              aria-label={aboutButtonTitle}
            >
              {aboutUpdateReminder.hasPendingUpdate ? (
                <svg
                  data-testid="main-about-update-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 16V8" />
                  <path d="m8.5 11.5 3.5-3.5 3.5 3.5" />
                </svg>
              ) : (
                <svg
                  data-testid="main-about-info-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
              )}
              {aboutUpdateReminder.hasPendingUpdate ? (
                <span
                  data-testid="main-about-update-label"
                  className={`overflow-hidden whitespace-nowrap text-[11px] font-body leading-none transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    aboutButtonExpanded
                      ? "max-w-[24px] translate-x-0 opacity-100"
                      : "max-w-0 translate-x-1 opacity-0"
                  }`}
                >
                  {aboutButtonLabel}
                </span>
              ) : null}
            </button>

            {!isMacOS && (
              <>
                <div className="w-px h-4 bg-paper-deep/30 mx-0.5" />

                <button
                  onClick={handleMinimize}
                  className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
                  title={t("main.window.minimize", { defaultValue: "最小化" })}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <rect x="1" y="5.5" width="10" height="1" fill="currentColor" rx="0.5" />
                  </svg>
                </button>
                <button
                  onClick={handleMaximize}
                  className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
                  title={
                    isMaximized
                      ? t("main.window.restore", { defaultValue: "还原" })
                      : t("main.window.maximize", { defaultValue: "最大化" })
                  }
                >
                  {isMaximized ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    >
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <path d="M3 5H2V2a1 1 0 0 1 1-1h5v1" />
                    </svg>
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    >
                      <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
                    </svg>
                  )}
                </button>
                <button
                  onClick={handleClose}
                  className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-red-500 hover:bg-danger-bg transition-all cursor-pointer"
                  title={t("main.window.close", { defaultValue: "关闭" })}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>

        <div className="relative z-10 flex flex-1 min-h-0 main-layout-row">
          <div
            className="border-r border-paper-deep/30 bg-paper/40 shrink-0 overflow-hidden transition-[width] duration-[600ms] main-sidebar"
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          >
            <div className="flex flex-col h-full" style={{ width: `${sidebarWidth}px` }}>
              <div className="px-3 pt-3 pb-2 shrink-0">
                <div className="flex items-center gap-2 px-2.5 h-8 rounded-lg bg-paper-warm/80 border border-paper-deep/40 focus-within:border-bamboo/30 focus-within:bg-cloud transition-all">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    className="text-ink-ghost shrink-0"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={t("main.sidebar.searchPlaceholder", { defaultValue: "搜索笔记…" })}
                    className="flex-1 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="text-ink-ghost hover:text-ink-faint transition-colors cursor-pointer"
                      title={t("main.sidebar.clearSearch", { defaultValue: "清空搜索" })}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                      >
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                <TagFilterBar
                  notes={notes}
                  selectedTag={tagFilter}
                  open={tagFilterOpen}
                  onToggle={() => setTagFilterOpen((open) => !open)}
                  onSelectTag={(tag) => setTagFilter(tag === tagFilter ? "" : tag)}
                />
              </div>

              <div className="px-3 pb-2 shrink-0 space-y-1">
                <select
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                  className="w-full h-7 px-2 rounded-lg border border-paper-deep/25 bg-paper-warm/45 text-[11px] text-ink-faint cursor-pointer"
                  aria-label="新建笔记模板"
                >
                  <option value="">空白笔记</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void handleOpenDailyNote()}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="4" width="18" height="17" rx="2" />
                    <path d="M8 2v4M16 2v4M7 10h10M8 14h3" />
                  </svg>
                  <span>每日便笺</span>
                </button>
                <button
                  onClick={handleNewNote}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-bamboo hover:bg-bamboo-mist/60 transition-all cursor-pointer group"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    className="group-hover:rotate-90 transition-transform duration-200"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span>{t("main.sidebar.newNote", { defaultValue: "新建笔记" })}</span>
                </button>
                <button
                  onClick={handleToggleTodos}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer group"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m9 11 3 3L22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                  <span>待办聚合</span>
                </button>
                <button
                  onClick={() => void handleImportNote()}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer group"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 3v12" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M5 21h14" />
                  </svg>
                  <span>{t("main.sidebar.importMarkdown", { defaultValue: "导入 Markdown" })}</span>
                </button>
              </div>

              <div className="flex items-center justify-between px-5 pb-1.5 shrink-0">
                <span className="text-[10px] text-ink-ghost font-mono tracking-wider uppercase">
                  {t("common.noteCount", {
                    count: filteredNotes.length,
                    defaultValue: "{{count}} 篇笔记",
                  })}
                  {externalFiles.length > 0
                    ? ` · ${t("common.externalFileCount", {
                        count: externalFiles.length,
                        defaultValue: "{{count}} 个外部文件",
                      })}`
                    : ""}
                </span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (showCategoryInput && categoryInputValue.trim()) {
                      void handleCreateCategory();
                      return;
                    }
                    setShowCategoryInput(true);
                  }}
                  className="text-[10px] text-ink-ghost hover:text-bamboo transition-colors cursor-pointer"
                  title={t("main.category.new", { defaultValue: "新建分类" })}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </div>

              {showCategoryInput && (
                <div className="px-3 pb-2 shrink-0">
                  <input
                    type="text"
                    autoFocus
                    value={categoryInputValue}
                    onChange={(e) => setCategoryInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCreateCategory();
                      if (e.key === "Escape") {
                        setShowCategoryInput(false);
                        setCategoryInputValue("");
                      }
                    }}
                    onBlur={() => void handleCreateCategory()}
                    placeholder={t("main.category.placeholder", { defaultValue: "输入分类名…" })}
                    className="w-full px-2.5 h-7 rounded-lg text-[12px] font-body text-ink bg-paper-warm/80 border border-paper-deep/40 focus:border-bamboo/30 placeholder:text-ink-ghost/60"
                  />
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-2 pb-2">
                <div className="space-y-0.5">
                  {externalFiles.length > 0 && (
                    <>
                      <div className="px-3 py-1.5 text-[10px] text-ink-ghost/50 font-mono tracking-wider uppercase">
                        {t("main.externalFiles.title", { defaultValue: "外部文件" })}
                      </div>
                      {externalFiles.map((file) => {
                        const isSelected = file.id === selectedId;
                        const isHovered = file.id === hoveredId;

                        return (
                          <button
                            key={file.id}
                            onClick={() => void handleSelectExternalFile(file.id)}
                            onMouseEnter={() => setHoveredId(file.id)}
                            onMouseLeave={() => setHoveredId(null)}
                            className={`w-full text-left rounded-xl px-3 py-2.5 transition-all duration-[600ms] cursor-pointer group relative ${
                              isSelected
                                ? "bg-bamboo-mist/70"
                                : isHovered
                                  ? "bg-paper-warm/70"
                                  : "bg-transparent"
                            }`}
                          >
                            <div
                              className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                                isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                              }`}
                            />

                            <div className="flex items-baseline justify-between mb-0.5">
                              <span
                                className={`text-[13px] font-display font-medium truncate pr-2 transition-colors flex items-center gap-1.5 ${
                                  isSelected ? "text-bamboo" : "text-ink-soft"
                                }`}
                              >
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="shrink-0 opacity-60"
                                >
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                  <polyline points="14 2 14 8 20 8" />
                                </svg>
                                {file.title}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveExternalFile(file.id);
                                }}
                                className="opacity-0 group-hover:opacity-100 text-ink-ghost hover:text-red-400 transition-all p-0.5"
                                title={t("main.externalFiles.remove", {
                                  defaultValue: "从列表移除",
                                })}
                              >
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                >
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            </div>

                            <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors pl-[18px]">
                              {file.filePath}
                            </p>
                          </button>
                        );
                      })}
                    </>
                  )}

                  {categoryGroups.map((group: CategoryGroup) => {
                    if (!group.category) {
                      return (
                        <div
                          key="__uncategorized__"
                          className={`rounded-lg transition-all duration-200 ${
                            dragOverCategory === "" ? "bg-bamboo/10 ring-1 ring-bamboo/20" : ""
                          }`}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            setDragOverCategory("");
                          }}
                          onDragLeave={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                              setDragOverCategory(null);
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDragOverCategory(null);
                            const noteId = e.dataTransfer.getData("text/plain");
                            if (noteId) void handleMoveNote(noteId, "");
                          }}
                        >
                          {group.notes.map((note) => {
                            const isSelected = note.id === selectedId;
                            const isHovered = note.id === hoveredId;
                            return (
                              <div
                                key={note.id}
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData("text/plain", note.id);
                                  e.dataTransfer.effectAllowed = "move";
                                }}
                                onClick={() => void handleSelectNote(note.id)}
                                onContextMenu={(event) => handleOpenNoteMenu(event, note.id)}
                                onMouseEnter={() => setHoveredId(note.id)}
                                onMouseLeave={() => setHoveredId(null)}
                                className={`w-full text-left rounded-xl px-3 py-2.5 transition-all duration-[600ms] cursor-pointer group relative ${
                                  isSelected
                                    ? "bg-bamboo-mist/70"
                                    : isHovered
                                      ? "bg-paper-warm/70"
                                      : "bg-transparent"
                                }`}
                              >
                                <div
                                  className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                                    isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                                  }`}
                                />
                                <div className="flex items-baseline justify-between mb-0.5">
                                  <span
                                    className={`text-[13px] font-display font-medium truncate pr-2 transition-colors ${
                                      isSelected ? "text-bamboo" : "text-ink-soft"
                                    }`}
                                  >
                                    {getDisplayTitle(note, t)}
                                  </span>
                                  <span className="text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">
                                    {formatShortDate(note.updatedAt)}
                                  </span>
                                </div>
                                <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors">
                                  {note.preview ||
                                    t("common.blankNote", { defaultValue: "空白笔记" })}
                                </p>
                                <div className="flex items-center gap-2 mt-1">
                                  <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                    {formatTime(note.updatedAt)}
                                  </span>
                                  <span className="text-[10px] text-ink-ghost/40">·</span>
                                  <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                    {t("common.wordCount", {
                                      count: note.wordCount,
                                      defaultValue: "{{count}} 字",
                                    })}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    }

                    const isCollapsed = collapsedCategories.has(group.category);

                    return (
                      <div key={group.category} className="px-2 mb-0.5">
                        <div
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg group/cat cursor-pointer select-none transition-all duration-200 ${
                            dragOverCategory === group.category
                              ? "bg-bamboo/15 border border-bamboo/40 ring-1 ring-bamboo/20"
                              : isCollapsed
                                ? "bg-transparent border border-bamboo/15"
                                : "bg-bamboo/8 border border-bamboo/15 rounded-b-none"
                          }`}
                          onClick={() => toggleCategoryCollapse(group.category)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCategoryMenu({
                              x: e.clientX,
                              y: e.clientY,
                              category: group.category,
                            });
                            setCategoryMenuClosing(false);
                            setCategoryMenuConfirmDelete(false);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            setDragOverCategory(group.category);
                          }}
                          onDragLeave={() => setDragOverCategory(null)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDragOverCategory(null);
                            const noteId = e.dataTransfer.getData("text/plain");
                            if (noteId) void handleMoveNote(noteId, group.category);
                          }}
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`text-bamboo/50 shrink-0 transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="text-bamboo/50 shrink-0"
                          >
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                          {renamingCategory === group.category ? (
                            <input
                              type="text"
                              autoFocus
                              value={renameCategoryValue}
                              onChange={(e) => setRenameCategoryValue(e.target.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") void handleRenameCategory(group.category);
                                if (e.key === "Escape") setRenamingCategory(null);
                              }}
                              onBlur={() => void handleRenameCategory(group.category)}
                              onClick={(e) => e.stopPropagation()}
                              className="flex-1 min-w-0 px-1 text-[10px] font-mono text-ink bg-paper-warm/80 border border-bamboo/30 rounded"
                            />
                          ) : (
                            <span className="text-[11px] text-bamboo/70 font-medium truncate">
                              {group.category}
                            </span>
                          )}
                          <span className="text-[9px] text-bamboo/40 font-mono ml-auto shrink-0">
                            {group.notes.length}
                          </span>
                        </div>

                        <div className={`category-body ${isCollapsed ? "" : "expanded"}`}>
                          <div
                            className="category-body-inner bg-bamboo/[0.03] border border-t-0 border-bamboo/10 rounded-b-lg pb-1 pt-1"
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              setDragOverCategory(group.category);
                            }}
                            onDragLeave={(e) => {
                              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                setDragOverCategory(null);
                              }
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              setDragOverCategory(null);
                              const noteId = e.dataTransfer.getData("text/plain");
                              if (noteId) void handleMoveNote(noteId, group.category);
                            }}
                          >
                            {group.notes.length === 0 ? (
                              <div className="px-3 py-3 text-center text-[11px] text-ink-ghost/50">
                                {t("main.category.emptyFolder", { defaultValue: "空文件夹" })}
                              </div>
                            ) : (
                              group.notes.map((note) => {
                                const isSelected = note.id === selectedId;
                                const isHovered = note.id === hoveredId;

                                return (
                                  <div
                                    key={note.id}
                                    draggable
                                    onDragStart={(e) => {
                                      e.dataTransfer.setData("text/plain", note.id);
                                      e.dataTransfer.effectAllowed = "move";
                                    }}
                                    onClick={() => void handleSelectNote(note.id)}
                                    onContextMenu={(event) => handleOpenNoteMenu(event, note.id)}
                                    onMouseEnter={() => setHoveredId(note.id)}
                                    onMouseLeave={() => setHoveredId(null)}
                                    className={`w-full text-left rounded-lg mx-1 px-2.5 py-2 transition-all duration-[600ms] cursor-pointer group relative ${
                                      isSelected
                                        ? "bg-bamboo-mist/70"
                                        : isHovered
                                          ? "bg-paper-warm/70"
                                          : "bg-transparent"
                                    }`}
                                    style={{ width: "calc(100% - 8px)" }}
                                  >
                                    <div
                                      className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                                        isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                                      }`}
                                    />

                                    <div className="flex items-baseline justify-between mb-0.5">
                                      <span
                                        className={`text-[13px] font-display font-medium truncate pr-2 transition-colors ${
                                          isSelected ? "text-bamboo" : "text-ink-soft"
                                        }`}
                                      >
                                        {getDisplayTitle(note, t)}
                                      </span>
                                      <span className="text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">
                                        {formatShortDate(note.updatedAt)}
                                      </span>
                                    </div>

                                    <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors">
                                      {note.preview ||
                                        t("common.blankNote", { defaultValue: "空白笔记" })}
                                    </p>

                                    <div className="flex items-center gap-2 mt-1">
                                      <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                        {formatTime(note.updatedAt)}
                                      </span>
                                      <span className="text-[10px] text-ink-ghost/40">·</span>
                                      <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                        {t("common.wordCount", {
                                          count: note.wordCount,
                                          defaultValue: "{{count}} 字",
                                        })}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {!isLoading && filteredNotes.length === 0 && externalFiles.length === 0 && (
                    <div className="px-3 py-8 text-center text-[12px] text-ink-ghost leading-relaxed">
                      {searchQuery
                        ? t("main.search.noResults", { defaultValue: "没有匹配的笔记" })
                        : t("main.search.empty", { defaultValue: "还没有笔记" })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {!sidebarCollapsed && (
            <div
              className={`w-1 shrink-0 cursor-col-resize group relative ${isResizingSidebar ? "bg-bamboo/30" : "hover:bg-bamboo/20"} transition-colors`}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingSidebar(true);
              }}
            >
              <div
                className={`absolute inset-y-0 -left-1 -right-1 ${isResizingSidebar ? "" : "group-hover:bg-bamboo/5"}`}
              />
            </div>
          )}

          <div className="flex-1 flex flex-col min-w-0">
            <div
              className={`flex items-center h-10 border-b border-paper-deep/20 shrink-0 bg-paper/20 transition-all duration-200 ${
                settingsOpen ? "justify-end px-2" : "justify-between px-4"
              }`}
            >
              <div
                className={`flex items-center gap-1 overflow-hidden transition-[max-width,opacity] duration-200 ${
                  settingsOpen ? "max-w-0 opacity-0 pointer-events-none" : "max-w-[900px] opacity-100"
                }`}
              >
                <button
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer"
                  title={
                    sidebarCollapsed
                      ? t("main.window.expandSidebar", { defaultValue: "展开侧栏" })
                      : t("main.window.collapseSidebar", { defaultValue: "收起侧栏" })
                  }
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>

                <div className="h-4 w-px bg-paper-deep/30 mx-1" />

                <button
                  onClick={() => {
                    setHistoryOpen((open) => {
                      const nextOpen = !open;
                      if (nextOpen) {
                        setSettingsOpen(false);
                        setAboutOpen(false);
                        setTodosOpen(false);
                        setBacklinksOpen(false);
                      }
                      return nextOpen;
                    });
                  }}
                  disabled={!selectedId || isExternal}
                  aria-label="版本历史"
                  title="版本历史"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 12a9 9 0 1 0 3-6.7" />
                    <path d="M3 4v5h5M12 7v5l3 2" />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    setBacklinksOpen((open) => {
                      const nextOpen = !open;
                      if (nextOpen) {
                        setSettingsOpen(false);
                        setAboutOpen(false);
                        setTodosOpen(false);
                        setHistoryOpen(false);
                      }
                      return nextOpen;
                    });
                  }}
                  disabled={!selectedId || isExternal}
                  aria-label="反向链接"
                  title="反向链接"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.07.07l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15" />
                    <path d="M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 12 20l1.15-1.15" />
                  </svg>
                </button>
                <button
                  onClick={() => void handleCopyStableLink()}
                  disabled={!selectedNote || isExternal}
                  aria-label="复制稳定链接"
                  title="复制稳定链接"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    setRemindersOpen((open) => {
                      const nextOpen = !open;
                      if (nextOpen) {
                        setSettingsOpen(false);
                        setAboutOpen(false);
                        setTodosOpen(false);
                        setHistoryOpen(false);
                        setBacklinksOpen(false);
                      }
                      return nextOpen;
                    });
                  }}
                  disabled={!selectedId || isExternal}
                  aria-label="添加提醒"
                  title="添加提醒"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="13" r="8" />
                    <path d="M12 9v4l2.5 1.5M9 3h6M12 3v2" />
                  </svg>
                </button>
                <button
                  onClick={handleSaveAsTemplate}
                  disabled={!selectedId || isExternal || !content.trim()}
                  aria-label="存为模板"
                  title="存为模板"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 3v12" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M5 21h14" />
                  </svg>
                </button>

                {/* 星标置顶 */}
                <button
                  onClick={() => {
                    const next = !isPinned;
                    setIsPinned(next);
                    pinnedValueRef.current = next;
                    markDirty();
                  }}
                  disabled={!selectedId || isExternal}
                  aria-label={
                    isPinned
                      ? t("main.editor.unpin", { defaultValue: "取消置顶" })
                      : t("main.editor.pin", { defaultValue: "置顶" })
                  }
                  className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                    isPinned
                      ? "text-yellow-500 bg-yellow-50/60 hover:text-yellow-600"
                      : "text-ink-ghost hover:text-yellow-500 hover:bg-paper-warm"
                  }`}
                  title={
                    isPinned
                      ? t("main.editor.unpin", { defaultValue: "取消置顶" })
                      : t("main.editor.pin", { defaultValue: "置顶" })
                  }
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill={isPinned ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>

                <button
                  onClick={() => void handlePinEntry()}
                  disabled={!selectedId}
                  aria-label={pinTileButtonTitle(selectedTilePinned)}
                  className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                    selectedTilePinned
                      ? "text-bamboo bg-bamboo-mist/40 hover:text-red-400 hover:bg-danger-bg"
                      : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50"
                  }`}
                  title={pinTileButtonTitle(selectedTilePinned)}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 17v5" />
                    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z" />
                  </svg>
                </button>

                <button
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleUndo}
                  disabled={!selectedId}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t("main.editor.undo", { defaultValue: "撤销（Ctrl+Z）" })}
                  aria-label={t("main.editor.undoLabel", { defaultValue: "撤销" })}
                >
                  <svg
                    data-testid="main-editor-undo-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M9 14 4 9l5-5" />
                    <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
                  </svg>
                </button>

                <button
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleRedo}
                  disabled={!selectedId}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t("main.editor.redo", { defaultValue: "重做（Ctrl+Y）" })}
                  aria-label={t("main.editor.redoLabel", { defaultValue: "重做" })}
                >
                  <svg
                    data-testid="main-editor-redo-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    style={{ transform: "scaleX(-1)" }}
                  >
                    <path d="M9 14 4 9l5-5" />
                    <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
                  </svg>
                </button>

                <button
                  onClick={() => void saveCurrentNote(true)}
                  disabled={!selectedId || saveState === "saving"}
                  className="px-2.5 h-7 flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t("common.save", { defaultValue: "保存" })}
                >
                  {t("common.save", { defaultValue: "保存" })}
                </button>

                {/* 导出按钮 */}
                {!isExternal && selectedId && (
                  <>
                    <div className="h-4 w-px bg-paper-deep/20" />
                    <button
                      onClick={() => void handleExportHtml()}
                      disabled={!selectedId}
                      className="px-2 h-7 flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      title={t("main.export.html", { defaultValue: "导出 HTML" })}
                    >
                      HTML
                    </button>
                    <button
                      onClick={() => void handleExportPdf()}
                      disabled={!selectedId}
                      className="px-2 h-7 flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      title={t("main.export.pdf", { defaultValue: "导出 PDF" })}
                    >
                      PDF
                    </button>
                  </>
                )}

                {deleteConfirm ? (
                  <div
                    className={`flex items-center gap-1 ml-1 ${deleteExiting ? "animate-delete-confirm-exit" : "animate-delete-confirm"}`}
                  >
                    <span className="text-[11px] text-red-400 whitespace-nowrap">
                      {t("main.editor.confirmDelete", { defaultValue: "确认删除？" })}
                    </span>
                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDeleteExiting(true);
                        setTimeout(() => {
                          setDeleteExiting(false);
                          setDeleteConfirm(false);
                          void handleDeleteNote();
                        }, 150);
                      }}
                      className="px-2 h-6 rounded-md text-[11px] text-cloud bg-red-400 hover:bg-red-500 transition-colors cursor-pointer whitespace-nowrap outline-none"
                    >
                      {t("common.delete", { defaultValue: "删除" })}
                    </button>
                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDeleteExiting(true);
                        setTimeout(() => {
                          setDeleteExiting(false);
                          setDeleteConfirm(false);
                        }, 150);
                      }}
                      className="px-2 h-6 rounded-md text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer outline-none"
                    >
                      {t("common.cancel", { defaultValue: "取消" })}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(true)}
                    disabled={!selectedId}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-red-400 hover:bg-danger-bg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    title={t("noteMenu.delete", { defaultValue: "删除笔记" })}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3,6 5,6 21,6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                )}
              </div>

              {!settingsOpen && (
                <SlidingButtonGroup
                  options={viewModeOptions}
                  value={viewMode}
                  onChange={setViewMode}
                  buttonClassName="px-3 py-1"
                />
              )}
              {settingsOpen && (
                <span className="px-2 text-[11px] text-ink-ghost font-body">设置已打开</span>
              )}
            </div>

            <div
              key={noteTransitionKey}
              className="animate-note-enter px-6 pt-4 pb-2 shrink-0 border-b border-paper-deep/15"
            >
              <input
                type="text"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  markDirty();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    contentRef.current?.focus();
                  }
                }}
                placeholder={t("common.untitledNote", { defaultValue: "无标题笔记" })}
                disabled={!selectedId}
                className="w-full text-[20px] font-display font-bold text-ink placeholder:text-ink-ghost/50 tracking-wide disabled:opacity-60"
              />
              {/* 标签编辑 */}
              {!isExternal && selectedId && (
                <TagEditor
                  tags={noteTags}
                  onChange={(newTags) => {
                    setNoteTags(newTags);
                    tagsValueRef.current = newTags;
                    markDirty();
                  }}
                />
              )}
              <div className="flex items-center gap-3 mt-1.5">
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums truncate max-w-[200px]">
                  {selectedExternalFile
                    ? t("main.externalFile.label", {
                        path: selectedExternalFile.filePath,
                        defaultValue: "外部文件 · {{path}}",
                      })
                    : selectedNote
                      ? `${formatShortDate(selectedNote.updatedAt)} ${formatTime(selectedNote.updatedAt)}`
                      : "--"}
                </span>
                <span className="text-[10px] text-ink-ghost/40">·</span>
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("common.wordCount", { count: charCount, defaultValue: "{{count}} 字" })}
                </span>
                <span className="text-[10px] text-ink-ghost/40">·</span>
                <span
                  key={saveState}
                  className={`text-[10px] font-mono tabular-nums animate-status-fade ${
                    saveState === "error"
                      ? "text-red-400"
                      : saveState === "dirty"
                        ? "text-amber-500/70"
                        : "text-bamboo/60"
                  }`}
                >
                  {saveStateLabel[saveState]}
                </span>
              </div>
            </div>

            <div
              key={viewMode}
              ref={splitContainerRef}
              className="flex-1 flex min-h-0 animate-view-fade"
            >
              {!selectedId && !isLoading ? (
                <div className="flex-1 flex items-center justify-center text-[13px] text-ink-ghost">
                  {t("main.editor.emptyHint", { defaultValue: "选择或新建一篇笔记" })}
                </div>
              ) : (
                <>
                  {(viewMode === "edit" || viewMode === "split") && (
                    <div
                      className="flex flex-col min-h-0 shrink-0"
                      style={{ width: viewMode === "split" ? `${splitRatio * 100}%` : "100%" }}
                    >
                      <div className="flex items-center gap-0.5 px-4 pt-2 pb-1 shrink-0">
                        {toolbarButtons.map((button) => (
                          <button
                            key={button.label}
                            title={button.title}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              if (contentRef.current) {
                                applyFormat(
                                  contentRef.current,
                                  button.action,
                                  t,
                                  setContent,
                                  markDirty,
                                );
                              }
                            }}
                            className={`w-6 h-6 flex items-center justify-center rounded text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer ${button.style}`}
                          >
                            {button.label}
                          </button>
                        ))}
                      </div>

                      <div className="flex-1 overflow-hidden px-5 pb-4">
                        <textarea
                          ref={contentRef}
                          data-tab-indent="true"
                          value={content}
                          onChange={(event) => {
                            setContent(event.target.value);
                            markDirty();
                          }}
                          onPaste={imagePasteHandler}
                          onDrop={imageDropHandler}
                          onDragOver={imageDragOverHandler}
                          onScroll={handleEditorScroll}
                          className="w-full h-full text-ink-soft font-body placeholder:text-ink-ghost/40 editor-textarea"
                          style={{
                            fontSize: `${settingsConfig?.fontSize ?? 14}px`,
                            tabSize: `var(--tab-indent-size, 2)`,
                            fontFamily: `var(--editor-font-family)`,
                            lineHeight: `var(--editor-line-height)`,
                            maxWidth: `var(--editor-max-width)`,
                            margin: "0 auto",
                          }}
                          placeholder={t("main.editor.contentPlaceholder", {
                            defaultValue: "开始写作……",
                          })}
                          spellCheck={false}
                          disabled={!selectedId}
                        />
                      </div>
                    </div>
                  )}

                  {viewMode === "split" && (
                    <div
                      className={`w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center ${isResizingSplit ? "bg-bamboo/30" : "hover:bg-bamboo/20"} transition-colors`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setIsResizingSplit(true);
                      }}
                    >
                      <div
                        className={`absolute inset-y-0 -left-1.5 -right-1.5 ${isResizingSplit ? "" : "group-hover:bg-bamboo/5"}`}
                      />
                      {/* 拖拽手柄指示器 */}
                      <div className="relative z-10 flex flex-col gap-[3px] opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                      </div>
                    </div>
                  )}

                  {(viewMode === "preview" || viewMode === "split") && (
                    <div className="flex flex-col min-h-0 min-w-0 flex-1">
                      {viewMode === "split" && (
                        <div className="px-4 pt-2.5 pb-1 shrink-0">
                          <span className="text-[10px] text-ink-ghost/60 font-mono tracking-widest uppercase">
                            {t("main.editor.previewLabel", { defaultValue: "Preview" })}
                          </span>
                        </div>
                      )}
                      <div
                        ref={previewScrollRef}
                        onScroll={handlePreviewScroll}
                        className={`flex-1 overflow-y-auto px-6 pb-6 ${
                          viewMode === "preview" ? "pt-3" : "pt-1"
                        }`}
                      >
                        <MarkdownPreview
                          content={deferredContent}
                          fontSize={settingsConfig?.fontSize ?? 14}
                          renderHtml={settingsConfig?.renderHtmlMarkdown ?? false}
                          imageBaseDir={imageBaseDir ?? undefined}
                          onOpenWikiLink={handleOpenWikiLink}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between px-4 h-7 border-t border-paper-deep/20 bg-paper/30 shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("main.statusBar.lineNumber", {
                    count: lineCount,
                    defaultValue: "Ln {{count}}",
                  })}
                </span>
                <span className="text-[10px] text-ink-ghost/40">|</span>
                <span className="text-[10px] text-ink-ghost font-mono">
                  {t("main.statusBar.format", { defaultValue: "Markdown + LaTeX" })}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {selectedId && !isExternal && content.includes("images/") && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCleanUnusedImages()}
                      className="text-[10px] text-ink-ghost hover:text-bamboo font-mono cursor-pointer transition-colors"
                    >
                      {t("main.images.cleanUnused", { defaultValue: "清理未使用图片" })}
                    </button>
                    <span className="text-[10px] text-ink-ghost/40">|</span>
                  </>
                )}
                <span className="text-[10px] text-ink-ghost font-mono">
                  {t("main.statusBar.encoding", { defaultValue: "UTF-8" })}
                </span>
                <span className="text-[10px] text-ink-ghost/40">|</span>
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("main.statusBar.byteSize", { size: byteSize, defaultValue: "{{size}} KB" })}
                </span>
              </div>
            </div>
          </div>
          {settingsConfig && settingsOpen && settingsOverlay && (
            <div className="absolute inset-0 z-20" onClick={handleCloseSettings} />
          )}
          <div
            className={`relative shrink-0 overflow-hidden h-full transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              sidePanelExpanded || mountedSidePanel ? "border-l border-paper-deep/20" : "border-l-0"
            } ${
              settingsOverlay
                ? `absolute right-0 top-0 bottom-0 z-30 ${visibleSidePanel ? "w-[360px] shadow-xl" : "w-0"}`
                : `${sidePanelExpanded ? "w-[360px]" : "w-0"}`
            }`}
          >
            <div
              className={`absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "about"
                  ? sidePanelContentVisible && visibleSidePanel === "about"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "about" ? (
                <Suspense fallback={null}>
                  <AboutPanel onClose={handleCloseAbout} />
                </Suspense>
              ) : null}
            </div>
            <div
              className={`absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "history"
                  ? sidePanelContentVisible && visibleSidePanel === "history"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "history" && selectedId && !isExternal ? (
                <NoteHistoryPanel
                  noteId={selectedId}
                  onRestore={handleRestoreNoteVersion}
                  onClose={() => setHistoryOpen(false)}
                />
              ) : null}
            </div>
            <div
              className={`absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "backlinks"
                  ? sidePanelContentVisible && visibleSidePanel === "backlinks"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "backlinks" && selectedId && !isExternal ? (
                <BacklinksPanel
                  noteId={selectedId}
                  notes={notes}
                  onOpenNote={(noteId) => {
                    setBacklinksOpen(false);
                    void handleSelectNote(noteId);
                  }}
                  onClose={() => setBacklinksOpen(false)}
                />
              ) : null}
            </div>
            <div
              className={`absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "reminders"
                  ? sidePanelContentVisible && visibleSidePanel === "reminders"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "reminders" && selectedId && !isExternal ? (
                <ReminderPanel
                  noteId={selectedId}
                  noteTitle={title}
                  onClose={() => setRemindersOpen(false)}
                />
              ) : null}
            </div>
            <div
              className={`absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "todos"
                  ? sidePanelContentVisible && visibleSidePanel === "todos"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "todos" ? (
                <TodoPanel
                  notes={notes}
                  onOpenNote={(noteId) => {
                    setTodosOpen(false);
                    void handleSelectNote(noteId);
                  }}
                  onToggleTodo={handleToggleTodo}
                  onClose={() => setTodosOpen(false)}
                />
              ) : null}
            </div>
            <div
              className={`absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                mountedSidePanel === "settings"
                  ? sidePanelContentVisible && visibleSidePanel === "settings"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none translate-x-4 opacity-0"
                  : "pointer-events-none translate-x-4 opacity-0"
              }`}
            >
              {mountedSidePanel === "settings" && settingsConfig ? (
                <Suspense fallback={null}>
                  <SettingsPanel
                    config={settingsConfig}
                    onChange={handleSettingsChange}
                    onMigrateDataDir={() => void handleMigrateDataDir()}
                    onClose={handleCloseSettings}
                  />
                </Suspense>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {noteMenu && noteMenuTarget && (
        <div
          ref={noteMenuRef}
          className={`popup-menu fixed z-[9999] min-w-[168px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none ${noteMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
          style={{
            left: noteMenuPosition?.x ?? noteMenu.x,
            top: noteMenuPosition?.y ?? noteMenu.y,
            maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {noteMenuMode === "main" ? (
            <div key="main" className="animate-menu-slide-right">
              {noteContextMenuItems.map((item, index) => (
                <button
                  key={item.action}
                  onClick={() => handleNoteMenuAction(item.action)}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-[12px] font-body transition-colors cursor-pointer ${
                    item.tone === "danger"
                      ? "text-red-400 hover:bg-danger-bg hover:text-red-500"
                      : "text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo"
                  } ${index > 0 ? "border-t border-paper-deep/20" : ""}`}
                >
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div key="move" className="animate-menu-slide-left">
              <button
                onClick={() => setNoteMenuMode("main")}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body text-ink-ghost hover:bg-paper-warm transition-colors cursor-pointer border-b border-paper-deep/20"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                <span>{t("common.back", { defaultValue: "返回" })}</span>
              </button>
              <button
                onClick={() => void handleMoveNote(noteMenuTarget.id, "")}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.category.uncategorized", { defaultValue: "未分类" })}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => void handleMoveNote(noteMenuTarget.id, cat)}
                  className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {categoryMenu && (
        <div
          ref={categoryMenuRef}
          className={`popup-menu fixed z-[9999] min-w-[140px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none ${categoryMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
          data-hover-suppressed={categoryMenuHoverSuppressed ? "" : undefined}
          style={{
            left: categoryMenuPosition?.x ?? categoryMenu.x,
            top: categoryMenuPosition?.y ?? categoryMenu.y,
            maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {categoryMenuConfirmDelete ? (
            <div key="category-confirm" className="animate-menu-slide-left">
              <div className="px-3 py-1.5 text-[11px] font-body text-ink-faint border-b border-paper-deep/20">
                {t("main.category.confirmDelete", {
                  category: categoryMenu.category,
                  defaultValue: "确认删除「{{category}}」？",
                })}
              </div>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  void handleDeleteCategory(categoryMenu.category);
                  setCategoryMenuClosing(true);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer outline-none"
              >
                {t("main.category.confirmDeleteAction", { defaultValue: "确认删除" })}
              </button>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => switchCategoryMenuPanel(false)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer outline-none"
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
            </div>
          ) : (
            <div key="category-main" className="animate-menu-slide-right">
              <button
                onClick={() => {
                  setCategoryMenuClosing(true);
                  setRenamingCategory(categoryMenu.category);
                  setRenameCategoryValue(categoryMenu.category);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.category.rename", { defaultValue: "重命名" })}
              </button>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => switchCategoryMenuPanel(true)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer border-t border-paper-deep/20 outline-none"
              >
                {t("main.category.delete", { defaultValue: "删除分类" })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   标签筛选栏
   ═══════════════════════════════════════════ */
function TagFilterBar({
  notes,
  selectedTag,
  open,
  onToggle,
  onSelectTag,
}: {
  notes: NoteMetadata[];
  selectedTag: string;
  open: boolean;
  onToggle: () => void;
  onSelectTag: (tag: string) => void;
}) {
  const allTags = useMemo(() => collectAllTags(notes), [notes]);

  if (allTags.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        className={`w-full h-7 flex items-center gap-2 px-2.5 rounded-lg text-[11px] font-body transition-colors cursor-pointer ${
          open || selectedTag
            ? "bg-bamboo-mist/45 text-bamboo"
            : "text-ink-faint hover:text-bamboo hover:bg-paper-warm/70"
        }`}
        aria-expanded={open}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <path d="M20.59 13.41 11.41 22.59a2 2 0 0 1-2.82 0L1.41 15.41A2 2 0 0 1 .83 14V4a2 2 0 0 1 2-2h10a2 2 0 0 1 1.41.59l7.18 7.18a2 2 0 0 1 0 2.82Z" />
          <circle cx="7" cy="7" r="1" />
        </svg>
        <span className="flex-1 text-left">标签</span>
        {selectedTag ? (
          <span className="max-w-[90px] truncate rounded-full bg-bamboo/10 px-1.5 py-0.5 text-[10px]">#{selectedTag}</span>
        ) : (
          <span className="text-[10px] text-ink-ghost">{allTags.length}</span>
        )}
      </button>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1 ml-4 border-l border-paper-deep/50 pl-2 py-1 space-y-0.5">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onSelectTag(tag)}
                className={`w-full flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-body transition-colors cursor-pointer ${
                  selectedTag === tag
                    ? "bg-bamboo-mist text-bamboo"
                    : "text-ink-faint hover:text-bamboo hover:bg-paper-warm/70"
                }`}
              >
                <span className="text-ink-ghost">#</span>
                <span className="truncate">{tag}</span>
              </button>
            ))}
            {selectedTag && (
              <button
                type="button"
                onClick={() => onSelectTag("")}
                className="w-full rounded-md px-2 py-1 text-left text-[10px] text-red-400 hover:bg-danger-bg transition-colors cursor-pointer"
              >
                清除标签筛选
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   标签编辑器
   ═══════════════════════════════════════════ */
function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const tag = input.trim();
    if (!tag || tags.includes(tag)) {
      setInput("");
      return;
    }
    onChange([...tags, tag]);
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bamboo-mist/60 border border-bamboo/20 text-[10px] text-bamboo"
        >
          #{tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="w-3 h-3 flex items-center justify-center rounded-full hover:bg-bamboo/20 transition-colors cursor-pointer"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </span>
      ))}
      <div className="inline-flex items-center gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")) {
              e.preventDefault();
              addTag();
            }
            if (e.key === "Backspace" && !input && tags.length > 0)
              removeTag(tags[tags.length - 1]);
          }}
          onBlur={addTag}
          placeholder="添加标签…"
          className="w-20 h-5 px-1.5 rounded text-[10px] font-body text-ink-soft placeholder:text-ink-ghost bg-transparent border border-transparent focus:border-paper-deep/40 focus:bg-paper-warm/50 outline-none transition-colors"
        />
      </div>
    </div>
  );
}

/** 将 Markdown 内容包装为完整 HTML 页面 */
function wrapHtml(title: string, markdown: string): string {
  const escaped = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { max-width: 800px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, BlinkMacSystemFont, "HarmonyOS Sans SC", "PingFang SC", sans-serif; font-size: 16px; line-height: 1.8; color: #2a2a26; background: #f6f3ec; }
  pre { background: #f0ebe0; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 14px; }
  code { background: #f0ebe0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre code { padding: 0; background: none; }
  blockquote { border-left: 3px solid #8a8a80; margin: 0; padding: 4px 16px; color: #5a5a52; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d0c8; padding: 8px 12px; text-align: left; }
  h1, h2, h3 { margin-top: 1.5em; margin-bottom: 0.5em; }
  img { max-width: 100%; }
  @media print { body { background: white; color: black; } }
</style>
</head>
<body>
<pre style="white-space: pre-wrap; font-family: inherit; background: none; padding: 0;">${escaped}</pre>
</body>
</html>`;
}
