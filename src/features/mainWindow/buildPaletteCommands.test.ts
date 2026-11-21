import type { TFunction } from "i18next";
import { describe, expect, test, vi } from "vitest";
import { buildPaletteCommands } from "./buildPaletteCommands";

const translate = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

describe("buildPaletteCommands", () => {
  test("disables note-specific commands when no internal note is active", () => {
    const commands = buildPaletteCommands({
      t: translate,
      selectedId: null,
      isExternal: false,
      onNewNote: vi.fn(),
      onOpenDailyNote: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenTodos: vi.fn(),
      onOpenKnowledgeGraph: vi.fn(),
      onToggleFocusMode: vi.fn(),
      onToggleReadingMode: vi.fn(),
      onOpenReminders: vi.fn(),
      onExportPdf: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenQuickCapture: vi.fn(),
    });

    const reminders = commands.find((cmd) => cmd.id === "open-reminders");
    const exportPdf = commands.find((cmd) => cmd.id === "export-pdf");
    const newNote = commands.find((cmd) => cmd.id === "new-note");

    expect(reminders?.disabled).toBe(true);
    expect(exportPdf?.disabled).toBe(true);
    expect(newNote?.disabled).toBeUndefined();
  });

  test("enables note-specific commands for an internal note and forwards quick capture shortcut", () => {
    const onExportPdf = vi.fn();
    const commands = buildPaletteCommands({
      t: translate,
      selectedId: "note-1",
      isExternal: false,
      quickCaptureShortcut: "Alt+Space",
      onNewNote: vi.fn(),
      onOpenDailyNote: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenTodos: vi.fn(),
      onOpenKnowledgeGraph: vi.fn(),
      onToggleFocusMode: vi.fn(),
      onToggleReadingMode: vi.fn(),
      onOpenReminders: vi.fn(),
      onExportPdf,
      onOpenSettings: vi.fn(),
      onOpenQuickCapture: vi.fn(),
    });

    const exportPdf = commands.find((cmd) => cmd.id === "export-pdf");
    const quickCapture = commands.find((cmd) => cmd.id === "open-quick-capture");

    expect(exportPdf?.disabled).toBe(false);
    expect(quickCapture?.shortcut).toBe("Alt+Space");
    void exportPdf?.onExecute();
    expect(onExportPdf).toHaveBeenCalledOnce();
  });

  test("disables sync-now when sync is off and executes onSyncNow when enabled", () => {
    const onSyncNow = vi.fn();
    const disabledCommands = buildPaletteCommands({
      t: translate,
      selectedId: null,
      isExternal: false,
      onNewNote: vi.fn(),
      onOpenDailyNote: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenTodos: vi.fn(),
      onOpenKnowledgeGraph: vi.fn(),
      onToggleFocusMode: vi.fn(),
      onToggleReadingMode: vi.fn(),
      onOpenReminders: vi.fn(),
      onExportPdf: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenQuickCapture: vi.fn(),
      syncEnabled: false,
      onSyncNow,
    });
    expect(disabledCommands.find((cmd) => cmd.id === "sync-now")?.disabled).toBe(true);

    const enabledCommands = buildPaletteCommands({
      t: translate,
      selectedId: null,
      isExternal: false,
      onNewNote: vi.fn(),
      onOpenDailyNote: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenTodos: vi.fn(),
      onOpenKnowledgeGraph: vi.fn(),
      onToggleFocusMode: vi.fn(),
      onToggleReadingMode: vi.fn(),
      onOpenReminders: vi.fn(),
      onExportPdf: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenQuickCapture: vi.fn(),
      syncEnabled: true,
      onSyncNow,
    });
    const syncCmd = enabledCommands.find((cmd) => cmd.id === "sync-now");
    expect(syncCmd?.disabled).toBe(false);
    void syncCmd?.onExecute();
    expect(onSyncNow).toHaveBeenCalledOnce();
  });
});
