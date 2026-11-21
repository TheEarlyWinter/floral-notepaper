import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { TFunction } from "i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showToast } from "../../components/Toast";
import { saveImageFromPath } from "../images/api";
import { insertTextAtCursor } from "../images/useImagePaste";
import {
  ackReminder,
  getErrorMessage,
  getFileModifiedTime,
  getNote,
  listCategories,
  listNotes,
  listReminders,
  readExternalFile,
} from "../notes/api";
import type { ExternalFile, Note, NoteMetadata, Reminder } from "../notes/types";
import { useExternalSync } from "../notes/useExternalSync";
import { getConfig, normalizeViewMode } from "../settings/api";
import type { AppConfig, ViewMode } from "../settings/types";
import { isCurrentWindowMaximized } from "../windows/controls";
import {
  TILE_WINDOW_CLOSED_EVENT,
  TILE_WINDOW_UNPINNED_EVENT,
  syncPinnedTileIds,
} from "../windows/tileWindowEvents";
import type { SaveState } from "./types";
import type { LoadEpoch } from "./useLoadEpoch";

interface UseMainWindowSyncOptions {
  t: TFunction;
  loadEpoch: LoadEpoch;
  saveQueueRef: MutableRefObject<Promise<unknown>>;
  saveStateRef: MutableRefObject<SaveState>;
  selectedIdRef: MutableRefObject<string | null>;
  selectedNoteRef: MutableRefObject<NoteMetadata | null>;
  isExternalRef: MutableRefObject<boolean>;
  contentValueRef: MutableRefObject<string>;
  editRevisionRef: MutableRefObject<number>;
  externalFileMtimeRef: MutableRefObject<number>;
  lastExternalSaveRef: MutableRefObject<number>;
  windowLabelRef: MutableRefObject<string>;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  handleSelectNoteRef: MutableRefObject<(id: string) => Promise<boolean>>;
  selectedExternalFile: ExternalFile | null;
  setIsLoading: (loading: boolean) => void;
  setSettingsConfig: (config: AppConfig | null) => void;
  setSavedDataDir: (dir: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setNotes: Dispatch<SetStateAction<NoteMetadata[]>>;
  setCategories: Dispatch<SetStateAction<string[]>>;
  setCollapsedCategories: Dispatch<SetStateAction<Set<string>>>;
  setContent: (content: string) => void;
  setSaveState: (state: SaveState) => void;
  setSettingsOverlay: (overlay: boolean) => void;
  setPinnedTileIds: Dispatch<SetStateAction<Set<string>>>;
  setRemindersRefreshKey: Dispatch<SetStateAction<number>>;
  setIsMaximized: (maximized: boolean) => void;
  applyNote: (note: Note) => void;
  replaceNoteMetadata: (note: Note) => void;
  loadNote: (id: string) => Promise<boolean>;
  refreshNotes: () => Promise<NoteMetadata[]>;
  clearCurrentNote: () => void;
  loadExternalFile: (filePath: string) => Promise<void>;
  openAboutPanel: () => void;
  navPush: (noteId: string, title: string) => void;
  navReplaceCurrent: (noteId: string, title: string) => void;
  takeStartupFile: () => Promise<string | null>;
}

export function useMainWindowSync({
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
  navPush,
  navReplaceCurrent,
  takeStartupFile,
}: UseMainWindowSyncOptions) {
  useEffect(() => {
    try {
      windowLabelRef.current = getCurrentWindow().label;
    } catch {
      windowLabelRef.current = "main";
    }
  }, [windowLabelRef]);

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
          if (!cancelled) {
            applyNote(note);
            navPush(note.id, note.title || "无标题笔记");
          }
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
  }, [
    applyNote,
    clearCurrentNote,
    loadExternalFile,
    navPush,
    setCategories,
    setCollapsedCategories,
    setIsLoading,
    setNotes,
    setSavedDataDir,
    setSettingsConfig,
    setViewMode,
    takeStartupFile,
  ]);

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
            void saveQueueRef.current.then(() => {
              if (isStale()) return;
              if (selectedIdRef.current !== currentId) return;
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
                    navReplaceCurrent(note.id, note.title || "无标题笔记");
                  })
                  .catch(() => undefined);
              }
            });
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
  }, [
    applyNote,
    clearCurrentNote,
    loadEpoch,
    loadNote,
    navReplaceCurrent,
    refreshNotes,
    replaceNoteMetadata,
    saveQueueRef,
    saveStateRef,
    selectedIdRef,
    selectedNoteRef,
  ]);

  useExternalSync({
    refreshNotes,
    getActiveNoteId: () => (!isExternalRef.current ? selectedIdRef.current : null),
    isDirty: () =>
      saveStateRef.current === "dirty" ||
      saveStateRef.current === "error" ||
      saveStateRef.current === "saving",
    getSyncEpoch: () => loadEpoch.peek(),
    onApplyNote: (note) => {
      applyNote(note);
      replaceNoteMetadata(note);
      navReplaceCurrent(
        note.id,
        note.title || t("common.untitledNote", { defaultValue: "无标题笔记" }),
      );
    },
    onActiveNoteDeleted: (loaded) => {
      if (!selectedNoteRef.current) return;
      if (loaded[0]) {
        void loadNote(loaded[0].id);
      } else {
        clearCurrentNote();
      }
    },
    onDirtyConflict: () => {
      showToast(
        t("main.externalSync.dirtyConflict", {
          defaultValue: "检测到外部笔记更改，已保留当前未保存的本地编辑",
        }),
        "warning",
      );
    },
    onRefreshReminders: async () => {
      setRemindersRefreshKey((key) => key + 1);
      await listReminders();
    },
  });

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
  }, [setSettingsOverlay]);

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
  }, [
    contentRef,
    isExternalRef,
    loadExternalFile,
    saveStateRef,
    selectedIdRef,
    setContent,
    setSaveState,
  ]);

  useEffect(() => {
    const unlisten = listen<string>("open-note", (event) => {
      // 从便签/图谱等窗口打开笔记同样必须经过保存队列；直接 loadNote 会
      // 覆盖主窗口当前未落盘的内容。
      void handleSelectNoteRef.current(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [handleSelectNoteRef]);

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
    const unlisten = listen<string>("app://quit-save-failed", (event) => {
      showToast(event.payload);
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
  }, [setPinnedTileIds]);

  useEffect(() => {
    const unlisten = listen<string>(TILE_WINDOW_UNPINNED_EVENT, (event) => {
      setPinnedTileIds((previous) => syncPinnedTileIds(previous, event.payload, false));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [setPinnedTileIds]);

  useEffect(() => {
    if (!selectedExternalFile) return;

    const interval = window.setInterval(async () => {
      // 窗口隐藏（托盘/最小化）时跳过探测，恢复可见后 1s 内自动追上
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastExternalSaveRef.current < 2000) return;
      try {
        const mtime = await getFileModifiedTime(selectedExternalFile.filePath);
        if (selectedIdRef.current !== selectedExternalFile.id) return;
        if (saveStateRef.current !== "saved") return;
        if (mtime !== externalFileMtimeRef.current) {
          externalFileMtimeRef.current = mtime;
          const fileContent = await readExternalFile(selectedExternalFile.filePath);
          if (selectedIdRef.current !== selectedExternalFile.id) return;
          editRevisionRef.current += 1;
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
  }, [
    contentValueRef,
    editRevisionRef,
    externalFileMtimeRef,
    lastExternalSaveRef,
    saveStateRef,
    selectedExternalFile,
    selectedIdRef,
    setContent,
    setSaveState,
  ]);

  useEffect(() => {
    // 送达确认制：收到事件 → 展示并打开笔记 → ack 后才算送达。
    // ack 失败或窗口/页面未就绪时错过的事件，由调度器下轮重投 +
    // 下方补偿拉取兜底，提醒不会被静默丢弃。
    const ackedIds = new Set<string>();
    const handleDue = async (reminder: Reminder) => {
      if (ackedIds.has(reminder.id)) return;
      ackedIds.add(reminder.id);
      showToast(`提醒：${reminder.message}`, "warning");
      const opened = reminder.noteId ? await handleSelectNoteRef.current(reminder.noteId) : true;
      if (!opened) {
        // 当前笔记保存失败或目标笔记无法打开时，不确认送达；下轮会重投。
        ackedIds.delete(reminder.id);
        return;
      }
      try {
        await ackReminder(reminder.id);
      } catch {
        // ack 失败保持未确认，调度器下轮会重新投递
        ackedIds.delete(reminder.id);
      }
    };
    const unlisten = listen<Reminder>("reminder://due", (event) => {
      void handleDue(event.payload);
    });
    // 补偿拉取：页面挂载后补齐窗口/页面未就绪时错过的事件
    void (async () => {
      try {
        const now = Date.now();
        const due = (await listReminders()).filter(
          (reminder) => !reminder.notified && new Date(reminder.remindAt).getTime() <= now,
        );
        for (const reminder of due) {
          await handleDue(reminder);
        }
      } catch {
        // 拉取失败静默：调度器仍会持续投递，不阻塞启动
      }
    })();
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [handleSelectNoteRef]);

  useEffect(() => {
    void isCurrentWindowMaximized().then(setIsMaximized);
    const unlisten = getCurrentWindow().onResized(() => {
      void isCurrentWindowMaximized().then(setIsMaximized);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [setIsMaximized]);
}
