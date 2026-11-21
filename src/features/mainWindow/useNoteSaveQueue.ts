import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { TFunction } from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showToast } from "../../components/Toast";
import { getErrorMessage, getFileModifiedTime, saveExternalFile, updateNote } from "../notes/api";
import type { ExternalFile, Note, NoteMetadata } from "../notes/types";
import { getConfig } from "../settings/api";
import type { AppConfig } from "../settings/types";
import { reportInstallPreparation } from "../update/api";
import type { UpdateInstallPrepareRequest } from "../update/types";
import { hideCurrentWindow } from "../windows/controls";
import type { SaveState } from "./types";

interface UseNoteSaveQueueOptions {
  selectedId: string | null;
  content: string;
  title: string;
  isExternal: boolean;
  saveState: SaveState;
  setSaveState: (state: SaveState) => void;
  settingsConfig: AppConfig | null;
  selectedIdRef: MutableRefObject<string | null>;
  titleValueRef: MutableRefObject<string>;
  contentValueRef: MutableRefObject<string>;
  tagsValueRef: MutableRefObject<string[]>;
  pinnedValueRef: MutableRefObject<boolean>;
  notesRef: MutableRefObject<NoteMetadata[]>;
  externalFilesRef: MutableRefObject<ExternalFile[]>;
  saveStateRef: MutableRefObject<SaveState>;
  editRevisionRef: MutableRefObject<number>;
  externalFileMtimeRef: MutableRefObject<number>;
  lastExternalSaveRef: MutableRefObject<number>;
  isExternalRef: MutableRefObject<boolean>;
  windowLabelRef: MutableRefObject<string>;
  replaceNoteMetadata: (note: Note) => void;
  t: TFunction;
}

