import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { TFunction } from "i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { showToast } from "../../components/Toast";
import { cleanUnusedImages } from "../images/api";
import { exportMarkdownNote } from "../importExport/api";
import { exportMarkdownPdf, pdfFileName } from "../importExport/pdf";
import { createNote, getErrorMessage, saveExternalFile } from "../notes/api";
import type { NoteContextMenuAction } from "../notes/noteContextMenu";
import type { ExternalFile, Note, NoteMetadata } from "../notes/types";
import { resolveWikiLink, wikiLinkSyntax } from "../notes/wikiLinks";
import type { AppConfig, NoteTemplate } from "../settings/types";
import { toggleTileWindow } from "../windows/api";
import { syncPinnedTileIds } from "../windows/tileWindowEvents";
import { runEditorCommand } from "./editorFormatting";
import { wrapHtml } from "./htmlExport";

interface UseEditorActionsOptions {
  t: TFunction;
  selectedId: string | null;
  title: string;
  content: string;
  isExternal: boolean;
  selectedNote: NoteMetadata | null;
  selectedExternalFile: ExternalFile | null;
  noteMenuTarget: NoteMetadata | null;
  settingsConfig: AppConfig | null;
  allowRawHtml: boolean;
  imageBaseDir: string | null;
  externalImageBaseDir: string | null;
  activeCategory: string;
  pinnedTileIds: Set<string>;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  titleValueRef: MutableRefObject<string>;
  contentValueRef: MutableRefObject<string>;
  notesRef: MutableRefObject<NoteMetadata[]>;
  setContent: (content: string) => void;
  setExternalFiles: Dispatch<SetStateAction<ExternalFile[]>>;
  setPinnedTileIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectedTemplateId: (id: string) => void;
  setNoteMenuClosing: (closing: boolean) => void;
  setNoteMenuMode: (mode: "main" | "move") => void;
  markDirty: () => void;
  saveCurrentNote: (force?: boolean) => Promise<boolean>;
  handleSettingsChange: (config: AppConfig) => void;
  handleSelectNote: (id: string) => Promise<boolean>;
  handleDeleteNote: (noteId?: string | null) => Promise<void>;
  applyNote: (note: Note) => void;
  replaceNoteMetadata: (note: Note) => void;
  navPush: (noteId: string, title: string) => void;
  navRemove: (noteId: string) => void;
}

export function useEditorActions({
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
  navPush,
  navRemove,
}: UseEditorActionsOptions) {
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
  }, [content, handleSettingsChange, isExternal, setSelectedTemplateId, settingsConfig, title]);

  const handleExportHtml = async () => {
    if (!selectedId) return;
    try {
      const saved = await saveCurrentNote(true);
      if (!saved) return;
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
      const saved = await saveCurrentNote(true);
      if (!saved) return;
      const exportTitle = titleValueRef.current || "未命名";
      const filePath = await save({
        defaultPath: pdfFileName(exportTitle),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!filePath) return;

      await exportMarkdownPdf({
        path: filePath,
        title: exportTitle,
        markdown: contentValueRef.current,
        fontSize: settingsConfig?.fontSize ?? 14,
        renderHtml: allowRawHtml,
        imageBaseDir: isExternal ? undefined : (imageBaseDir ?? undefined),
        externalImageBaseDir: isExternal ? (externalImageBaseDir ?? undefined) : undefined,
        externalFilePath: selectedExternalFile?.filePath,
      });
      showToast(t("main.export.pdfSaved", { defaultValue: "PDF 已导出" }), "info");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleNoteMenuAction = (action: NoteContextMenuAction) => {
    const note = noteMenuTarget;
    if (!note) return;

    if (action === "export") {
      setNoteMenuClosing(true);
      void (async () => {
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
      })();
      return;
    }

    if (action === "move") {
      setNoteMenuMode("move");
      return;
    }

    if (action === "delete") {
      // 删除前确认：误点右键菜单直接删笔记不可恢复
      const confirmed = window.confirm(
        t("main.noteMenu.confirmDelete", {
          noteTitle: note.title.trim() || "无标题笔记",
          defaultValue: "确定删除「{{noteTitle}}」吗？",
        }),
      );
      if (!confirmed) return;
    }

    setNoteMenuClosing(true);
    void handleDeleteNote(note.id);
  };

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
    [handleSelectNote, notesRef],
  );

  const handlePinEntry = async () => {
    if (!selectedId) return;
    const currentId = selectedId;
    const pinnedNow = pinnedTileIds.has(currentId);
    if (!pinnedNow) {
      const saved = await saveCurrentNote();
      if (!saved) return;
    }
    try {
      let tileNoteId = currentId;
      if (selectedExternalFile) {
        const imported = await createNote({
          title: titleValueRef.current,
          content: contentValueRef.current,
          category: activeCategory,
        });
        tileNoteId = imported.id;
        setExternalFiles((current) => current.filter((file) => file.id !== currentId));
        navRemove(currentId);
        replaceNoteMetadata(imported);
        applyNote(imported);
        navPush(imported.id, imported.title || "无标题笔记");
      }

      const pinned = await toggleTileWindow(tileNoteId);
      setPinnedTileIds((previous) => syncPinnedTileIds(previous, tileNoteId, pinned));
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  return {
    handleSaveAsTemplate,
    handleExportHtml,
    handleExportPdf,
    handleNoteMenuAction,
    handleCleanUnusedImages,
    handleUndo,
    handleRedo,
    handleCopyStableLink,
    handleOpenWikiLink,
    handlePinEntry,
  };
}
