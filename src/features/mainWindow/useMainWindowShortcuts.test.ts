import { describe, expect, test, vi } from "vitest";
import { dispatchMainWindowShortcut, matchShortcut } from "./useMainWindowShortcuts";

function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as KeyboardEvent;
}

describe("matchShortcut", () => {
  test("matches Ctrl and Meta equivalently for Ctrl+K", () => {
    expect(matchShortcut(makeKeyEvent({ key: "k", ctrlKey: true }), "Ctrl+K")).toBe(true);
    expect(matchShortcut(makeKeyEvent({ key: "K", metaKey: true }), "Ctrl+K")).toBe(true);
    expect(matchShortcut(makeKeyEvent({ key: "k", ctrlKey: true, shiftKey: true }), "Ctrl+K")).toBe(
      false,
    );
  });

  test("handles Space and modifier combinations accurately", () => {
    expect(
      matchShortcut(makeKeyEvent({ key: " ", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+Space"),
    ).toBe(true);
    expect(matchShortcut(makeKeyEvent({ key: "w", altKey: true }), "Alt+W")).toBe(true);
    expect(matchShortcut(makeKeyEvent({ key: "w", ctrlKey: true }), "")).toBe(false);
  });
});

describe("dispatchMainWindowShortcut", () => {
  test("triggers find (Ctrl/Cmd+F) and replace (Ctrl/Cmd+H) only when note is open and unobstructed", () => {
    const onOpenFind = vi.fn();
    const onOpenReplace = vi.fn();
    const baseHandlers = {
      paletteOpen: false,
      isRecordingShortcut: false,
      hasActiveNote: true,
      openCommandPalette: vi.fn(),
      closeCommandPalette: vi.fn(),
      onSave: vi.fn(),
      onCloseTab: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      onOpenFind,
      onOpenReplace,
    };

    const ctrlF = makeKeyEvent({ key: "f", ctrlKey: true });
    expect(dispatchMainWindowShortcut(ctrlF, baseHandlers)).toBe(true);
    expect(ctrlF.preventDefault).toHaveBeenCalledOnce();
    expect(onOpenFind).toHaveBeenCalledOnce();

    const cmdH = makeKeyEvent({ key: "H", metaKey: true });
    expect(dispatchMainWindowShortcut(cmdH, baseHandlers)).toBe(true);
    expect(cmdH.preventDefault).toHaveBeenCalledOnce();
    expect(onOpenReplace).toHaveBeenCalledOnce();

    // Suppressed when recording shortcut
    expect(
      dispatchMainWindowShortcut(makeKeyEvent({ key: "f", ctrlKey: true }), {
        ...baseHandlers,
        isRecordingShortcut: true,
      }),
    ).toBe(false);

    // Suppressed when CommandPalette is open
    expect(
      dispatchMainWindowShortcut(makeKeyEvent({ key: "h", ctrlKey: true }), {
        ...baseHandlers,
        paletteOpen: true,
      }),
    ).toBe(false);

    // Suppressed when no note is open
    expect(
      dispatchMainWindowShortcut(makeKeyEvent({ key: "f", ctrlKey: true }), {
        ...baseHandlers,
        hasActiveNote: false,
      }),
    ).toBe(false);

    expect(onOpenFind).toHaveBeenCalledOnce();
    expect(onOpenReplace).toHaveBeenCalledOnce();
  });
});
