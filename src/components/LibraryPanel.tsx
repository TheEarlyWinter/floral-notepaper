import { useCallback, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  addAttachment,
  createBackup,
  deleteAttachment,
  getAttachmentPath,
  getErrorMessage,
  listAttachments,
  listBackups,
  restoreBackup,
} from "../features/notes/api";
import type { Attachment, BackupInfo } from "../features/notes/types";
import { showToast } from "./Toast";

interface LibraryPanelProps {
  noteId: string | null;
  noteTitle: string;
  onClose: () => void;
  onRestored: () => void;
}

function readableSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function LibraryPanel({ noteId, noteTitle, onClose, onRestored }: LibraryPanelProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [loadedAttachments, loadedBackups] = await Promise.all([
        noteId ? listAttachments(noteId) : Promise.resolve([]),
        listBackups(),
      ]);
      setAttachments(loadedAttachments);
      setBackups(loadedBackups);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [noteId]);

  useEffect(() => { void load(); }, [load]);

  const handleAddAttachment = async () => {
    if (!noteId) { showToast("先打开一篇笔记，再添加资料", "warning"); return; }
    const path = await open({ multiple: false, directory: false });
    if (typeof path !== "string") return;
    setBusy(true);
    try { await addAttachment(noteId, path); await load(); showToast("资料已附到当前笔记"); }
    catch (error) { showToast(getErrorMessage(error)); }
    finally { setBusy(false); }
  };

  const handleCreateBackup = async () => {
    const path = await save({ defaultPath: `花笺备份-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "ZIP 备份", extensions: ["zip"] }] });
    if (typeof path !== "string") return;
    setBusy(true);
    try { await createBackup(path); await load(); showToast("完整备份已保存"); }
    catch (error) { showToast(getErrorMessage(error)); }
    finally { setBusy(false); }
  };

  const handleRestore = async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "ZIP 备份", extensions: ["zip"] }] });
    if (typeof path !== "string") return;
    if (!window.confirm("恢复会替换当前笔记库。花笺会先自动备份当前内容，确定继续吗？")) return;
    setBusy(true);
    try { await restoreBackup(path); await load(); onRestored(); showToast("备份已恢复，并已重新建立搜索索引"); }
    catch (error) { showToast(getErrorMessage(error)); }
    finally { setBusy(false); }
  };

  return <aside className="w-[360px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
    <div className="flex items-center justify-between h-11 px-4 border-b border-paper-deep/25">
      <div><h2 className="text-[13px] font-display font-medium text-ink-soft">资料与备份</h2><p className="text-[10px] text-ink-ghost mt-0.5 truncate max-w-[260px]">{noteTitle || "选择笔记后可附加资料"}</p></div>
      <button type="button" onClick={onClose} aria-label="关闭资料与备份" className="w-7 h-7 rounded-lg text-ink-ghost hover:text-ink hover:bg-paper-warm cursor-pointer">×</button>
    </div>
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <section className="rounded-xl border border-paper-deep/20 bg-paper/55 p-3">
        <div className="flex items-center justify-between gap-2"><h3 className="text-[12px] font-medium text-ink">本篇资料</h3><button type="button" disabled={busy || !noteId} onClick={() => void handleAddAttachment()} className="text-[10px] text-bamboo disabled:opacity-40 cursor-pointer">添加附件</button></div>
        <p className="mt-1 text-[10px] leading-relaxed text-ink-ghost">附件只保存在本地，并会随完整备份一起带走。</p>
        <div className="mt-2 space-y-1.5">{attachments.map((attachment) => <div key={attachment.id} className="flex items-center gap-2 rounded-lg bg-paper-warm/55 px-2 py-2"><button type="button" onClick={() => { if (noteId) void getAttachmentPath(noteId, attachment.id).then((path) => openPath(path)); }} className="min-w-0 flex-1 truncate text-left text-[11px] text-ink-faint hover:text-bamboo cursor-pointer" title={`打开 ${attachment.name}`}>{attachment.name}<small className="ml-1 text-ink-ghost">{readableSize(attachment.size)}</small></button><button type="button" onClick={() => { if (noteId) void getAttachmentPath(noteId, attachment.id).then((path) => navigator.clipboard.writeText(`[${attachment.name}](file:///${path.replace(/\\/g, "/")})`)); }} className="text-[10px] text-ink-ghost hover:text-bamboo cursor-pointer">引用</button><button type="button" onClick={() => { if (noteId && window.confirm(`从本篇笔记移除「${attachment.name}」？文件会进入系统回收站。`)) void deleteAttachment(noteId, attachment.id).then(load); }} className="text-[10px] text-ink-ghost hover:text-red-400 cursor-pointer">移除</button></div>)}</div>
        {!noteId ? <p className="mt-3 text-[11px] text-ink-ghost">打开一篇内部笔记后，才能添加附件。</p> : null}
        {noteId && attachments.length === 0 ? <p className="mt-3 text-[11px] text-ink-ghost">还没有附加资料。</p> : null}
      </section>
      <section className="rounded-xl border border-paper-deep/20 bg-paper/55 p-3">
        <div className="flex items-center justify-between"><h3 className="text-[12px] font-medium text-ink">完整备份</h3><button type="button" disabled={busy} onClick={() => void handleCreateBackup()} className="text-[10px] text-bamboo disabled:opacity-40 cursor-pointer">导出 ZIP</button></div>
        <p className="mt-1 text-[10px] leading-relaxed text-ink-ghost">包含笔记、图片、附件、历史版本和提醒。每天首次写入会在本地自动保留一份快照，最多保留 30 份。</p>
        <button type="button" disabled={busy} onClick={() => void handleRestore()} className="mt-3 h-7 w-full rounded-lg border border-paper-deep/30 text-[11px] text-ink-faint hover:text-bamboo hover:border-bamboo/40 disabled:opacity-40 cursor-pointer">从 ZIP 恢复…</button>
      </section>
      <section className="rounded-xl border border-paper-deep/20 bg-paper/55 p-3"><h3 className="text-[12px] font-medium text-ink">自动快照</h3><div className="mt-2 space-y-1.5">{backups.slice(0, 6).map((backup) => <div key={`${backup.fileName}:${backup.createdAt}`} className="flex justify-between gap-2 text-[10px] text-ink-ghost"><span className="truncate">{backup.automatic ? "自动" : "恢复前保护"} · {new Date(backup.createdAt).toLocaleString()}</span><span>{readableSize(backup.size)}</span></div>)}{backups.length === 0 ? <p className="text-[11px] text-ink-ghost">下一次保存笔记后会生成当天第一份快照。</p> : null}</div></section>
    </div>
  </aside>;
}
