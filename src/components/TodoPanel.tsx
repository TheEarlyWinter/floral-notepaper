import { useCallback, useEffect, useMemo, useState } from "react";
import { getNote, getErrorMessage } from "../features/notes/api";
import type { Note, NoteMetadata } from "../features/notes/types";
import { extractTodos, type TodoItem } from "../features/notes/todoUtils";

interface TodoPanelProps {
  notes: NoteMetadata[];
  onOpenNote: (noteId: string) => void;
  onToggleTodo: (note: Note, item: TodoItem, completed: boolean) => Promise<void>;
  onClose: () => void;
}

export function TodoPanel({ notes, onOpenNote, onToggleTodo, onClose }: TodoPanelProps) {
  const [loadedNotes, setLoadedNotes] = useState<Note[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [pendingItem, setPendingItem] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await Promise.all(notes.map((note) => getNote(note.id)));
      setLoadedNotes(result);
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setIsLoading(false);
    }
  }, [notes]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const todos = useMemo(() => loadedNotes.flatMap((note) => extractTodos(note)), [loadedNotes]);
  const visibleTodos = showCompleted ? todos : todos.filter((item) => !item.completed);
  const openCount = todos.filter((item) => !item.completed).length;

  const handleToggle = async (item: TodoItem) => {
    const note = loadedNotes.find((candidate) => candidate.id === item.noteId);
    if (!note) return;

    const key = `${item.noteId}:${item.line}`;
    setPendingItem(key);
    try {
      await onToggleTodo(note, item, !item.completed);
      await reload();
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setPendingItem(null);
    }
  };

  return (
    <aside className="w-[360px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between h-11 px-4 border-b border-paper-deep/25">
        <div>
          <h2 className="text-[13px] font-display font-medium text-ink-soft">待办聚合</h2>
          <p className="text-[10px] text-ink-ghost mt-0.5">{openCount} 项未完成</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭待办"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div className="px-4 py-3 border-b border-paper-deep/20">
        <label className="flex items-center gap-2 text-[11px] text-ink-faint cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(event) => setShowCompleted(event.target.checked)}
            className="accent-bamboo"
          />
          显示已完成事项
        </label>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {isLoading ? (
          <div className="py-10 text-center text-[12px] text-ink-ghost">正在整理待办…</div>
        ) : error ? (
          <div className="py-10 text-center text-[12px] text-red-400">{error}</div>
        ) : visibleTodos.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-ink-ghost leading-relaxed">
            {showCompleted ? "还没有 Markdown 待办" : "所有待办都完成啦"}
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleTodos.map((item) => {
              const key = `${item.noteId}:${item.line}`;
              const pending = key === pendingItem;
              return (
                <div
                  key={key}
                  className="rounded-lg border border-paper-deep/25 bg-paper-warm/35 px-3 py-2.5"
                >
                  <div className="flex gap-2.5">
                    <input
                      type="checkbox"
                      checked={item.completed}
                      disabled={pending}
                      onChange={() => void handleToggle(item)}
                      className="mt-0.5 accent-bamboo cursor-pointer disabled:cursor-wait"
                      aria-label={`标记待办：${item.text}`}
                    />
                    <button
                      type="button"
                      onClick={() => onOpenNote(item.noteId)}
                      className={`min-w-0 flex-1 text-left text-[12px] leading-relaxed hover:text-bamboo transition-colors cursor-pointer ${item.completed ? "line-through text-ink-ghost" : "text-ink-soft"}`}
                      title="打开原笔记"
                    >
                      {item.text}
                    </button>
                  </div>
                  <div className="pl-6 mt-1 flex items-center gap-1.5 text-[10px] text-ink-ghost">
                    <span className="truncate">{item.noteTitle}</span>
                    {item.category && (
                      <>
                        <span>·</span>
                        <span>{item.category}</span>
                      </>
                    )}
                    <span>· 第 {item.line} 行</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
