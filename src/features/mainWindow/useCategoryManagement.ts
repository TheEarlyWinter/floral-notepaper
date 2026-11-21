import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { showToast } from "../../components/Toast";
import { createCategory, deleteCategory, getErrorMessage, renameCategory } from "../notes/api";
import type { NoteMetadata } from "../notes/types";

export function useCategoryManagement(
  refreshNotes: () => Promise<NoteMetadata[]>,
  setCategories: Dispatch<SetStateAction<string[]>>,
) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [showCategoryInput, setShowCategoryInput] = useState(false);
  const [categoryInputValue, setCategoryInputValue] = useState("");
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renameCategoryValue, setRenameCategoryValue] = useState("");

  const expandCategory = useCallback((category: string) => {
    if (!category) return;
    setCollapsedCategories((current) => {
      if (!current.has(category)) return current;
      const next = new Set(current);
      next.delete(category);
      return next;
    });
  }, []);

  const handleCreateCategory = async () => {
    const name = categoryInputValue.trim();
    if (!name) {
      setShowCategoryInput(false);
      return;
    }
    try {
      await createCategory(name);
      setCategories((prev) => [...prev, name].sort());
      setShowCategoryInput(false);
      setCategoryInputValue("");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleRenameCategory = async (oldName: string) => {
    const newName = renameCategoryValue.trim();
    if (!newName || newName === oldName) {
      setRenamingCategory(null);
      return;
    }

    try {
      await renameCategory(oldName, newName);
      await refreshNotes();
      setRenamingCategory(null);
      setRenameCategoryValue("");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleDeleteCategory = async (name: string) => {
    try {
      await deleteCategory(name);
      await refreshNotes();
      if (activeCategory === name) {
        setActiveCategory("");
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const toggleCategoryCollapse = useCallback((category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  return {
    collapsedCategories,
    setCollapsedCategories,
    activeCategory,
    setActiveCategory,
    showCategoryInput,
    setShowCategoryInput,
    categoryInputValue,
    setCategoryInputValue,
    renamingCategory,
    setRenamingCategory,
    renameCategoryValue,
    setRenameCategoryValue,
    expandCategory,
    handleCreateCategory,
    handleRenameCategory,
    handleDeleteCategory,
    toggleCategoryCollapse,
  };
}
