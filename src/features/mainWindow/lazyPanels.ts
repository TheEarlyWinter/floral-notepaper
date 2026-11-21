import { lazy } from "react";

// 可选面板与浮层只在用户主动打开时挂载，懒加载可把关于、设置、图谱（vis-network/vis-data）、
// 命令面板等重依赖从首屏 App chunk 中拆出
export const AboutPanel = lazy(() =>
  import("../../components/AboutPanel").then((module) => ({ default: module.AboutPanel })),
);

export const SettingsPanel = lazy(() =>
  import("../../components/SettingsPanel").then((module) => ({ default: module.SettingsPanel })),
);

export const TodoPanel = lazy(() =>
  import("../../components/TodoPanel").then((module) => ({ default: module.TodoPanel })),
);

export const NoteHistoryPanel = lazy(() =>
  import("../../components/NoteHistoryPanel").then((module) => ({
    default: module.NoteHistoryPanel,
  })),
);

export const BacklinksPanel = lazy(() =>
  import("../../components/BacklinksPanel").then((module) => ({
    default: module.BacklinksPanel,
  })),
);

export const KnowledgeGraphPanel = lazy(() =>
  import("../../components/KnowledgeGraphPanel").then((module) => ({
    default: module.KnowledgeGraphPanel,
  })),
);

export const ReminderPanel = lazy(() =>
  import("../../components/ReminderPanel").then((module) => ({
    default: module.ReminderPanel,
  })),
);

export const LibraryPanel = lazy(() =>
  import("../../components/LibraryPanel").then((module) => ({
    default: module.LibraryPanel,
  })),
);

export const NotesWorkspacePanel = lazy(() =>
  import("../../components/NotesWorkspacePanel").then((module) => ({
    default: module.NotesWorkspacePanel,
  })),
);

export const OutlinePanel = lazy(() =>
  import("../../components/OutlinePanel").then((module) => ({
    default: module.OutlinePanel,
  })),
);

export const CommandPalette = lazy(() =>
  import("../../components/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);

export const FindReplaceBar = lazy(() =>
  import("../../components/FindReplaceBar").then((module) => ({
    default: module.FindReplaceBar,
  })),
);

export const BulkActionBar = lazy(() =>
  import("../../components/BulkActionBar").then((module) => ({
    default: module.BulkActionBar,
  })),
);
