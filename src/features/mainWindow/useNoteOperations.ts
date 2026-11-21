import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { TFunction } from "i18next";
import { showToast } from "../../components/Toast";
import { importMarkdownNote } from "../importExport/api";
import {
  batchAddTagsToNotes,
  batchDeleteNotes,
  batchExportNotesMarkdown,
  batchMoveNotesCategory,
  parseTagInput,
} from "../notes/bulkActions";
import {
  createNote,
  deleteNote,
  getErrorMessage,
  getFileModifiedTime,
  getNote,
  mergeNotes,
  moveNoteCategory,
  openDailyNote,
  prepareExternalFileImages,
  readExternalFile,
  restoreNoteVersion,
  updateNote,
} from "../notes/api";
import type { TodoItem } from "../notes/todoUtils";
import { toggleTodoInContent } from "../notes/todoUtils";
import type { ExternalFile, Note, NoteMetadata } from "../notes/types";
import type { NoteTemplate } from "../settings/types";
import { renderTemplateContent } from "./templates";
import type { SaveState } from "./types";
import type { LoadEpoch } from "./useLoadEpoch";

interface UseNoteOperationsOptions {
  t: TFunction;
  loadEpoch: LoadEpoch;
  selectedId: string | null;
  title: string;
  content: string;
  isExternal: boolean;
  saveState: SaveState;
  notes: NoteMetadata[];
  externalFiles: ExternalFile[];
  templates: NoteTemplate[];
  selectedTemplateId: string;
  activeCategory: string;
  searchText: string;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  selectedIdRef: MutableRefObject<string | null>;
  titleValueRef: MutableRefObject<string>;
  contentValueRef: MutableRefObject<string>;
  tagsValueRef: MutableRefObject<string[]>;
  pinnedValueRef: MutableRefObject<boolean>;
  saveStateRef: MutableRefObject<SaveState>;
  editRevisionRef: MutableRefObject<number>;
  externalFileMtimeRef: MutableRefObject<number>;
  setExternalFiles: Dispatch<SetStateAction<ExternalFile[]>>;
  setIsLoading: (loading: boolean) => void;
  setSelectedId: (id: string | null) => void;
  setTitle: (title: string) => void;
  setContent: (content: string) => void;
  setNoteTags: (tags: string[]) => void;
  setIsPinned: (pinned: boolean) => void;
  setExternalImageBaseDir: (dir: string | null) => void;
  setSaveState: (state: SaveState) => void;
  setNoteTransitionKey: Dispatch<SetStateAction<number>>;
  setDeleteConfirm: (confirm: boolean) => void;
  setActiveCategory: (category: string) => void;
  setNoteMenuClosing: (closing: boolean) => void;
  expandCategory: (category: string) => void;
  applyNote: (note: Note) => void;
  replaceNoteMetadata: (note: Note) => void;
  loadNote: (id: string) => Promise<boolean>;
  refreshNotes: () => Promise<NoteMetadata[]>;
  clearCurrentNote: () => void;
  saveCurrentNote: (force?: boolean) => Promise<boolean>;
  navPush: (noteId: string, title: string) => void;
  navRemove: (noteId: string) => void;
}

