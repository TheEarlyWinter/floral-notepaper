import { describe, expect, test } from "vitest";
import { matchShortcut } from "./useMainWindowShortcuts";

function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
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
