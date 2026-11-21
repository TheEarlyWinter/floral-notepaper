import { Suspense, useEffect, useState } from "react";
import type { NotesWorkspaceMode } from "../../components/NotesWorkspacePanel";
import type { SearchHit } from "../notes/insights";
import type { Note, NoteMetadata, RelatedNoteSuggestion } from "../notes/types";
import type { TodoItem } from "../notes/todoUtils";
import type { AppConfig } from "../settings/types";
import {
  AboutPanel,
  BacklinksPanel,
  KnowledgeGraphPanel,
  LibraryPanel,
  NoteHistoryPanel,
  NotesWorkspacePanel,
  ReminderPanel,
  SettingsPanel,
  TodoPanel,
} from "./lazyPanels";
import type { SidePanelMode } from "./types";

interface MainWindowSidePanelsProps {
  visibleSidePanel: SidePanelMode | null;
  initialMountedPanel?: SidePanelMode | null;
  settingsOpen: boolean;
  settingsOverlay: boolean;
  settingsConfig: AppConfig | null;
  selectedId: string | null;
  isExternal: boolean;
  title: string;
  notes: NoteMetadata[];
  categories: string[];
  workspaceMode: NotesWorkspaceMode | null;
  searchText: string;
  remindersRefreshKey: number;
  onCloseAbout: () => void;
  onCloseSettings: () => void;
  onSettingsChange: (config: AppConfig) => void;
  onMigrateDataDir: () => void;
  onCloseHistory: () => void;
  onRestoreNoteVersion: (versionId: string) => Promise<void>;
  onCloseBacklinks: () => void;
  onOpenBacklinkNote: (noteId: string) => void;
  onInsertRelatedLink?: (suggestion: RelatedNoteSuggestion) => void;
  onCloseReminders: () => void;
  onCloseLibrary: () => void;
  onBeforeRestoreBackup: () => Promise<boolean>;
  onRestoredBackup: () => void;
  onCloseTodos: () => void;
  onOpenTodoNote: (noteId: string) => void;
  onToggleTodo: (note: Note, item: TodoItem, completed: boolean) => Promise<void>;
  onCloseWorkspace: () => void;
  onOpenWorkspaceNote: (noteId: string, hit?: SearchHit) => void;
  onMoveNote: (noteId: string, category: string) => void;
  onMergeNotes: (targetId: string, sourceId: string) => void;
  onWeeklyReviewCreated: (note: Note) => void;
  onCloseKnowledgeGraph: () => void;
  onOpenKnowledgeGraphNote: (noteId: string) => void;
}

