import type { MouseEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { TFunction } from "i18next";
import type { NotesWorkspaceMode } from "../../components/NotesWorkspacePanel";
import { formatShortDate, formatTime, getDisplayTitle } from "../notes/noteUtils";
import type { CategoryGroup } from "../notes/noteUtils";
import type { ExternalFile, NoteMetadata } from "../notes/types";
import type { SidebarActionId } from "../settings/sidebarOrder";
import type { NoteTemplate } from "../settings/types";
import { TagFilterBar } from "./TagFilterBar";
import type { SidebarPointerDragState, SidebarSortKind } from "./useSidebarPointerDrag";

interface SidebarNoteCardProps {
  t: TFunction;
  note: NoteMetadata;
  isSelected: boolean;
  isHovered: boolean;
  multiSelectMode: boolean;
  isBulkSelected: boolean;
  variant: "uncategorized" | "categorized";
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick: () => void;
  onToggleBulkSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function SidebarNoteCard({
  t,
  note,
  isSelected,
  isHovered,
  multiSelectMode,
  isBulkSelected,
  variant,
  onPointerDown,
  onClick,
  onToggleBulkSelect,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
}: SidebarNoteCardProps) {
  const paddingClass =
    variant === "uncategorized" ? "rounded-xl px-3 py-2.5" : "rounded-lg mx-1 px-2.5 py-2";
  const displayTitle = getDisplayTitle(note, t);
  return (
    <div
      onPointerDown={multiSelectMode ? undefined : onPointerDown}
      onClick={multiSelectMode ? onToggleBulkSelect : onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`w-full text-left ${paddingClass} transition-all duration-[600ms] cursor-pointer group relative ${
        multiSelectMode && isBulkSelected
          ? "bg-bamboo-mist/75 ring-1 ring-bamboo/35"
          : isSelected
            ? "bg-bamboo-mist/70"
            : isHovered
              ? "bg-paper-warm/70"
              : "bg-transparent"
      }`}
      style={variant === "categorized" ? { width: "calc(100% - 8px)" } : undefined}
    >
      <div
        className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
          isSelected && !multiSelectMode ? "h-5 opacity-100" : "h-0 opacity-0"
        }`}
      />
      <div className={multiSelectMode ? "flex items-start gap-2" : undefined}>
        {multiSelectMode && (
          <input
            type="checkbox"
            checked={isBulkSelected}
            onChange={onToggleBulkSelect}
            onClick={(event) => event.stopPropagation()}
            aria-label={displayTitle}
            className="mt-0.5 w-3.5 h-3.5 accent-bamboo rounded cursor-pointer shrink-0"
          />
        )}
        <div className={multiSelectMode ? "min-w-0 flex-1" : undefined}>
          <div className="flex items-baseline justify-between mb-0.5">
            <span
              className={`text-[13px] font-display font-medium truncate pr-2 transition-colors ${
                isSelected ? "text-bamboo" : "text-ink-soft"
              }`}
            >
              {displayTitle}
            </span>
            <span className="text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">
              {formatShortDate(note.updatedAt)}
            </span>
          </div>
          <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors">
            {note.preview || t("common.blankNote", { defaultValue: "空白笔记" })}
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
      </div>
    </div>
  );
}

interface MainSidebarProps {
  t: TFunction;
  sidebarCollapsed: boolean;
  focusMode: boolean;
  sidebarWidth: number;
  isResizingSidebar: boolean;
  onStartResizeSidebar: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  notes: NoteMetadata[];
  filteredNotes: NoteMetadata[];
  externalFiles: ExternalFile[];
  selectedId: string | null;
  hoveredId: string | null;
  onHoverId: (id: string | null) => void;
  tagFilter: string;
  tagFilterOpen: boolean;
  onToggleTagFilter: () => void;
  onSelectTagFilter: (tag: string) => void;
  selectedTemplateId: string;
  onSelectTemplateId: (id: string) => void;
  templates: NoteTemplate[];
  sidebarActionOrder: SidebarActionId[];
  inboxCount: number;
  categoryGroups: CategoryGroup[];
  collapsedCategories: Set<string>;
  dragOverCategory: string | null;
  activeSidebarPointerDrag: SidebarPointerDragState | null;
  showCategoryInput: boolean;
  categoryInputValue: string;
  onCategoryInputValueChange: (value: string) => void;
  onOpenCategoryInput: () => void;
  onCancelCategoryInput: () => void;
  onCreateCategory: () => void;
  renamingCategory: string | null;
  renameCategoryValue: string;
  onRenameCategoryValueChange: (value: string) => void;
  onCommitRenameCategory: (oldName: string) => void;
  onCancelRenameCategory: () => void;
  isLoading: boolean;
  sidebarScrollRef: RefObject<HTMLDivElement | null>;
  consumeSidebarPointerClick: () => boolean;
  beginSidebarPointerDrag: (
    event: ReactPointerEvent<HTMLElement>,
    kind: SidebarSortKind,
    sourceId: string,
  ) => void;
  beginSidebarNotePointerDrag: (
    event: ReactPointerEvent<HTMLElement>,
    noteId: string,
    sourceCategory: string,
  ) => void;
  sidebarActionDragClass: (action: SidebarActionId) => string;
  onOpenDailyNote: () => void;
  onOpenWorkspace: (mode: NotesWorkspaceMode) => void;
  onNewNote: (category?: string) => void;
  onToggleTodos: () => void;
  onImportNote: () => void;
  onSelectExternalFile: (id: string) => void;
  onRemoveExternalFile: (id: string) => void;
  onSelectNote: (id: string) => void;
  onOpenNoteMenu: (event: MouseEvent<HTMLElement>, noteId: string) => void;
  onToggleCategoryCollapse: (category: string) => void;
  onOpenCategoryMenu: (event: MouseEvent<HTMLElement>, category: string) => void;
  multiSelectMode: boolean;
  selectedNoteIds: Set<string>;
  onToggleMultiSelectMode: () => void;
  onToggleNoteSelection: (noteId: string) => void;
  onSelectAllNotes: () => void;
  onClearNoteSelection: () => void;
}

export function MainSidebar({
  t,
  sidebarCollapsed,
  focusMode,
  sidebarWidth,
  isResizingSidebar,
  onStartResizeSidebar,
  searchQuery,
  onSearchQueryChange,
  notes,
  filteredNotes,
  externalFiles,
  selectedId,
  hoveredId,
  onHoverId,
  tagFilter,
  tagFilterOpen,
  onToggleTagFilter,
  onSelectTagFilter,
  selectedTemplateId,
  onSelectTemplateId,
  templates,
  sidebarActionOrder,
  inboxCount,
  categoryGroups,
  collapsedCategories,
  dragOverCategory,
  activeSidebarPointerDrag,
  showCategoryInput,
  categoryInputValue,
  onCategoryInputValueChange,
  onOpenCategoryInput,
  onCancelCategoryInput,
  onCreateCategory,
  renamingCategory,
  renameCategoryValue,
  onRenameCategoryValueChange,
  onCommitRenameCategory,
  onCancelRenameCategory,
  isLoading,
  sidebarScrollRef,
  consumeSidebarPointerClick,
  beginSidebarPointerDrag,
  beginSidebarNotePointerDrag,
  sidebarActionDragClass,
  onOpenDailyNote,
  onOpenWorkspace,
  onNewNote,
  onToggleTodos,
  onImportNote,
  onSelectExternalFile,
  onRemoveExternalFile,
  onSelectNote,
  onOpenNoteMenu,
  onToggleCategoryCollapse,
  onOpenCategoryMenu,
  multiSelectMode,
  selectedNoteIds,
  onToggleMultiSelectMode,
  onToggleNoteSelection,
  onSelectAllNotes,
  onClearNoteSelection,
}: MainSidebarProps) {
  return (
    <>
      <div
        className="border-r border-paper-deep/30 bg-paper/40 shrink-0 overflow-hidden transition-[width] duration-[600ms] main-sidebar"
        style={{ width: sidebarCollapsed || focusMode ? 0 : sidebarWidth }}
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
                onChange={(event) => onSearchQueryChange(event.target.value)}
                placeholder={t("main.sidebar.searchPlaceholder", { defaultValue: "搜索笔记…" })}
                className="flex-1 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
              />
              {searchQuery && (
                <button
                  onClick={() => onSearchQueryChange("")}
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
              onToggle={onToggleTagFilter}
              onSelectTag={onSelectTagFilter}
            />
          </div>

          <div className="px-3 pb-2 shrink-0 flex flex-col gap-1">
            <select
              value={selectedTemplateId}
              onChange={(event) => onSelectTemplateId(event.target.value)}
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
              data-sidebar-sort-kind="action"
              data-sidebar-sort-id="daily"
              style={{ order: sidebarActionOrder.indexOf("daily") }}
              onPointerDown={(event) => beginSidebarPointerDrag(event, "action", "daily")}
              onClick={() => {
                if (consumeSidebarPointerClick()) return;
                onOpenDailyNote();
              }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer ${sidebarActionDragClass("daily")}`}
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
              data-sidebar-sort-kind="action"
              data-sidebar-sort-id="inbox"
              style={{ order: sidebarActionOrder.indexOf("inbox") }}
              onPointerDown={(event) => beginSidebarPointerDrag(event, "action", "inbox")}
              onClick={() => {
                if (consumeSidebarPointerClick()) return;
                onOpenWorkspace("inbox");
              }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer ${sidebarActionDragClass("inbox")}`}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 8v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
                <path d="M1 3h22v5H1zM10 12h4" />
              </svg>
              <span>收件箱</span>
              {inboxCount > 0 ? (
                <span className="ml-auto min-w-4 h-4 px-1 rounded-full bg-bamboo-mist text-[9px] leading-4 text-bamboo text-center">
                  {inboxCount}
                </span>
              ) : null}
            </button>
            <button
              data-sidebar-sort-kind="action"
              data-sidebar-sort-id="journal"
              style={{ order: sidebarActionOrder.indexOf("journal") }}
              onPointerDown={(event) => beginSidebarPointerDrag(event, "action", "journal")}
              onClick={() => {
                if (consumeSidebarPointerClick()) return;
                onOpenWorkspace("journal");
              }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer ${sidebarActionDragClass("journal")}`}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="4" width="18" height="17" rx="2" />
                <path d="M8 2v4M16 2v4M7 10h10M8 14h8M8 17h5" />
              </svg>
              <span>日记流</span>
            </button>
            <button
              data-sidebar-sort-kind="action"
              data-sidebar-sort-id="dashboard"
              style={{ order: sidebarActionOrder.indexOf("dashboard") }}
              onPointerDown={(event) => beginSidebarPointerDrag(event, "action", "dashboard")}
              onClick={() => {
                if (consumeSidebarPointerClick()) return;
                onOpenWorkspace("dashboard");
              }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer ${sidebarActionDragClass("dashboard")}`}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <span>笔记仪表盘</span>
            </button>
            <button
              data-sidebar-sort-kind="action"
              data-sidebar-sort-id="new-note"
              style={{ order: sidebarActionOrder.indexOf("new-note") }}
              onPointerDown={(event) => beginSidebarPointerDrag(event, "action", "new-note")}
              onClick={() => {
                if (consumeSidebarPointerClick()) return;
                onNewNote();
              }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-bamboo hover:bg-bamboo-mist/60 transition-all cursor-pointer group ${sidebarActionDragClass("new-note")}`}
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
              data-sidebar-sort-kind="action"
              data-sidebar-sort-id="todos"
              style={{ order: sidebarActionOrder.indexOf("todos") }}
              onPointerDown={(event) => beginSidebarPointerDrag(event, "action", "todos")}
              onClick={() => {
                if (consumeSidebarPointerClick()) return;
                onToggleTodos();
              }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer group ${sidebarActionDragClass("todos")}`}
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
              data-sidebar-sort-kind="action"
              data-sidebar-sort-id="import"
              style={{ order: sidebarActionOrder.indexOf("import") }}
              onPointerDown={(event) => beginSidebarPointerDrag(event, "action", "import")}
              onClick={() => {
                if (consumeSidebarPointerClick()) return;
                onImportNote();
              }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer group ${sidebarActionDragClass("import")}`}
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
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="toggle-multi-select"
                aria-pressed={multiSelectMode}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onToggleMultiSelectMode}
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors cursor-pointer ${
                  multiSelectMode
                    ? "text-bamboo bg-bamboo-mist/70"
                    : "text-ink-ghost hover:text-bamboo hover:bg-paper-warm/70"
                }`}
                title={t("bulkActions.toggleMode", { defaultValue: "批量选择" })}
                aria-label={t("bulkActions.toggleMode", { defaultValue: "批量选择" })}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="14" height="14" rx="2" />
                  <path d="m7 11 2.2 2.2L13.5 9" />
                  <path d="M21 8v11a2 2 0 0 1-2 2H8" />
                </svg>
              </button>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (showCategoryInput && categoryInputValue.trim()) {
                    onCreateCategory();
                    return;
                  }
                  onOpenCategoryInput();
                }}
                className="w-5 h-5 flex items-center justify-center rounded text-ink-ghost hover:text-bamboo transition-colors cursor-pointer"
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
          </div>

          {multiSelectMode && (
            <div
              data-testid="sidebar-multiselect-bar"
              className="mx-3 mb-1.5 px-2.5 py-1.5 rounded-lg bg-bamboo-mist/45 border border-bamboo/20 flex items-center justify-between gap-2 shrink-0"
            >
              <span className="text-[11px] font-mono text-bamboo tabular-nums">
                {t("bulkActions.selectedCount", {
                  count: selectedNoteIds.size,
                  defaultValue: "已选 {{count}} 项",
                })}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onSelectAllNotes}
                  className="text-[11px] text-ink-soft hover:text-bamboo transition-colors cursor-pointer"
                >
                  {t("bulkActions.selectAll", { defaultValue: "全选" })}
                </button>
                <span className="text-ink-ghost/40 text-[10px]">·</span>
                <button
                  type="button"
                  onClick={onClearNoteSelection}
                  className="text-[11px] text-ink-faint hover:text-ink-soft transition-colors cursor-pointer"
                >
                  {t("bulkActions.clearSelection", { defaultValue: "清空" })}
                </button>
              </div>
            </div>
          )}

          {showCategoryInput && (
            <div className="px-3 pb-2 shrink-0">
              <input
                type="text"
                autoFocus
                value={categoryInputValue}
                onChange={(e) => onCategoryInputValueChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCreateCategory();
                  if (e.key === "Escape") onCancelCategoryInput();
                }}
                onBlur={onCreateCategory}
                placeholder={t("main.category.placeholder", { defaultValue: "输入分类名…" })}
                className="w-full px-2.5 h-7 rounded-lg text-[12px] font-body text-ink bg-paper-warm/80 border border-paper-deep/40 focus:border-bamboo/30 placeholder:text-ink-ghost/60"
              />
            </div>
          )}

          <div ref={sidebarScrollRef} className="flex-1 overflow-y-auto px-2 pb-2">
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
                        onClick={() => onSelectExternalFile(file.id)}
                        onMouseEnter={() => onHoverId(file.id)}
                        onMouseLeave={() => onHoverId(null)}
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
                              onRemoveExternalFile(file.id);
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
                      data-sidebar-note-drop-category=""
                      className={`rounded-lg transition-all duration-200 ${
                        dragOverCategory === "" ? "bg-bamboo/10 ring-1 ring-bamboo/20" : ""
                      }`}
                    >
                      {group.notes.map((note) => (
                        <SidebarNoteCard
                          key={note.id}
                          t={t}
                          note={note}
                          isSelected={note.id === selectedId}
                          isHovered={note.id === hoveredId}
                          multiSelectMode={multiSelectMode}
                          isBulkSelected={selectedNoteIds.has(note.id)}
                          variant="uncategorized"
                          onPointerDown={(event) =>
                            beginSidebarNotePointerDrag(event, note.id, note.category)
                          }
                          onClick={() => {
                            if (consumeSidebarPointerClick()) return;
                            onSelectNote(note.id);
                          }}
                          onToggleBulkSelect={() => onToggleNoteSelection(note.id)}
                          onContextMenu={(event) => onOpenNoteMenu(event, note.id)}
                          onMouseEnter={() => onHoverId(note.id)}
                          onMouseLeave={() => onHoverId(null)}
                        />
                      ))}
                    </div>
                  );
                }

                const isCollapsed = collapsedCategories.has(group.category);
                const isSidebarCategorySource =
                  activeSidebarPointerDrag?.kind === "category" &&
                  activeSidebarPointerDrag.sourceId === group.category;
                const isSidebarCategoryTarget =
                  activeSidebarPointerDrag?.kind === "category" &&
                  activeSidebarPointerDrag.targetId === group.category &&
                  !isSidebarCategorySource;

                return (
                  <div
                    key={group.category}
                    data-sidebar-note-drop-category={group.category}
                    className="px-2 mb-0.5"
                  >
                    <div
                      data-sidebar-sort-kind="category"
                      data-sidebar-sort-id={group.category}
                      onPointerDown={(event) =>
                        beginSidebarPointerDrag(event, "category", group.category)
                      }
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg group/cat cursor-pointer select-none transition-all duration-200 ${
                        isSidebarCategoryTarget || dragOverCategory === group.category
                          ? "bg-bamboo/15 border border-bamboo/40 ring-1 ring-bamboo/20"
                          : isCollapsed
                            ? "bg-transparent border border-bamboo/15"
                            : "bg-bamboo/8 border border-bamboo/15 rounded-b-none"
                      } ${isSidebarCategorySource ? "opacity-50" : ""}`}
                      onClick={() => {
                        if (consumeSidebarPointerClick()) return;
                        onToggleCategoryCollapse(group.category);
                      }}
                      onContextMenu={(e) => onOpenCategoryMenu(e, group.category)}
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
                          onChange={(e) => onRenameCategoryValueChange(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") onCommitRenameCategory(group.category);
                            if (e.key === "Escape") onCancelRenameCategory();
                          }}
                          onBlur={() => onCommitRenameCategory(group.category)}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 min-w-0 px-1 text-[10px] font-mono text-ink bg-paper-warm/80 border border-bamboo/30 rounded"
                        />
                      ) : (
                        <span className="text-[11px] text-bamboo/70 font-medium truncate">
                          {group.category}
                        </span>
                      )}
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onNewNote(group.category);
                        }}
                        className="ml-auto w-5 h-5 flex items-center justify-center rounded text-bamboo/45 hover:text-bamboo hover:bg-bamboo/10 transition-colors cursor-pointer"
                        title={t("main.category.newNoteIn", {
                          category: group.category,
                          defaultValue: `在「${group.category}」中新建笔记`,
                        })}
                        aria-label={t("main.category.newNoteIn", {
                          category: group.category,
                          defaultValue: `在「${group.category}」中新建笔记`,
                        })}
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      </button>
                      <span className="text-[9px] text-bamboo/40 font-mono shrink-0">
                        {group.notes.length}
                      </span>
                    </div>

                    <div className={`category-body ${isCollapsed ? "" : "expanded"}`}>
                      <div className="category-body-inner bg-bamboo/[0.03] border border-t-0 border-bamboo/10 rounded-b-lg pb-1 pt-1">
                        {group.notes.length === 0 ? (
                          <div className="px-3 py-3 text-center text-[11px] text-ink-ghost/50">
                            {t("main.category.emptyFolder", { defaultValue: "空文件夹" })}
                          </div>
                        ) : (
                          group.notes.map((note) => (
                            <SidebarNoteCard
                              key={note.id}
                              t={t}
                              note={note}
                              isSelected={note.id === selectedId}
                              isHovered={note.id === hoveredId}
                              multiSelectMode={multiSelectMode}
                              isBulkSelected={selectedNoteIds.has(note.id)}
                              variant="categorized"
                              onPointerDown={(event) =>
                                beginSidebarNotePointerDrag(event, note.id, note.category)
                              }
                              onClick={() => {
                                if (consumeSidebarPointerClick()) return;
                                onSelectNote(note.id);
                              }}
                              onToggleBulkSelect={() => onToggleNoteSelection(note.id)}
                              onContextMenu={(event) => onOpenNoteMenu(event, note.id)}
                              onMouseEnter={() => onHoverId(note.id)}
                              onMouseLeave={() => onHoverId(null)}
                            />
                          ))
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
            onStartResizeSidebar();
          }}
        >
          <div
            className={`absolute inset-y-0 -left-1 -right-1 ${isResizingSidebar ? "" : "group-hover:bg-bamboo/5"}`}
          />
        </div>
      )}
    </>
  );
}
