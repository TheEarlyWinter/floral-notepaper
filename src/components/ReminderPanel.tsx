import { useCallback, useEffect, useState } from "react";
import { createReminder, deleteReminder, getErrorMessage, listReminders } from "../features/notes/api";
import type { Reminder } from "../features/notes/types";

interface ReminderPanelProps {
  noteId: string;
  noteTitle: string;
  onClose: () => void;
}

function toDateTimeInputValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function ReminderPanel({ noteId, noteTitle, onClose }: ReminderPanelProps) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [remindAt, setRemindAt] = useState(() => toDateTimeInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [message, setMessage] = useState(noteTitle || "笔记提醒");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await listReminders();
      setReminders(loaded.filter((reminder) => reminder.noteId === noteId && !reminder.notified));
    } catch (reason) {
      setError(getErrorMessage(reason));
    }
  }, [noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setMessage(noteTitle || "笔记提醒");
  }, [noteTitle]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const date = new Date(remindAt);
    if (!message.trim()) {
      setError("请写下提醒内容");
      return;
    }
    if (Number.isNaN(date.getTime()) || date <= new Date()) {
      setError("请选择未来的提醒时间");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createReminder(noteId, message.trim(), date.toISOString());
      setRemindAt(toDateTimeInputValue(new Date(Date.now() + 60 * 60 * 1000)));
      await load();
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await deleteReminder(id);
      await load();
    } catch (reason) {
      setError(getErrorMessage(reason));
    }
  };

  return (
    <aside className="w-[360px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between h-11 px-4 border-b border-paper-deep/25">
        <div>
          <h2 className="text-[13px] font-display font-medium text-ink-soft">笔记提醒</h2>
          <p className="text-[10px] text-ink-ghost mt-0.5 truncate max-w-[260px]">{noteTitle || "无标题笔记"}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭提醒" className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
      </div>
      <form onSubmit={(event) => void handleCreate(event)} className="px-4 py-4 border-b border-paper-deep/20 space-y-3">
        <label className="block text-[11px] text-ink-faint">
          提醒内容
          <input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={120} className="mt-1.5 h-8 w-full rounded-md border border-paper-deep/35 bg-paper/70 px-2.5 text-[12px] text-ink-soft outline-none focus:border-bamboo/60" />
        </label>
        <label className="block text-[11px] text-ink-faint">
          时间
          <input type="datetime-local" value={remindAt} onChange={(event) => setRemindAt(event.target.value)} className="mt-1.5 h-8 w-full rounded-md border border-paper-deep/35 bg-paper/70 px-2.5 text-[12px] text-ink-soft outline-none focus:border-bamboo/60" />
        </label>
        {error ? <p role="alert" className="text-[11px] text-red-400">{error}</p> : null}
        <button type="submit" disabled={saving} className="h-8 w-full rounded-md bg-bamboo text-white text-[12px] hover:bg-bamboo/90 disabled:opacity-50 transition-colors cursor-pointer">
          {saving ? "保存中…" : "设置提醒"}
        </button>
      </form>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {reminders.length === 0 ? <p className="py-8 text-center text-[12px] text-ink-ghost">这篇笔记还没有未到期的提醒。</p>
          : <div className="space-y-2">{reminders.map((reminder) => (
            <div key={reminder.id} className="rounded-lg border border-paper-deep/25 bg-paper-warm/35 px-3 py-2.5 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-ink-soft break-words">{reminder.message}</p>
                <p className="mt-1 text-[10px] text-ink-ghost">{new Date(reminder.remindAt).toLocaleString()}</p>
              </div>
              <button type="button" onClick={() => void handleDelete(reminder.id)} aria-label="删除提醒" title="删除提醒" className="w-6 h-6 shrink-0 flex items-center justify-center rounded text-ink-ghost hover:text-red-400 hover:bg-red-50 transition-colors cursor-pointer">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>
              </button>
            </div>
          ))}</div>}
      </div>
    </aside>
  );
}