export function useNoteSaveQueue({
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
}: UseNoteSaveQueueOptions) {
  // 串行化所有保存请求，避免自动保存与切换触发的保存并发写同一篇笔记
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingCloseRef = useRef(false);

  const markDirty = useCallback(() => {
    if (!selectedIdRef.current) return;
    editRevisionRef.current += 1;
    saveStateRef.current = "dirty";
    setSaveState("dirty");
  }, [editRevisionRef, saveStateRef, selectedIdRef, setSaveState]);

  const performSave = useCallback(
    async (force: boolean): Promise<boolean> => {
      // 非强制保存（自动保存、切换前保存）在没有未保存修改时直接视为成功；
      // 上次保存失败（error）也需要重新尝试，不能误报成功
      if (!force && saveStateRef.current !== "dirty" && saveStateRef.current !== "error") {
        return true;
      }
      const id = selectedIdRef.current;
      if (!id) return false;

      // 在保存瞬间对当前笔记做快照；之后用户切换笔记不影响本次写入的内容，
      // 保存完成后也只在"仍停留在这篇笔记"时才更新保存状态
      const titleSnapshot = titleValueRef.current;
      const contentSnapshot = contentValueRef.current;
      const tagsSnapshot = tagsValueRef.current;
      const pinnedSnapshot = pinnedValueRef.current;
      const editRevisionSnapshot = editRevisionRef.current;
      const stillCurrent = () => selectedIdRef.current === id;
      const settleSaveState = (state: SaveState) => {
        if (!stillCurrent()) return;
        if (state !== "saving" && editRevisionRef.current !== editRevisionSnapshot) {
          saveStateRef.current = "dirty";
          setSaveState("dirty");
          return;
        }
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
          settleSaveState("saved");
        } else {
          const category = notesRef.current.find((note) => note.id === id)?.category ?? "";
          const note = await updateNote(id, {
            title: titleSnapshot,
            content: contentSnapshot,
            category,
            tags: tagsSnapshot,
            pinned: pinnedSnapshot,
          });
          if (!stillCurrent() || editRevisionRef.current === editRevisionSnapshot) {
            replaceNoteMetadata(note);
          }
          settleSaveState("saved");
        }
        return true;
      } catch (error) {
        settleSaveState("error");
        showToast(getErrorMessage(error));
        return false;
      }
    },
    [
      contentValueRef,
      editRevisionRef,
      externalFileMtimeRef,
      externalFilesRef,
      lastExternalSaveRef,
      notesRef,
      pinnedValueRef,
      replaceNoteMetadata,
      saveStateRef,
      selectedIdRef,
      setSaveState,
      tagsValueRef,
      titleValueRef,
    ],
  );

  const saveCurrentNote = useCallback(
    (force = false): Promise<boolean> => {
      const requestedId = selectedIdRef.current;
      const run = saveQueueRef.current.then(async () => {
        let saved = await performSave(force);
        // 用户可能在前一次异步写入期间继续编辑。切换笔记、打开每日便笺等
        // 需要等到同一篇笔记的最新 revision 也真正落盘，不能只等待旧请求。
        // 加最小间隔与次数上限：持续输入时不会高频自旋写盘
        let attempts = 0;
        while (
          saved &&
          attempts < 10 &&
          selectedIdRef.current === requestedId &&
          requestedId !== null &&
          saveStateRef.current === "dirty"
        ) {
          attempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 300));
          saved = await performSave(true);
        }
        // 达到上限仍 dirty（输入速度超过保存速度）：不报告成功，
        // 调用方（关闭/切换/新建）应保留当前上下文，避免最新修改丢失
        return saved && saveStateRef.current !== "dirty";
      });
      saveQueueRef.current = run.catch(() => undefined);
      return run;
    },
    [performSave, saveStateRef, selectedIdRef],
  );

  useEffect(() => {
    function handleBlur() {
      if (saveStateRef.current !== "dirty") return;
      const autoSaveEnabled = isExternalRef.current
        ? settingsConfig?.externalFileAutoSave
        : settingsConfig?.noteAutoSave;
      if (autoSaveEnabled) {
        void saveCurrentNote();
      }
    }
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [
    isExternalRef,
    saveCurrentNote,
    saveStateRef,
    settingsConfig?.externalFileAutoSave,
    settingsConfig?.noteAutoSave,
  ]);

  useEffect(() => {
    const unlisten = listen<UpdateInstallPrepareRequest>("update://prepare-install", (event) => {
      const respond = async () => {
        const windowLabel = windowLabelRef.current;
        // 无未保存修改时直接上报就绪：避免排进 saveQueueRef，被正在执行的
        // 防抖自动保存拖住、不必要地延迟安装准备响应
        if (
          saveStateRef.current !== "dirty" &&
          saveStateRef.current !== "error" &&
          saveStateRef.current !== "saving"
        ) {
          await reportInstallPreparation(event.payload.requestId, windowLabel, "ready");
          return;
        }
        // dirty、保存中或上次保存失败：等待保存队列完成后再上报，避免未落盘内容在安装/退出时丢失
        const saved = await saveCurrentNote(true);
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
  }, [saveCurrentNote, saveStateRef, t, windowLabelRef]);

  useEffect(() => {
    // error（上次保存失败）也触发自动重试，避免失败后永远不再保存
    if (!selectedId || (saveState !== "dirty" && saveState !== "error")) return undefined;
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

  // 任意关闭途径（标题栏按钮 / 系统关闭 / Alt+F4）都会触发 onCloseRequested：
  // 未落盘（dirty / 保存失败 error / 保存中 saving）时先拦截并保存，
  // 保存成功再真正关闭；保存失败则留在窗口让用户处理。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (pendingCloseRef.current) return;
        event.preventDefault();

        const needsSave =
          saveStateRef.current === "dirty" ||
          saveStateRef.current === "error" ||
          saveStateRef.current === "saving";
        if (needsSave && !(await saveCurrentNote(true))) return;

        try {
          // The tray menu can change closeToTray without rerendering this window,
          // so read the current persisted setting before deciding hide vs close.
          const config = await getConfig();
          if (config.closeToTray) {
            await hideCurrentWindow();
            return;
          }

          pendingCloseRef.current = true;
          try {
            // 不能在这里再次调用 window.close()：Tauri 对同一次关闭请求的重入
            // 保护会吞掉它，窗口将永远关不掉。改为通知 Rust 销毁主窗口，
            // 由 Destroyed 回调里的保存屏障收尾并退出。
            await invoke("window_main_close_finished");
          } finally {
            pendingCloseRef.current = false;
          }
        } catch (error) {
          showToast(getErrorMessage(error));
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [saveCurrentNote, saveStateRef]);

  return {
    saveQueueRef,
    markDirty,
    saveCurrentNote,
  };
}