export function MainWindowSidePanels({
  visibleSidePanel,
  initialMountedPanel = null,
  settingsOpen,
  settingsOverlay,
  settingsConfig,
  selectedId,
  isExternal,
  title,
  notes,
  categories,
  workspaceMode,
  searchText,
  remindersRefreshKey,
  onCloseAbout,
  onCloseSettings,
  onSettingsChange,
  onMigrateDataDir,
  onCloseHistory,
  onRestoreNoteVersion,
  onCloseBacklinks,
  onOpenBacklinkNote,
  onInsertRelatedLink,
  onCloseReminders,
  onCloseLibrary,
  onBeforeRestoreBackup,
  onRestoredBackup,
  onCloseTodos,
  onOpenTodoNote,
  onToggleTodo,
  onCloseWorkspace,
  onOpenWorkspaceNote,
  onMoveNote,
  onMergeNotes,
  onWeeklyReviewCreated,
  onCloseKnowledgeGraph,
  onOpenKnowledgeGraphNote,
}: MainWindowSidePanelsProps) {
  const [mountedSidePanel, setMountedSidePanel] = useState<SidePanelMode | null>(
    initialMountedPanel,
  );
  const [sidePanelContentVisible, setSidePanelContentVisible] = useState(
    Boolean(initialMountedPanel),
  );
  const sidePanelExpanded = visibleSidePanel !== null;

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

  const drawerSlideClass = (mode: SidePanelMode) =>
    `transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
      mountedSidePanel === mode && sidePanelContentVisible && visibleSidePanel === mode
        ? "translate-x-0 opacity-100"
        : "pointer-events-none translate-x-4 opacity-0"
    }`;

  return (
    <>
      {settingsConfig && settingsOpen && settingsOverlay && (
        <div className="absolute inset-0 z-20" onClick={onCloseSettings} />
      )}
      <div
        className={`relative shrink-0 overflow-clip h-full transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          sidePanelExpanded || mountedSidePanel ? "border-l border-paper-deep/20" : "border-l-0"
        } ${
          settingsOverlay
            ? `absolute right-0 top-0 bottom-0 z-30 ${visibleSidePanel ? (visibleSidePanel === "knowledgeGraph" ? "w-[420px]" : "w-[360px]") + " shadow-xl" : "w-0"}`
            : `${sidePanelExpanded ? (visibleSidePanel === "knowledgeGraph" ? "w-[420px]" : "w-[360px]") : "w-0"}`
        }`}
      >
        <div className={`absolute inset-0 w-[360px] h-full ${drawerSlideClass("about")}`}>
          {mountedSidePanel === "about" ? (
            <Suspense fallback={null}>
              <AboutPanel onClose={onCloseAbout} />
            </Suspense>
          ) : null}
        </div>
        <div className={`absolute inset-0 w-[360px] h-full ${drawerSlideClass("history")}`}>
          {mountedSidePanel === "history" && selectedId && !isExternal ? (
            <Suspense fallback={null}>
              <NoteHistoryPanel
                noteId={selectedId}
                onRestore={onRestoreNoteVersion}
                onClose={onCloseHistory}
              />
            </Suspense>
          ) : null}
        </div>
        <div className={`absolute inset-0 w-[360px] h-full ${drawerSlideClass("backlinks")}`}>
          {mountedSidePanel === "backlinks" && selectedId && !isExternal ? (
            <Suspense fallback={null}>
              <BacklinksPanel
                noteId={selectedId}
                notes={notes}
                onOpenNote={onOpenBacklinkNote}
                onInsertLink={onInsertRelatedLink}
                onClose={onCloseBacklinks}
              />
            </Suspense>
          ) : null}
        </div>
        <div className={`absolute inset-0 w-[360px] h-full ${drawerSlideClass("reminders")}`}>
          {mountedSidePanel === "reminders" && selectedId && !isExternal ? (
            <Suspense fallback={null}>
              <ReminderPanel
                noteId={selectedId}
                noteTitle={title}
                refreshKey={remindersRefreshKey}
                onClose={onCloseReminders}
              />
            </Suspense>
          ) : null}
        </div>
        <div className={`absolute inset-0 w-[360px] h-full ${drawerSlideClass("library")}`}>
          {mountedSidePanel === "library" ? (
            <Suspense fallback={null}>
              <LibraryPanel
                noteId={selectedId && !isExternal ? selectedId : null}
                noteTitle={title}
                onClose={onCloseLibrary}
                onBeforeRestore={onBeforeRestoreBackup}
                onRestored={onRestoredBackup}
              />
            </Suspense>
          ) : null}
        </div>
        <div className={`absolute inset-0 w-[360px] h-full ${drawerSlideClass("todos")}`}>
          {mountedSidePanel === "todos" ? (
            <Suspense fallback={null}>
              <TodoPanel
                notes={notes}
                onOpenNote={onOpenTodoNote}
                onToggleTodo={onToggleTodo}
                onClose={onCloseTodos}
              />
            </Suspense>
          ) : null}
        </div>
        <div className={`absolute inset-0 w-[360px] h-full ${drawerSlideClass("workspace")}`}>
          {mountedSidePanel === "workspace" && workspaceMode ? (
            <Suspense fallback={null}>
              <NotesWorkspacePanel
                mode={workspaceMode}
                notes={notes}
                categories={categories}
                query={workspaceMode === "search" ? searchText : undefined}
                onOpenNote={onOpenWorkspaceNote}
                onMoveNote={onMoveNote}
                onMergeNotes={onMergeNotes}
                onWeeklyReviewCreated={onWeeklyReviewCreated}
                onClose={onCloseWorkspace}
              />
            </Suspense>
          ) : null}
        </div>
        <div
          className={`absolute inset-0 h-full ${drawerSlideClass("knowledgeGraph")}`}
          style={{ width: mountedSidePanel === "knowledgeGraph" ? 420 : 360 }}
        >
          {mountedSidePanel === "knowledgeGraph" ? (
            <Suspense fallback={null}>
              <KnowledgeGraphPanel
                notes={notes}
                onOpenNote={onOpenKnowledgeGraphNote}
                onClose={onCloseKnowledgeGraph}
              />
            </Suspense>
          ) : null}
        </div>
        <div className={`absolute inset-0 w-[360px] h-full ${drawerSlideClass("settings")}`}>
          {mountedSidePanel === "settings" && settingsConfig ? (
            <Suspense fallback={null}>
              <SettingsPanel
                config={settingsConfig}
                onChange={onSettingsChange}
                onMigrateDataDir={onMigrateDataDir}
                onClose={onCloseSettings}
              />
            </Suspense>
          ) : null}
        </div>
      </div>
    </>
  );
}
