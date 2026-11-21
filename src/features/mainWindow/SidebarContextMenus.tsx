import type { RefObject } from "react";
import type { TFunction } from "i18next";
import { POPUP_VIEWPORT_MARGIN } from "../../components/popupPosition";
import type { NoteContextMenuAction, NoteContextMenuItem } from "../notes/noteContextMenu";
import type { NoteMetadata } from "../notes/types";
import type { CategoryMenuState, NoteMenuState } from "./types";

interface PopupPosition {
  x: number;
  y: number;
}

interface SidebarContextMenusProps {
  t: TFunction;
  noteMenu: NoteMenuState | null;
  noteMenuTarget: NoteMetadata | null;
  noteMenuClosing: boolean;
  noteMenuMode: "main" | "move";
  noteMenuRef: RefObject<HTMLDivElement | null>;
  noteMenuPosition: PopupPosition | null;
  noteContextMenuItems: NoteContextMenuItem[];
  categories: string[];
  onSetNoteMenuMode: (mode: "main" | "move") => void;
  onNoteMenuAction: (action: NoteContextMenuAction) => void;
  onMoveNote: (noteId: string, targetCategory: string) => void;
  categoryMenu: CategoryMenuState | null;
  categoryMenuClosing: boolean;
  categoryMenuConfirmDelete: boolean;
  categoryMenuHoverSuppressed: boolean;
  categoryMenuRef: RefObject<HTMLDivElement | null>;
  categoryMenuPosition: PopupPosition | null;
  onSwitchCategoryMenuPanel: (confirmDelete: boolean) => void;
  onConfirmDeleteCategory: (category: string) => void;
  onStartRenameCategory: (category: string) => void;
}

export function SidebarContextMenus({
  t,
  noteMenu,
  noteMenuTarget,
  noteMenuClosing,
  noteMenuMode,
  noteMenuRef,
  noteMenuPosition,
  noteContextMenuItems,
  categories,
  onSetNoteMenuMode,
  onNoteMenuAction,
  onMoveNote,
  categoryMenu,
  categoryMenuClosing,
  categoryMenuConfirmDelete,
  categoryMenuHoverSuppressed,
  categoryMenuRef,
  categoryMenuPosition,
  onSwitchCategoryMenuPanel,
  onConfirmDeleteCategory,
  onStartRenameCategory,
}: SidebarContextMenusProps) {
  return (
    <>
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
                  onClick={() => onNoteMenuAction(item.action)}
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
                onClick={() => onSetNoteMenuMode("main")}
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
                onClick={() => onMoveNote(noteMenuTarget.id, "")}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.category.uncategorized", { defaultValue: "未分类" })}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => onMoveNote(noteMenuTarget.id, cat)}
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
                onClick={() => onConfirmDeleteCategory(categoryMenu.category)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer outline-none"
              >
                {t("main.category.confirmDeleteAction", { defaultValue: "确认删除" })}
              </button>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSwitchCategoryMenuPanel(false)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer outline-none"
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
            </div>
          ) : (
            <div key="category-main" className="animate-menu-slide-right">
              <button
                onClick={() => onStartRenameCategory(categoryMenu.category)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.category.rename", { defaultValue: "重命名" })}
              </button>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSwitchCategoryMenuPanel(true)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer border-t border-paper-deep/20 outline-none"
              >
                {t("main.category.delete", { defaultValue: "删除分类" })}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
