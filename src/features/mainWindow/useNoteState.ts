import { useCallback, useMemo, useRef, useState } from "react";
import { showToast } from "../../components/Toast";
import {
  getErrorMessage,
  getFileModifiedTime,
  getNote,
  listCategories,
  listNotes,
  prepareExternalFileImages,
  readExternalFile,
} from "../notes/api";
import { metadataFromNote } from "../notes/noteUtils";
import type { ExternalFile, Note, NoteMetadata } from "../notes/types";
import { canRenderRawHtml } from "../markdown/renderPolicy";
import type { AppConfig } from "../settings/types";
import type { SaveState } from "./types";
import { useLoadEpoch } from "./useLoadEpoch";

interface UseNoteStateOptions {
  settingsConfig: AppConfig | null;
  setCategories: (categories: string[]) => void;
  navPush: (noteId: string, title: string) => void;
}

export function useNoteState({ settingsConfig, setCategories, navPush }: UseNoteStateOptions) {
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [externalFiles, setExternalFiles] = useState<ExternalFile[]>([]);
  const [externalImageBaseDir, setExternalImageBaseDir] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [noteTags, setNoteTags] = useState<string[]>([]);
  const [isPinned, setIsPinned] = useState(false);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [isLoading, setIsLoading] = useState(true);
  const [noteTransitionKey, setNoteTransitionKey] = useState(0);

  const loadEpoch = useLoadEpoch();
  const externalFileMtimeRef = useRef<number>(0);
  const lastExternalSaveRef = useRef<number>(0);
  // 每次用户编辑都会递增；保存完成时用它判断保存期间是否又产生了新修改，
  // 避免标签/置顶等不在正文里的修改被旧保存结果误标为“已保存”。
  const editRevisionRef = useRef(0);

  const saveStateRef = useRef(saveState);
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
  const isExternal = selectedExternalFile !== null;
  const allowRawHtml = canRenderRawHtml(isExternal, settingsConfig?.renderHtmlMarkdown ?? false);
  const isExternalRef = useRef(isExternal);
  isExternalRef.current = isExternal;

  const applyNote = useCallback(
    (note: Note) => {
      loadEpoch.bump();
      const isSameNote =
        selectedIdRef.current === note.id &&
        titleValueRef.current === note.title &&
        contentValueRef.current === note.content;
      if (isSameNote) {
        // 内容未变化的回环（如保存完成后的 notes-changed 事件）：
        // 不重置编辑器，保留光标位置与 undo 历史栈，只同步元数据
        const nextTags = note.tags || [];
        const nextPinned = note.pinned || false;
        tagsValueRef.current = nextTags;
        pinnedValueRef.current = nextPinned;
        setNoteTags(nextTags);
        setIsPinned(nextPinned);
        setExternalImageBaseDir(null);
        return;
      }
      editRevisionRef.current += 1;
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
      setExternalImageBaseDir(null);
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
    async (id: string): Promise<boolean> => {
      const epoch = loadEpoch.bump();
      const note = await getNote(id);
      // 加载期间用户又切换/加载了别的笔记，丢弃本次结果
      if (!loadEpoch.isCurrent(epoch)) return false;
      applyNote(note);
      replaceNoteMetadata(note);
      return true;
    },
    [applyNote, replaceNoteMetadata, loadEpoch],
  );

  const refreshNotes = useCallback(async () => {
    const [loadedNotes, loadedCategories] = await Promise.all([listNotes(), listCategories()]);
    setNotes(loadedNotes);
    setCategories(loadedCategories);
    return loadedNotes;
  }, [setCategories]);

  const clearCurrentNote = useCallback(() => {
    loadEpoch.bump();
    editRevisionRef.current += 1;
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
    setExternalImageBaseDir(null);
    setSaveState("idle");
  }, [loadEpoch]);

  const loadExternalFile = useCallback(
    async (filePath: string) => {
      const epoch = loadEpoch.bump();
      try {
        const [fileContent, mtime, externalImageDir] = await Promise.all([
          readExternalFile(filePath),
          getFileModifiedTime(filePath),
          prepareExternalFileImages(filePath).catch(() => null),
        ]);
        const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
        const displayTitle = fileName.replace(/\.(md|markdown|txt)$/i, "");

        setExternalFiles((current) => {
          if (current.some((f) => f.id === filePath)) {
            return current;
          }
          return [...current, { id: filePath, title: displayTitle, filePath }];
        });

        if (!loadEpoch.isCurrent(epoch)) return;
        editRevisionRef.current += 1;
        selectedIdRef.current = filePath;
        titleValueRef.current = displayTitle;
        contentValueRef.current = fileContent;
        saveStateRef.current = "saved";
        setSelectedId(filePath);
        setTitle(displayTitle);
        setContent(fileContent);
        setNoteTags([]);
        setIsPinned(false);
        setExternalImageBaseDir(externalImageDir);
        tagsValueRef.current = [];
        pinnedValueRef.current = false;
        setSaveState("saved");
        setNoteTransitionKey((k) => k + 1);
        externalFileMtimeRef.current = mtime;
        navPush(filePath, displayTitle || "无标题文件");
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [loadEpoch, navPush],
  );

  return {
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
  };
}
