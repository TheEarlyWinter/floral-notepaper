import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useViewportPopupPosition } from "../../components/popupPosition";
import type { CategoryMenuState, NoteMenuState } from "./types";

export function useSidebarMenus(categoriesLength: number) {
  const [noteMenu, setNoteMenu] = useState<NoteMenuState | null>(null);
  const [noteMenuClosing, setNoteMenuClosing] = useState(false);
  const [noteMenuMode, setNoteMenuMode] = useState<"main" | "move">("main");
  const [categoryMenu, setCategoryMenu] = useState<CategoryMenuState | null>(null);
  const [categoryMenuClosing, setCategoryMenuClosing] = useState(false);
  const [categoryMenuConfirmDelete, setCategoryMenuConfirmDelete] = useState(false);
  const [categoryMenuHoverSuppressed, setCategoryMenuHoverSuppressed] = useState(false);

  const { popupRef: noteMenuRef, popupPosition: noteMenuPosition } = useViewportPopupPosition(
    noteMenu,
    `${noteMenuMode}:${categoriesLength}`,
  );
  const { popupRef: categoryMenuRef, popupPosition: categoryMenuPosition } =
    useViewportPopupPosition(categoryMenu, categoryMenuConfirmDelete);

  useEffect(() => {
    function closeMenus() {
      setNoteMenuClosing(true);
      setCategoryMenuClosing(true);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenus();
    }

    document.addEventListener("mousedown", closeMenus);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", closeMenus);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!noteMenuClosing || !noteMenu) return;
    const timer = window.setTimeout(() => {
      setNoteMenu(null);
      setNoteMenuClosing(false);
      setNoteMenuMode("main");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [noteMenuClosing, noteMenu]);

  useEffect(() => {
    if (!categoryMenuClosing || !categoryMenu) return;
    const timer = window.setTimeout(() => {
      setCategoryMenu(null);
      setCategoryMenuClosing(false);
      setCategoryMenuConfirmDelete(false);
      setCategoryMenuHoverSuppressed(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [categoryMenuClosing, categoryMenu]);

  useEffect(() => {
    if (!categoryMenuHoverSuppressed || !categoryMenu) return;
    const releaseHover = () => setCategoryMenuHoverSuppressed(false);
    window.addEventListener("mousemove", releaseHover, { once: true });
    window.addEventListener("mousedown", releaseHover, { once: true });
    return () => {
      window.removeEventListener("mousemove", releaseHover);
      window.removeEventListener("mousedown", releaseHover);
    };
  }, [categoryMenuHoverSuppressed, categoryMenu]);

  const switchCategoryMenuPanel = useCallback((confirmDelete: boolean) => {
    setCategoryMenuHoverSuppressed(true);
    setCategoryMenuConfirmDelete(confirmDelete);
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const openNoteMenu = useCallback((event: MouseEvent<HTMLElement>, noteId: string) => {
    event.preventDefault();
    event.stopPropagation();

    setNoteMenuClosing(false);
    setNoteMenu({
      x: event.clientX,
      y: event.clientY,
      noteId,
    });
  }, []);

  const openCategoryMenu = useCallback((event: MouseEvent<HTMLElement>, category: string) => {
    event.preventDefault();
    event.stopPropagation();
    setCategoryMenu({
      x: event.clientX,
      y: event.clientY,
      category,
    });
    setCategoryMenuClosing(false);
    setCategoryMenuConfirmDelete(false);
  }, []);

  return {
    noteMenu,
    noteMenuClosing,
    setNoteMenuClosing,
    noteMenuMode,
    setNoteMenuMode,
    noteMenuRef,
    noteMenuPosition,
    openNoteMenu,
    categoryMenu,
    categoryMenuClosing,
    setCategoryMenuClosing,
    categoryMenuConfirmDelete,
    categoryMenuHoverSuppressed,
    categoryMenuRef,
    categoryMenuPosition,
    switchCategoryMenuPanel,
    openCategoryMenu,
  };
}
