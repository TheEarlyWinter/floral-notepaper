import type { TFunction } from "i18next";
import { SlidingButtonGroup } from "../../components/SlidingButtonGroup";
import type { NoteMetadata } from "../notes/types";
import type { ViewMode } from "../settings/types";
import type { SaveState } from "./types";

export function pinTileButtonTitle(isPinned: boolean): string {
  return isPinned ? "取消钉屏" : "钉到屏幕";
}

interface EditorToolbarProps {
  t: TFunction;
  settingsOpen: boolean;
  aboutOpen: boolean;
  focusMode: boolean;
  readingMode: boolean;
  toolbarCollapsed: boolean;
  sidebarCollapsed: boolean;
  effectiveViewMode: ViewMode;
  outlineOpen: boolean;
  selectedId: string | null;
  isExternal: boolean;
  selectedNote: NoteMetadata | null;
  content: string;
  isPinned: boolean;
  selectedTilePinned: boolean;
  saveState: SaveState;
  deleteConfirm: boolean;
  deleteExiting: boolean;
  viewMode: ViewMode;
  viewModeOptions: { value: ViewMode; label: string }[];
  onToggleSidebar: () => void;
  onToggleOutline: () => void;
  onToggleHistory: () => void;
  onToggleBacklinks: () => void;
  onToggleKnowledgeGraph: () => void;
  onCopyStableLink: () => void;
  onToggleReminders: () => void;
  onToggleLibrary: () => void;
  onToggleFocusMode: () => void;
  onExitFocusMode: () => void;
  onToggleReadingMode: () => void;
  onExitReadingMode: () => void;
  onSaveAsTemplate: () => void;
  onTogglePinNote: () => void;
  onPinEntry: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onExportHtml: () => void;
  onExportPdf: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onSetToolbarCollapsed: (collapsed: boolean) => void;
  onToggleToolbarCollapsed: () => void;
}

