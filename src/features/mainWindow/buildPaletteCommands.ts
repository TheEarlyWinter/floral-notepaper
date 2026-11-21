import type { TFunction } from "i18next";
import type { PaletteCommand } from "../../components/CommandPalette";
import type { NotesWorkspaceMode } from "../../components/NotesWorkspacePanel";

interface BuildPaletteCommandsOptions {
  t: TFunction;
  selectedId: string | null;
  isExternal: boolean;
  quickCaptureShortcut?: string;
  onNewNote: () => void | Promise<void>;
  onOpenDailyNote: () => void | Promise<void>;
  onOpenWorkspace: (mode: NotesWorkspaceMode) => void;
  onOpenTodos: () => void;
  onOpenKnowledgeGraph: () => void;
  onToggleFocusMode: () => void;
  onToggleReadingMode: () => void;
  onOpenReminders: () => void;
  onExportPdf: () => void | Promise<void>;
  onOpenSettings: () => void;
  onOpenQuickCapture: () => void | Promise<void>;
  syncEnabled?: boolean;
  onSyncNow?: () => void | Promise<void>;
}

export function buildPaletteCommands({
  t,
  selectedId,
  isExternal,
  quickCaptureShortcut,
  onNewNote,
  onOpenDailyNote,
  onOpenWorkspace,
  onOpenTodos,
  onOpenKnowledgeGraph,
  onToggleFocusMode,
  onToggleReadingMode,
  onOpenReminders,
  onExportPdf,
  onOpenSettings,
  onOpenQuickCapture,
  syncEnabled = false,
  onSyncNow,
}: BuildPaletteCommandsOptions): PaletteCommand[] {
  return [
    {
      id: "new-note",
      label: t("commandPalette.commands.newNote", { defaultValue: "新建笔记" }),
      description: t("commandPalette.commands.newNoteDesc", {
        defaultValue: "在当前分类创建一篇空白笔记",
      }),
      keywords: ["new note", "create", "新建", "笔记"],
      onExecute: onNewNote,
    },
    {
      id: "open-daily",
      label: t("commandPalette.commands.openDaily", { defaultValue: "打开每日便笺" }),
      description: t("commandPalette.commands.openDailyDesc", {
        defaultValue: "打开或创建今天的每日便笺",
      }),
      keywords: ["daily", "today", "journal", "每日", "便笺", "日记"],
      onExecute: onOpenDailyNote,
    },
    {
      id: "open-inbox",
      label: t("commandPalette.commands.openInbox", { defaultValue: "打开收件箱" }),
      description: t("commandPalette.commands.openInboxDesc", {
        defaultValue: "查看并整理快速记录的收件箱想法",
      }),
      keywords: ["inbox", "收件箱", "整理"],
      onExecute: () => onOpenWorkspace("inbox"),
    },
    {
      id: "open-journal",
      label: t("commandPalette.commands.openJournal", { defaultValue: "打开日记流" }),
      description: t("commandPalette.commands.openJournalDesc", {
        defaultValue: "按时间线浏览每日便笺",
      }),
      keywords: ["journal", "stream", "timeline", "日记流", "时间线"],
      onExecute: () => onOpenWorkspace("journal"),
    },
    {
      id: "open-todos",
      label: t("commandPalette.commands.openTodos", { defaultValue: "打开待办面板" }),
      description: t("commandPalette.commands.openTodosDesc", {
        defaultValue: "汇总全部笔记中的待办事项",
      }),
      keywords: ["todo", "tasks", "checklist", "待办", "任务"],
      onExecute: onOpenTodos,
    },
    {
      id: "open-knowledge-graph",
      label: t("commandPalette.commands.openKnowledgeGraph", { defaultValue: "打开知识图谱" }),
      description: t("commandPalette.commands.openKnowledgeGraphDesc", {
        defaultValue: "可视化查看笔记间的双向链接关系",
      }),
      keywords: ["graph", "knowledge", "links", "知识图谱", "双链"],
      onExecute: onOpenKnowledgeGraph,
    },
    {
      id: "open-weekly-review",
      label: t("commandPalette.commands.openWeeklyReview", { defaultValue: "打开本周回顾" }),
      description: t("commandPalette.commands.openWeeklyReviewDesc", {
        defaultValue: "打开仪表盘并查看或生成本周回顾",
      }),
      keywords: ["weekly", "review", "dashboard", "本周回顾", "仪表盘", "总结"],
      onExecute: () => onOpenWorkspace("dashboard"),
    },
    {
      id: "toggle-focus-mode",
      label: t("commandPalette.commands.toggleFocusMode", { defaultValue: "切换专注模式" }),
      description: t("commandPalette.commands.toggleFocusModeDesc", {
        defaultValue: "隐藏侧栏与工具栏，专注写作",
      }),
      keywords: ["focus", "zen", "专注", "写作"],
      onExecute: onToggleFocusMode,
    },
    {
      id: "toggle-reading-mode",
      label: t("commandPalette.commands.toggleReadingMode", { defaultValue: "切换沉浸阅读" }),
      description: t("commandPalette.commands.toggleReadingModeDesc", {
        defaultValue: "以纯预览模式沉浸阅读当前笔记",
      }),
      keywords: ["reading", "immersive", "preview", "阅读", "沉浸"],
      onExecute: onToggleReadingMode,
    },
    {
      id: "open-reminders",
      label: t("commandPalette.commands.openReminders", { defaultValue: "打开提醒" }),
      description: t("commandPalette.commands.openRemindersDesc", {
        defaultValue: "为当前笔记设置或查看定时提醒",
      }),
      keywords: ["reminder", "alarm", "提醒", "定时"],
      disabled: !selectedId || isExternal,
      onExecute: onOpenReminders,
    },
    {
      id: "export-pdf",
      label: t("commandPalette.commands.exportPdf", { defaultValue: "导出 PDF" }),
      description: t("commandPalette.commands.exportPdfDesc", {
        defaultValue: "将当前笔记导出为 PDF 文档",
      }),
      keywords: ["pdf", "export", "print", "导出"],
      disabled: !selectedId || isExternal,
      onExecute: onExportPdf,
    },
    {
      id: "open-settings",
      label: t("commandPalette.commands.openSettings", { defaultValue: "打开设置" }),
      description: t("commandPalette.commands.openSettingsDesc", {
        defaultValue: "打开应用偏好与快捷键设置",
      }),
      keywords: ["settings", "preferences", "config", "设置", "偏好"],
      onExecute: onOpenSettings,
    },
    {
      id: "open-quick-capture",
      label: t("commandPalette.commands.openQuickCapture", { defaultValue: "打开快速捕获" }),
      description: t("commandPalette.commands.openQuickCaptureDesc", {
        defaultValue: "呼出桌面浮动快速捕获框",
      }),
      keywords: ["quick capture", "capture", "快速捕获", "速记"],
      shortcut: quickCaptureShortcut || undefined,
      onExecute: onOpenQuickCapture,
    },
    {
      id: "sync-now",
      label: t("commandPalette.commands.syncNow", { defaultValue: "立即同步" }),
      description: t("commandPalette.commands.syncNowDesc", {
        defaultValue: "立即与云端同步笔记与附件",
      }),
      keywords: ["sync", "cloud", "webdav", "git", "同步", "云同步"],
      disabled: !syncEnabled,
      onExecute: onSyncNow ?? (() => undefined),
    },
  ];
}
