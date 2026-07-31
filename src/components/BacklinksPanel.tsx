import { useCallback, useEffect, useMemo, useState } from "react";
import { getErrorMessage, getNote } from "../features/notes/api";
import type { Note, NoteMetadata } from "../features/notes/types";
import { findBacklinks } from "../features/notes/wikiLinks";

interface BacklinksPanelProps {
  noteId: string;
  notes: NoteMetadata[];
  onOpenNote: (noteId: string) => void;
  onClose: () => void;
}

export function BacklinksPanel({ noteId, notes, onOpenNote, onClose }: BacklinksPanelProps) {
  const [loadedNotes, setLoadedNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLoadedNotes(await Promise.all(notes.map((note) => getNote(note.id))));
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [notes]);

  useEffect(() => {
    // 防抖：连续保存（每次 notes 变化）时不反复全量重拉正文
    const timer = window.setTimeout(() => {
      void load();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [load]);
  const backlinks = useMemo(() => findBacklinks(noteId, loadedNotes), [loadedNotes, noteId]);

  return (
    <aside className="w-[360px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between h-11 px-4 border-b border-paper-deep/25">
        <div>
          <h2 className="text-[13px] font-display font-medium text-ink-soft">反向链接</h2>
          <p className="text-[10px] text-ink-ghost mt-0.5">{backlinks.length} 篇笔记提到这里</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭反向链接" className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading ? <div className="py-10 text-center text-[12px] text-ink-ghost">正在查找引用…</div>
          : error ? <div className="py-10 text-center text-[12px] text-red-400">{error}</div>
          : backlinks.length === 0 ? <div className="py-10 text-center text-[12px] text-ink-ghost leading-relaxed">还没有其他笔记链接到这里。<br />可使用 [[笔记标题]] 或 [[note:笔记ID|标题]]。</div>
          : <div className="space-y-1.5">{backlinks.map((link) => (
            <button key={link.noteId} type="button" onClick={() => onOpenNote(link.noteId)} className="w-full rounded-lg border border-paper-deep/25 bg-paper-warm/35 px-3 py-2.5 text-left hover:bg-bamboo-mist/50 transition-colors cursor-pointer">
              <p className="text-[12px] text-ink-soft truncate">{link.noteTitle}</p>
              {link.category && <p className="mt-1 text-[10px] text-ink-ghost">{link.category}</p>}
            </button>
          ))}</div>}
      </div>
    </aside>
  );
}
