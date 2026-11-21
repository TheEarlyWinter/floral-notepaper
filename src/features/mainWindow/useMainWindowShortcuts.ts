import { useEffect, useRef, type RefObject } from "react";

/** 解析 "Ctrl+W"、"Alt+F4" 等快捷键字符串并匹配键盘事件 */
export function matchShortcut(event: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split("+").map((s) => s.trim().toLowerCase());
  const hasCtrl = parts.includes("ctrl") || parts.includes("control");
  const hasAlt = parts.includes("alt") || parts.includes("option");
  const hasShift = parts.includes("shift");
  const hasMeta = parts.includes("meta") || parts.includes("cmd") || parts.includes("command");
  const keyPart = parts.find(
    (p) => !["ctrl", "control", "alt", "option", "shift", "meta", "cmd", "command"].includes(p),
  );
  if (!keyPart) return false;
  // Ctrl 和 Meta 互认：Mac 上用 Cmd(Meta) 等价于 Windows 的 Ctrl
  const hasModKey = hasCtrl || hasMeta;
  const eventHasModKey = event.ctrlKey || event.metaKey;
  if (eventHasModKey !== hasModKey) return false;
  if (event.altKey !== hasAlt) return false;
  if (event.shiftKey !== hasShift) return false;
  const eventKey = event.key === " " ? "space" : event.key.toLowerCase();
  return eventKey === keyPart;
}

interface UseMainWindowShortcutsOptions {
  commandPaletteShortcut?: string;
  closeTabShortcut?: string;
  paletteOpenRef: RefObject<boolean>;
  hasActiveNote?: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  onSave: () => void;
  onCloseTab: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenFind?: () => void;
  onOpenReplace?: () => void;
}

export interface MainWindowShortcutDispatchHandlers {
  commandPaletteShortcut?: string;
  closeTabShortcut?: string;
  paletteOpen: boolean;
  isRecordingShortcut: boolean;
  hasActiveNote: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  onSave: () => void;
  onCloseTab: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenFind?: () => void;
  onOpenReplace?: () => void;
}

export function dispatchMainWindowShortcut(
  event: KeyboardEvent,
  handlers: MainWindowShortcutDispatchHandlers,
): boolean {
  const paletteShortcut = (handlers.commandPaletteShortcut ?? "Ctrl+K").trim();
  if (paletteShortcut && matchShortcut(event, paletteShortcut)) {
    if (handlers.isRecordingShortcut) return false;
    event.preventDefault();
    if (handlers.paletteOpen) {
      handlers.closeCommandPalette({ restoreFocus: true });
    } else {
      handlers.openCommandPalette();
    }
    return true;
  }

  if (handlers.paletteOpen || handlers.isRecordingShortcut) return false;

  if (
    handlers.hasActiveNote &&
    !event.altKey &&
    !event.shiftKey &&
    (event.ctrlKey || event.metaKey)
  ) {
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      handlers.onOpenFind?.();
      return true;
    }
    if (key === "h") {
      event.preventDefault();
      handlers.onOpenReplace?.();
      return true;
    }
  }

  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    handlers.onSave();
    return true;
  }

  // 可配置的关闭标签快捷键
  const shortcut = (handlers.closeTabShortcut || "Ctrl+W").trim();
  if (shortcut && matchShortcut(event, shortcut)) {
    event.preventDefault();
    handlers.onCloseTab();
    return true;
  }

  if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    handlers.onGoBack();
    return true;
  }

  if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    handlers.onGoForward();
    return true;
  }

  return false;
}

export function useMainWindowShortcuts({
  commandPaletteShortcut,
  closeTabShortcut,
  paletteOpenRef,
  hasActiveNote = false,
  openCommandPalette,
  closeCommandPalette,
  onSave,
  onCloseTab,
  onGoBack,
  onGoForward,
  onOpenFind,
  onOpenReplace,
}: UseMainWindowShortcutsOptions) {
  const callbacksRef = useRef({
    hasActiveNote,
    openCommandPalette,
    closeCommandPalette,
    onSave,
    onCloseTab,
    onGoBack,
    onGoForward,
    onOpenFind,
    onOpenReplace,
  });
  callbacksRef.current = {
    hasActiveNote,
    openCommandPalette,
    closeCommandPalette,
    onSave,
    onCloseTab,
    onGoBack,
    onGoForward,
    onOpenFind,
    onOpenReplace,
  };

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isRecordingShortcut = Boolean(
        typeof document !== "undefined" &&
        document.querySelector('[data-shortcut-recording="true"]'),
      );
      dispatchMainWindowShortcut(event, {
        commandPaletteShortcut,
        closeTabShortcut,
        paletteOpen: Boolean(paletteOpenRef.current),
        isRecordingShortcut,
        hasActiveNote: callbacksRef.current.hasActiveNote,
        openCommandPalette: callbacksRef.current.openCommandPalette,
        closeCommandPalette: callbacksRef.current.closeCommandPalette,
        onSave: callbacksRef.current.onSave,
        onCloseTab: callbacksRef.current.onCloseTab,
        onGoBack: callbacksRef.current.onGoBack,
        onGoForward: callbacksRef.current.onGoForward,
        onOpenFind: callbacksRef.current.onOpenFind,
        onOpenReplace: callbacksRef.current.onOpenReplace,
      });
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteShortcut, closeTabShortcut, paletteOpenRef]);
}