export function useNoteOperations({
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
  navPush,
  navRemove,
}: UseNoteOperationsOptions) {
  const handleNewNote = async (category?: string) => {
    // 保存失败不离开当前编辑上下文，避免旧内容被新笔记覆盖
    const saved = await saveCurrentNote();
    if (!saved) return;
    try {
      const targetCategory = category ?? activeCategory;
      const template = templates.find((item) => item.id === selectedTemplateId);
      const note = await createNote({
        title: "",
        content: template ? renderTemplateContent(template.content) : "",
        category: targetCategory,
      });
      replaceNoteMetadata(note);
      applyNote(note);
      setActiveCategory(targetCategory);
      expandCategory(targetCategory);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleToggleTodo = useCallback(
    async (note: Note, item: TodoItem, completed: boolean) => {
      // 待办面板读取的是独立快照；当前笔记可能还有编辑器中的未保存修改。
      // 先等待当前保存队列，再重新读取权威正文，避免用旧快照覆盖用户输入。
      if (selectedIdRef.current === note.id) {
        const saved = await saveCurrentNote();
        if (!saved) return;
      }

      const latest = await getNote(note.id);
      const nextContent = toggleTodoInContent(latest.content, item.line, completed);
      if (nextContent === latest.content) return;

      const updated = await updateNote(latest.id, {
        title: latest.title,
        content: nextContent,
        category: latest.category,
        tags: latest.tags,
        pinned: latest.pinned,
      });
      replaceNoteMetadata(updated);
      if (selectedIdRef.current === note.id) applyNote(updated);
    },
    [applyNote, replaceNoteMetadata, saveCurrentNote, selectedIdRef],
  );

  const handleOpenDailyNote = useCallback(async () => {
    try {
      const saved = await saveCurrentNote();
      if (!saved) return;
      const note = await openDailyNote();
      replaceNoteMetadata(note);
      applyNote(note);
      setActiveCategory(note.category);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [applyNote, replaceNoteMetadata, saveCurrentNote, setActiveCategory]);

  const handleRestoreNoteVersion = useCallback(
    async (versionId: string) => {
      if (!selectedId || isExternal) return;
      const saved = await saveCurrentNote();
      if (!saved) return;
      const note = await restoreNoteVersion(selectedId, versionId);
      replaceNoteMetadata(note);
      applyNote(note);
      showToast("已恢复历史版本");
    },
    [applyNote, isExternal, replaceNoteMetadata, saveCurrentNote, selectedId],
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

  const handleSelectNote = async (id: string): Promise<boolean> => {
    if (id === selectedId) return true;
    setDeleteConfirm(false);
    // 排队保存：等待可能在途的自动保存，并把尚未落盘的修改一并存掉；
    // 保存失败则不切换，避免旧编辑内容被新笔记覆盖
    const saved = await saveCurrentNote();
    if (!saved) return false;

    setIsLoading(true);
    try {
      // 只有本次加载真正生效（未被更新的切换打断）才推入导航历史
      const loaded = await loadNote(id);
      if (!loaded) return false;
      // 推入导航历史
      const noteMeta = notes.find((n) => n.id === id);
      if (noteMeta) {
        navPush(id, noteMeta.title || "无标题笔记");
      }
      return true;
    } catch (error) {
      showToast(getErrorMessage(error));
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectExternalFile = async (id: string): Promise<boolean> => {
    if (id === selectedId) return true;
    setDeleteConfirm(false);
    // 保存失败不切换外部文件，避免旧编辑内容被新文件覆盖
    const saved = await saveCurrentNote();
    if (!saved) return false;

    const file = externalFiles.find((f) => f.id === id);
    if (!file) return false;

    setIsLoading(true);
    const epoch = loadEpoch.bump();
    try {
      const [fileContent, mtime, externalImageDir] = await Promise.all([
        readExternalFile(file.filePath),
        getFileModifiedTime(file.filePath),
        prepareExternalFileImages(file.filePath).catch(() => null),
      ]);
      if (!loadEpoch.isCurrent(epoch)) return false;
      editRevisionRef.current += 1;
      selectedIdRef.current = id;
      titleValueRef.current = file.title;
      contentValueRef.current = fileContent;
      saveStateRef.current = "saved";
      setSelectedId(id);
      setTitle(file.title);
      setContent(fileContent);
      setNoteTags([]);
      setIsPinned(false);
      setExternalImageBaseDir(externalImageDir);
      tagsValueRef.current = [];
      pinnedValueRef.current = false;
      setSaveState("saved");
      setNoteTransitionKey((k) => k + 1);
      externalFileMtimeRef.current = mtime;
      navPush(id, file.title || "无标题文件");
      return true;
    } catch (error) {
      showToast(getErrorMessage(error));
      return false;
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
    navRemove(id);
    setExternalFiles((current) => current.filter((f) => f.id !== id));
    if (selectedId === id) {
      clearCurrentNote();
    }
  };

  const handleDeleteNote = async (noteId = selectedId) => {
    if (!noteId) return;

    setDeleteConfirm(false);
    try {
      // 删除当前笔记前先落盘未保存修改：保存失败则取消删除，
      // 避免未保存内容随笔记一起丢失
      if (selectedIdRef.current === noteId) {
        const needsSave = saveStateRef.current === "dirty" || saveStateRef.current === "error";
        const saved = needsSave ? await saveCurrentNote(true) : true;
        if (!saved) return;
      }
      await deleteNote(noteId);
      navRemove(noteId);
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

  const handleMoveNote = async (noteId: string, targetCategory: string) => {
    try {
      // Moving can relocate the backing file, so flush the active editor before changing metadata.
      if (noteId === selectedIdRef.current) {
        const saved = await saveCurrentNote(true);
        if (!saved) return;
      }
      setNoteMenuClosing(true);
      await moveNoteCategory(noteId, targetCategory);
      await refreshNotes();
      showToast(targetCategory ? "已整理到分类" : "已移至未分类");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleMergeNotes = async (targetId: string, sourceId: string) => {
    try {
      // 强制保存当前编辑并确认落盘，再基于权威数据合并
      const saved = await saveCurrentNote(true);
      if (!saved) return;
      const merged = await mergeNotes({ targetId, sourceId });
      await refreshNotes();
      if (selectedIdRef.current === targetId || selectedIdRef.current === sourceId) {
        applyNote(merged);
      }
      showToast("笔记已合并，原笔记已移入回收站");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleOpenWorkspaceNote = async (
    noteId: string,
    hitOffset?: number,
    hitLength?: number,
  ) => {
    const opened = await handleSelectNote(noteId);
    if (!opened || hitOffset == null || hitOffset < 0) return;
    window.requestAnimationFrame(() => {
      const textarea = contentRef.current;
      if (!textarea) return;
      // 优先用后端返回的真实命中词长度；搜索框文字已变化时回退到当前查询长度
      const matchedLength =
        hitLength != null && hitLength > 0 ? hitLength : Math.max(1, searchText.length);
      const end = Math.min(textarea.value.length, hitOffset + matchedLength);
      textarea.focus();
      textarea.setSelectionRange(hitOffset, end);
      const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 22;
      const line = textarea.value.slice(0, hitOffset).split("\n").length - 1;
      textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 3);
    });
  };

  const handleCreateNoteWithTitle = async (noteTitle: string) => {
    const saved = await saveCurrentNote();
    if (!saved) return;
    try {
      const note = await createNote({
        title: noteTitle,
        content: "",
        category: activeCategory,
      });
      replaceNoteMetadata(note);
      applyNote(note);
      expandCategory(activeCategory);
      requestAnimationFrame(() => {
        contentRef.current?.focus();
      });
    } catch (error) {
      showToast(getErrorMessage(error));
    }
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

  const flushActiveNoteIfIncluded = useCallback(
    async (noteIds: string[]): Promise<boolean> => {
      if (!selectedIdRef.current || isExternal || !noteIds.includes(selectedIdRef.current)) {
        return true;
      }
      if (saveStateRef.current === "dirty" || saveStateRef.current === "error") {
        return saveCurrentNote(true);
      }
      return true;
    },
    [isExternal, saveCurrentNote, saveStateRef, selectedIdRef],
  );

  const handleBatchMoveCategory = useCallback(
    async (noteIds: string[], targetCategory: string): Promise<string[]> => {
      if (noteIds.length === 0) return [];
      try {
        const flushed = await flushActiveNoteIfIncluded(noteIds);
        if (!flushed) return [];
        const result = await batchMoveNotesCategory(noteIds, targetCategory);
        await refreshNotes();
        if (result.succeededIds.length > 0) {
          showToast(
            t("bulkActions.movedToast", {
              count: result.succeededIds.length,
              defaultValue: "已移动 {{count}} 篇笔记",
            }),
            result.failedIds.length > 0 ? "warning" : "info",
          );
        } else if (result.failedIds.length > 0) {
          showToast(t("common.operationFailed", { defaultValue: "操作失败" }), "warning");
        }
        return result.succeededIds;
      } catch (error) {
        showToast(getErrorMessage(error));
        return [];
      }
    },
    [flushActiveNoteIfIncluded, refreshNotes, t],
  );

  const handleBatchAddTags = useCallback(
    async (noteIds: string[], rawTags: string): Promise<string[]> => {
      if (noteIds.length === 0 || parseTagInput(rawTags).length === 0) return [];
      try {
        const flushed = await flushActiveNoteIfIncluded(noteIds);
        if (!flushed) return [];
        const { updatedNotes, result } = await batchAddTagsToNotes(noteIds, rawTags);
        const currentId = selectedIdRef.current;
        if (currentId && !isExternal) {
          const updatedCurrent = updatedNotes.find((note) => note.id === currentId);
          if (updatedCurrent) {
            tagsValueRef.current = updatedCurrent.tags;
            setNoteTags(updatedCurrent.tags);
          }
        }
        await refreshNotes();
        if (result.succeededIds.length > 0) {
          showToast(
            t("bulkActions.taggedToast", {
              count: result.succeededIds.length,
              defaultValue: "已为 {{count}} 篇笔记添加标签",
            }),
            result.failedIds.length > 0 ? "warning" : "info",
          );
        } else if (result.skippedIds.length > 0 && result.failedIds.length === 0) {
          showToast(
            t("bulkActions.tagsAlreadyPresent", { defaultValue: "所选笔记已包含这些标签" }),
            "info",
          );
        } else if (result.failedIds.length > 0) {
          showToast(t("common.operationFailed", { defaultValue: "操作失败" }), "warning");
        }
        return result.succeededIds;
      } catch (error) {
        showToast(getErrorMessage(error));
        return [];
      }
    },
    [
      flushActiveNoteIfIncluded,
      isExternal,
      refreshNotes,
      selectedIdRef,
      setNoteTags,
      t,
      tagsValueRef,
    ],
  );

  const handleBatchExportMarkdown = useCallback(
    async (noteIds: string[]): Promise<boolean> => {
      if (noteIds.length === 0) return false;
      try {
        const flushed = await flushActiveNoteIfIncluded(noteIds);
        if (!flushed) return false;
        const noteMap = new Map(notes.map((note) => [note.id, note]));
        const targets = noteIds
          .map((id) => {
            const meta = noteMap.get(id);
            if (!meta) return null;
            return {
              id,
              title: id === selectedIdRef.current ? titleValueRef.current : meta.title,
            };
          })
          .filter((entry): entry is { id: string; title: string } => entry !== null);

        const { cancelled, result } = await batchExportNotesMarkdown(targets, { translate: t });
        if (cancelled) return false;
        if (result.succeededIds.length > 0) {
          showToast(
            t("bulkActions.exportedToast", {
              count: result.succeededIds.length,
              defaultValue: "已导出 {{count}} 篇 Markdown 笔记",
            }),
            result.failedIds.length > 0 ? "warning" : "info",
          );
        } else if (result.failedIds.length > 0) {
          showToast(t("common.operationFailed", { defaultValue: "操作失败" }), "warning");
        }
        return result.succeededIds.length > 0;
      } catch (error) {
        showToast(getErrorMessage(error));
        return false;
      }
    },
    [flushActiveNoteIfIncluded, notes, selectedIdRef, t, titleValueRef],
  );

  const handleBatchDeleteNotes = useCallback(
    async (noteIds: string[]): Promise<string[]> => {
      if (noteIds.length === 0) return [];
      try {
        const result = await batchDeleteNotes(noteIds);
        for (const deletedId of result.succeededIds) {
          navRemove(deletedId);
        }
        if (
          selectedIdRef.current &&
          !isExternal &&
          result.succeededIds.includes(selectedIdRef.current)
        ) {
          clearCurrentNote();
        }
        await refreshNotes();
        if (result.succeededIds.length > 0) {
          showToast(
            t("bulkActions.deletedToast", {
              count: result.succeededIds.length,
              defaultValue: "已删除 {{count}} 篇笔记",
            }),
            result.failedIds.length > 0 ? "warning" : "info",
          );
        } else if (result.failedIds.length > 0) {
          showToast(t("common.operationFailed", { defaultValue: "操作失败" }), "warning");
        }
        return result.succeededIds;
      } catch (error) {
        showToast(getErrorMessage(error));
        return [];
      }
    },
    [clearCurrentNote, isExternal, navRemove, refreshNotes, selectedIdRef, t],
  );

  return {
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
    handleBatchMoveCategory,
    handleBatchAddTags,
    handleBatchExportMarkdown,
    handleBatchDeleteNotes,
  };
}
