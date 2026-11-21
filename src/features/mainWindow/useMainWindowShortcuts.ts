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
  openCommandPalette: () => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  onSave: () => void;
  onCloseTab: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
}

export function useMainWindowShortcuts({
  commandPaletteShortcut,
  closeTabShortcut,
  paletteOpenRef,
  openCommandPalette,
  closeCommandPalette,
  onSave,
  onCloseTab,
  onGoBack,
  onGoForward,
}: UseMainWindowShortcutsOptions) {
  const callbacksRef = useRef({
    openCommandPalette,
    closeCommandPalette,
    onSave,
    onCloseTab,
    onGoBack,
    onGoForward,
  });
  callbacksRef.current = {
    openCommandPalette,
    closeCommandPalette,
    onSave,
    onCloseTab,
    onGoBack,
    onGoForward,
  };

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const paletteShortcut = (commandPaletteShortcut ?? "Ctrl+K").trim();
      if (paletteShortcut && matchShortcut(event, paletteShortcut)) {
        if (document.querySelector('[data-shortcut-recording="true"]')) return;
        event.preventDefault();
        if (paletteOpenRef.current) {
          callbacksRef.current.closeCommandPalette({ restoreFocus: true });
        } else {
          callbacksRef.current.openCommandPalette();
        }
        return;
      }

      if (paletteOpenRef.current) return;

      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        callbacksRef.current.onSave();
      }
      // 可配置的关闭标签快捷键
      const shortcut = (closeTabShortcut || "Ctrl+W").trim();
      if (shortcut && matchShortcut(event, shortcut)) {
        event.preventDefault();
        callbacksRef.current.onCloseTab();
      }
      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        callbacksRef.current.onGoBack();
      }
      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        callbacksRef.current.onGoForward();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteShortcut, closeTabShortcut, paletteOpenRef]);
}