export function EditorToolbar({
  t,
  settingsOpen,
  aboutOpen,
  focusMode,
  readingMode,
  toolbarCollapsed,
  sidebarCollapsed,
  effectiveViewMode,
  outlineOpen,
  selectedId,
  isExternal,
  selectedNote,
  content,
  isPinned,
  selectedTilePinned,
  saveState,
  deleteConfirm,
  deleteExiting,
  viewMode,
  viewModeOptions,
  onToggleSidebar,
  onToggleOutline,
  onToggleHistory,
  onToggleBacklinks,
  onToggleKnowledgeGraph,
  onCopyStableLink,
  onToggleReminders,
  onToggleLibrary,
  onToggleFocusMode,
  onExitFocusMode,
  onToggleReadingMode,
  onExitReadingMode,
  onSaveAsTemplate,
  onTogglePinNote,
  onPinEntry,
  onUndo,
  onRedo,
  onSave,
  onExportHtml,
  onExportPdf,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onViewModeChange,
  onSetToolbarCollapsed,
  onToggleToolbarCollapsed,
}: EditorToolbarProps) {
  return (
    <div
      className={`flex items-center h-10 border-b border-paper-deep/20 shrink-0 bg-paper/20 transition-all duration-200 ${
        settingsOpen || aboutOpen || focusMode || toolbarCollapsed
          ? "justify-end px-2"
          : "justify-between px-4"
      }`}
    >
      <div
        className={`flex items-center gap-1.5 overflow-hidden transition-[max-width,opacity] duration-200 ${
          settingsOpen || aboutOpen || focusMode || toolbarCollapsed
            ? "max-w-0 opacity-0 pointer-events-none"
            : "max-w-[900px] opacity-100"
        }`}
      >
        <button
          onClick={onToggleSidebar}
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
          onClick={onToggleOutline}
          className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all cursor-pointer ${
            outlineOpen && (effectiveViewMode === "split" || effectiveViewMode === "preview")
              ? "text-bamboo bg-bamboo-mist/50"
              : "text-ink-ghost hover:text-ink-faint hover:bg-paper-warm"
          }`}
          title="目录大纲"
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
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </button>

        <button
          onClick={onToggleHistory}
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
          onClick={onToggleBacklinks}
          disabled={!selectedId || isExternal}
          aria-label="反向链接"
          title="反向链接"
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
            <path d="M10 13a5 5 0 0 0 7.07.07l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15" />
            <path d="M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 12 20l1.15-1.15" />
          </svg>
        </button>
        <button
          onClick={onToggleKnowledgeGraph}
          aria-label="知识图谱"
          title="知识图谱"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-paper-warm transition-all cursor-pointer"
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
            <circle cx="6" cy="8" r="2.5" />
            <circle cx="17" cy="5" r="2" />
            <circle cx="12" cy="16" r="3" />
            <line x1="8" y1="9.2" x2="14.7" y2="6.3" />
            <line x1="10" y1="9" x2="11.2" y2="13.5" />
            <line x1="13.7" y1="7.2" x2="14.5" y2="13" />
          </svg>
        </button>
        <button
          onClick={onCopyStableLink}
          disabled={!selectedNote || isExternal}
          aria-label="复制稳定链接"
          title="复制稳定链接"
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
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" />
          </svg>
        </button>
        <button
          onClick={onToggleReminders}
          disabled={!selectedId || isExternal}
          aria-label="添加提醒"
          title="添加提醒"
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
            <circle cx="12" cy="13" r="8" />
            <path d="M12 9v4l2.5 1.5M9 3h6M12 3v2" />
          </svg>
        </button>
        <button
          onClick={onToggleLibrary}
          aria-label="资料与备份"
          title="资料与备份"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-paper-warm transition-all cursor-pointer"
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
            <path d="M4 4h16v16H4z" />
            <path d="M8 4v16M11 9h5M11 13h5" />
          </svg>
        </button>
        <button
          onClick={onToggleFocusMode}
          aria-label={focusMode ? "退出专注写作" : "专注写作"}
          title={focusMode ? "退出专注写作" : "专注写作"}
          className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all cursor-pointer ${focusMode ? "text-bamboo bg-bamboo-mist" : "text-ink-ghost hover:text-bamboo hover:bg-paper-warm"}`}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
        <button
          onClick={onToggleReadingMode}
          aria-label={readingMode ? "退出阅读模式" : "沉浸阅读"}
          title={readingMode ? "退出阅读模式" : "沉浸阅读"}
          className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all cursor-pointer ${readingMode ? "text-bamboo bg-bamboo-mist" : "text-ink-ghost hover:text-bamboo hover:bg-paper-warm"}`}
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
            <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z" />
            <path d="M4 5.5v16M8 7h8M8 11h8M8 15h5" />
          </svg>
        </button>
        <button
          onClick={onSaveAsTemplate}
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
          onClick={onTogglePinNote}
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
          onClick={onPinEntry}
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
          onClick={onUndo}
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
          onClick={onRedo}
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
          onClick={onSave}
          disabled={!selectedId || saveState === "saving"}
          className="px-3 h-7 flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          title={t("common.save", { defaultValue: "保存" })}
        >
          {t("common.save", { defaultValue: "保存" })}
        </button>

        {/* 导出按钮 */}
        {!isExternal && selectedId && (
          <>
            <div className="h-4 w-px bg-paper-deep/20" />
            <button
              onClick={onExportHtml}
              disabled={!selectedId}
              className="px-2.5 h-7 flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              title={t("main.export.html", { defaultValue: "导出 HTML" })}
            >
              HTML
            </button>
            <button
              onClick={onExportPdf}
              disabled={!selectedId}
              className="px-2.5 h-7 flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
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
              onClick={onConfirmDelete}
              className="px-2 h-6 rounded-md text-[11px] text-cloud bg-red-400 hover:bg-red-500 transition-colors cursor-pointer whitespace-nowrap outline-none"
            >
              {t("common.delete", { defaultValue: "删除" })}
            </button>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={onCancelDelete}
              className="px-2 h-6 rounded-md text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer outline-none"
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
          </div>
        ) : (
          <button
            onClick={onRequestDelete}
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

      {!settingsOpen && !aboutOpen && !focusMode && !toolbarCollapsed && (
        <SlidingButtonGroup
          options={viewModeOptions}
          value={viewMode}
          onChange={onViewModeChange}
          buttonClassName="px-3.5 py-1"
        />
      )}
      {(toolbarCollapsed || settingsOpen || aboutOpen) && (
        <button
          type="button"
          onClick={() => {
            // 收纳态可点击文字直接展开；设置/关于打开时保持只读提示
            if (toolbarCollapsed && !settingsOpen && !aboutOpen && !focusMode) {
              onSetToolbarCollapsed(false);
            }
          }}
          className={`px-2 text-[11px] font-body ${
            toolbarCollapsed && !settingsOpen && !aboutOpen && !focusMode
              ? "text-ink-ghost hover:text-ink-faint cursor-pointer"
              : "text-ink-ghost cursor-default"
          }`}
          title={
            toolbarCollapsed && !settingsOpen && !aboutOpen && !focusMode
              ? t("main.toolbar.expand", { defaultValue: "点击展开工具栏" })
              : undefined
          }
        >
          {toolbarCollapsed
            ? t("main.toolbar.collapsedLabel", { defaultValue: "工具栏已收纳" })
            : settingsOpen
              ? "设置已打开"
              : "关于已打开"}
        </button>
      )}
      {!settingsOpen && !aboutOpen && !focusMode && (
        <button
          type="button"
          onClick={onToggleToolbarCollapsed}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer"
          title={
            toolbarCollapsed
              ? t("main.toolbar.expand", { defaultValue: "展开工具栏" })
              : t("main.toolbar.collapse", { defaultValue: "收纳工具栏" })
          }
          aria-label={
            toolbarCollapsed
              ? t("main.toolbar.expand", { defaultValue: "展开工具栏" })
              : t("main.toolbar.collapse", { defaultValue: "收纳工具栏" })
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
            aria-hidden="true"
          >
            {toolbarCollapsed ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
          </svg>
        </button>
      )}
      {focusMode && (
        <button
          type="button"
          onClick={onExitFocusMode}
          className="px-2 text-[11px] text-bamboo cursor-pointer"
        >
          退出专注
        </button>
      )}
      {readingMode && (
        <button
          type="button"
          onClick={onExitReadingMode}
          className="px-2 text-[11px] text-bamboo cursor-pointer"
        >
          退出阅读
        </button>
      )}
    </div>
  );
}
