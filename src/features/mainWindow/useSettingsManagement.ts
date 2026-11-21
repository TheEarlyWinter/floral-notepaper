import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import type { TFunction } from "i18next";
import { emit } from "@tauri-apps/api/event";
import { showToast } from "../../components/Toast";
import { getErrorMessage } from "../notes/api";
import type { NoteMetadata } from "../notes/types";
import { INBOX_CATEGORY } from "../notes/insights";
import {
  chooseDataDirectory,
  getConfig,
  migrateDataDir,
  normalizeViewMode,
  saveConfig,
} from "../settings/api";
import {
  DEFAULT_SIDEBAR_ACTION_ORDER,
  moveOrderItem,
  normalizeOrder,
  type SidebarActionId,
} from "../settings/sidebarOrder";
import { normalizeTileColor } from "../settings/tileColor";
import type { AppConfig, ViewMode } from "../settings/types";

interface UseSettingsManagementOptions {
  t: TFunction;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsConfig: AppConfig | null;
  setSettingsConfig: (config: AppConfig | null) => void;
  savedDataDir: string | null;
  setSavedDataDir: (dir: string | null) => void;
  categories: string[];
  editRevisionRef: MutableRefObject<number>;
  setViewMode: (mode: ViewMode) => void;
  setIsLoading: (loading: boolean) => void;
  saveCurrentNote: (force?: boolean) => Promise<boolean>;
  refreshImageBaseDir: () => void;
  refreshNotes: () => Promise<NoteMetadata[]>;
  loadNote: (id: string) => Promise<boolean>;
  clearCurrentNote: () => void;
  closeAllSidePanels: () => void;
  setAboutOpen: (open: boolean) => void;
}

export function useSettingsManagement({
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
}: UseSettingsManagementOptions) {
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sidebarActionOrder = useMemo(
    () => normalizeOrder(settingsConfig?.sidebarItemOrder, DEFAULT_SIDEBAR_ACTION_ORDER),
    [settingsConfig?.sidebarItemOrder],
  );
  const sidebarCategoryOrder = useMemo(
    () =>
      normalizeOrder(
        settingsConfig?.sidebarCategoryOrder,
        categories.filter((category) => category !== INBOX_CATEGORY),
      ),
    [categories, settingsConfig?.sidebarCategoryOrder],
  );

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

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const openSettingsFromPalette = () => {
    closeAllSidePanels();
    setSettingsOpen(true);
    if (settingsConfig) return;
    void getConfig()
      .then((config) => {
        setSettingsConfig(config);
        setSavedDataDir(config.dataDir);
        setViewMode(normalizeViewMode(config.defaultViewMode));
      })
      .catch((error) => {
        showToast(getErrorMessage(error));
      });
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

      // 迁移会切换后端数据目录并立即重载笔记；先把当前编辑内容落盘，
      // 否则迁移后的 loadNote 会直接覆盖尚未保存的内存状态。
      const saved = await saveCurrentNote(true);
      if (!saved) return;
      const revisionAfterSave = editRevisionRef.current;

      setIsLoading(true);
      try {
        const savedConfig = await migrateDataDir(dir);
        const editedDuringMigration = editRevisionRef.current !== revisionAfterSave;
        setSettingsConfig(savedConfig);
        setSavedDataDir(savedConfig.dataDir);
        // 数据目录已变：刷新图片基准目录，否则已有笔记图片仍指向旧路径
        refreshImageBaseDir();

        if (editedDuringMigration) {
          // 后端已经切到新目录，必须把迁移期间的新输入写入新目录；此时重载会
          // 覆盖编辑器内的最新内容，所以只刷新侧栏元数据。
          await saveCurrentNote(true);
          // 保存失败也刷新侧栏，让列表与后端新目录一致，避免点旧列表报错。
          await refreshNotes();
          return;
        }

        const loadedNotes = await refreshNotes();
        if (loadedNotes[0]) {
          await loadNote(loadedNotes[0].id);
        } else {
          clearCurrentNote();
        }
      } finally {
        setIsLoading(false);
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

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
    [savedDataDir, refreshNotes, loadNote, clearCurrentNote, setViewMode],
  );

  const handleSettingsChange = useCallback(
    (nextConfig: AppConfig) => {
      setSettingsConfig(nextConfig);
      void emit("config-changed", nextConfig);
      persistSettings(nextConfig);
    },
    [persistSettings],
  );

  const reorderSidebarAction = useCallback(
    (source: SidebarActionId, target: SidebarActionId) => {
      if (source === target || !settingsConfig) return;
      const nextOrder = moveOrderItem(sidebarActionOrder, source, target);
      handleSettingsChange({ ...settingsConfig, sidebarItemOrder: nextOrder });
    },
    [handleSettingsChange, settingsConfig, sidebarActionOrder],
  );

  const reorderSidebarCategory = useCallback(
    (source: string, target: string) => {
      if (source === target || !settingsConfig) return;
      const nextOrder = moveOrderItem(sidebarCategoryOrder, source, target);
      handleSettingsChange({ ...settingsConfig, sidebarCategoryOrder: nextOrder });
    },
    [handleSettingsChange, settingsConfig, sidebarCategoryOrder],
  );

  return {
    sidebarActionOrder,
    sidebarCategoryOrder,
    handleOpenSettings,
    handleCloseSettings,
    openSettingsFromPalette,
    handleMigrateDataDir,
    handleSettingsChange,
    reorderSidebarAction,
    reorderSidebarCategory,
  };
}
