import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createNote, createReminder, getNote, searchNotes } from "../features/notes/api";
import {
  calculateDashboardStats,
  findDuplicatePairs,
  findDuplicateSuggestions,
  INBOX_CATEGORY,
  isDailyNote,
  isInboxNote,
  type SearchHit,
} from "../features/notes/insights";
import { getDisplayTitle } from "../features/notes/noteUtils";
import type { IndexedSearchResult, Note, NoteMetadata } from "../features/notes/types";
import { buildWeeklyReviewMarkdown, calculateWeeklyReview } from "../features/notes/reviewUtils";

export type NotesWorkspaceMode = "dashboard" | "inbox" | "journal" | "search";

interface NotesWorkspacePanelProps {
  mode: NotesWorkspaceMode;
  notes: NoteMetadata[];
  categories: string[];
  query?: string;
  onOpenNote: (noteId: string, hit?: SearchHit) => void;
  onMoveNote: (noteId: string, category: string) => void;
  onMergeNotes: (targetId: string, sourceId: string) => void;
  onClose: () => void;
  onWeeklyReviewCreated?: (note: Note) => void;
}

function highlight(text: string, query: string) {
  const term = query.trim();
  if (!term) return text;
  const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-yellow-200/70 px-0.5 text-inherit">{text.slice(index, index + term.length)}</mark>
      {text.slice(index + term.length)}
    </>
  );
}

function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-paper-deep/20">
      <div>
        <h2 className="text-[15px] font-display font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="mt-1 text-[11px] text-ink-ghost leading-relaxed">{subtitle}</p> : null}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink hover:bg-paper-warm transition-colors cursor-pointer"
        aria-label="关闭"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-6 py-12 text-center text-[12px] text-ink-ghost leading-6">{children}</div>;
}

export function NotesWorkspacePanel({
  mode,
  notes,
  categories,
  query = "",
  onOpenNote,
  onMoveNote,
  onMergeNotes,
  onClose,
  onWeeklyReviewCreated,
}: NotesWorkspacePanelProps) {
  const [loadedNotes, setLoadedNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [indexedSearchHits, setIndexedSearchHits] = useState<IndexedSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [creatingReview, setCreatingReview] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all(notes.map((note) => getNote(note.id).catch(() => null))).then((items) => {
      if (!active) return;
      setLoadedNotes(items.filter((item): item is Note => item !== null));
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [notes]);

  const noteById = useMemo(() => new Map(loadedNotes.map((note) => [note.id, note])), [loadedNotes]);
  const inboxNotes = useMemo(() => notes.filter(isInboxNote), [notes]);
  const dailyNotes = useMemo(
    () => notes.filter(isDailyNote).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [notes],
  );
  const stats = useMemo(() => calculateDashboardStats(notes, loadedNotes), [notes, loadedNotes]);
  const duplicatePairs = useMemo(() => findDuplicatePairs(loadedNotes), [loadedNotes]);
  const weeklyReview = useMemo(() => calculateWeeklyReview(notes, loadedNotes), [notes, loadedNotes]);

  useEffect(() => {
    if (mode !== "search" || !query.trim()) { setIndexedSearchHits([]); return; }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchNotes(query).then((hits) => { if (active) setIndexedSearchHits(hits); }).catch(() => { if (active) setIndexedSearchHits([]); }).finally(() => { if (active) setSearching(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [mode, query]);

  if (mode === "search") {
    return (
      <div className="h-full flex flex-col bg-paper/70">
        <PanelHeader title="搜索结果" subtitle={query ? `“${query}” 的正文命中` : "输入关键词后会在标题与正文中查找"} onClose={onClose} />
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          {searching ? <EmptyState>正在查本地索引…</EmptyState> : null}
          {!searching && !query.trim() ? <EmptyState>输入关键词，就能看到带上下文的命中结果。</EmptyState> : null}
          {!searching && query.trim() && indexedSearchHits.length === 0 ? <EmptyState>没有找到正文命中。</EmptyState> : null}
          <div className="space-y-2">
            {indexedSearchHits.map((hit) => (
              <button
                key={`${hit.noteId}:${hit.matchStart}`}
                type="button"
                onClick={() => onOpenNote(hit.noteId, { ...hit, matchLength: query.trim().length })}
                className="w-full rounded-xl border border-paper-deep/25 bg-cloud/45 px-3 py-2.5 text-left hover:border-bamboo/35 hover:bg-bamboo-mist/30 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2 text-[12px] font-medium text-ink-soft">
                  <span className="truncate">{highlight(hit.title, query)}</span>
                  {hit.category ? <span className="ml-auto shrink-0 text-[9px] text-ink-ghost">{hit.category}</span> : null}
                </div>
                <p className="mt-1.5 text-[11px] text-ink-ghost leading-relaxed line-clamp-3">{highlight(hit.snippet, query)}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (mode === "inbox") {
    return (
      <div className="h-full flex flex-col bg-paper/70">
        <PanelHeader title="收件箱" subtitle={`还有 ${inboxNotes.length} 条想法等你慢慢归位`} onClose={onClose} />
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          {loading ? <EmptyState>正在整理收件箱…</EmptyState> : null}
          {!loading && inboxNotes.length === 0 ? <EmptyState>收件箱已经清空啦。快速记录的内容会先安静地落在这里。</EmptyState> : null}
          <div className="space-y-2.5">
            {inboxNotes.map((metadata) => {
              const note = noteById.get(metadata.id);
              const duplicates = note ? findDuplicateSuggestions(note, loadedNotes) : [];
              return (
                <article key={metadata.id} className="rounded-xl border border-paper-deep/25 bg-cloud/45 px-3 py-3">
                  <button type="button" onClick={() => onOpenNote(metadata.id)} className="w-full text-left cursor-pointer">
                    <h3 className="text-[13px] font-display font-medium text-ink truncate">{getDisplayTitle(metadata)}</h3>
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-ghost line-clamp-2">{metadata.preview || "空白笔记"}</p>
                  </button>
                  <div className="mt-2.5 flex items-center gap-2">
                    <label className="flex-1 min-w-0">
                      <span className="sr-only">整理到分类</span>
                      <select
                        value={INBOX_CATEGORY}
                        onChange={(event) => {
                          if (event.target.value !== INBOX_CATEGORY) onMoveNote(metadata.id, event.target.value);
                        }}
                        className="w-full h-7 rounded-lg border border-paper-deep/25 bg-paper-warm/60 px-2 text-[10px] text-ink-faint cursor-pointer"
                      >
                        <option value={INBOX_CATEGORY}>整理到…</option>
                        <option value="">未分类</option>
                        {categories.filter((category) => category !== INBOX_CATEGORY).map((category) => <option key={category} value={category}>{category}</option>)}
                      </select>
                    </label>
                    <button type="button" onClick={() => { const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0); void createReminder(metadata.id, `整理收件箱：${getDisplayTitle(metadata)}`, tomorrow.toISOString()); }} className="h-7 px-2 rounded-lg text-[10px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist cursor-pointer">明天看</button>
                    <button type="button" onClick={() => onOpenNote(metadata.id)} className="h-7 px-2 rounded-lg text-[10px] text-bamboo hover:bg-bamboo-mist cursor-pointer">编辑</button>
                  </div>
                  {duplicates.length > 0 ? (
                    <div className="mt-3 border-t border-paper-deep/15 pt-2">
                      <p className="text-[10px] text-ink-ghost">可能和这些笔记重复：</p>
                      {duplicates.map((duplicate) => (
                        <div key={duplicate.noteId} className="mt-1 flex items-center gap-1.5 text-[10px]">
                          <button type="button" onClick={() => onOpenNote(duplicate.noteId)} className="min-w-0 flex-1 truncate text-left text-ink-faint hover:text-bamboo cursor-pointer">{duplicate.title}</button>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm(`将「${getDisplayTitle(metadata)}」合并到「${duplicate.title}」？来源笔记会移入回收站。`)) {
                                onMergeNotes(duplicate.noteId, metadata.id);
                              }
                            }}
                            className="shrink-0 rounded-md px-1.5 py-0.5 text-bamboo hover:bg-bamboo-mist cursor-pointer"
                          >
                            合并
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (mode === "journal") {
    return (
      <div className="h-full flex flex-col bg-paper/70">
        <PanelHeader title="日记流" subtitle="每天写下的便笺，按最近更新静静排列。" onClose={onClose} />
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          {dailyNotes.length === 0 ? <EmptyState>还没有每日便笺。写下今天的第一句话，它就会出现在这里。</EmptyState> : null}
          <div className="relative ml-2 border-l border-bamboo/20 pl-4 space-y-3">
            {dailyNotes.map((note) => (
              <button key={note.id} type="button" onClick={() => onOpenNote(note.id)} className="relative w-full rounded-xl border border-paper-deep/20 bg-cloud/45 p-3 text-left hover:border-bamboo/35 hover:bg-bamboo-mist/25 transition-colors cursor-pointer">
                <span className="absolute -left-[21px] top-4 w-2.5 h-2.5 rounded-full border-2 border-paper bg-bamboo/65" />
                <div className="text-[12px] font-medium text-ink">{getDisplayTitle(note)}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-ghost line-clamp-3">{note.preview || "空白便笺"}</p>
                <div className="mt-2 text-[10px] text-ink-ghost">更新于 {new Date(note.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-paper/70">
      <PanelHeader title="笔记仪表盘" subtitle="今天的笔记与待办，轻轻看一眼就好。" onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {loading ? <EmptyState>正在汇总今天的笔记…</EmptyState> : null}
        {!loading ? <>
          <div className="grid grid-cols-2 gap-2">
            {[
              ["待整理", stats.inboxCount, "收件箱"],
              ["未完成", stats.openTodos, "待办"],
              ["今天写下", stats.createdToday, "篇"],
              ["连续日记", stats.dailyStreak, "天"],
            ].map(([label, value, unit]) => (
              <div key={String(label)} className="rounded-xl border border-paper-deep/20 bg-cloud/55 px-3 py-3">
                <p className="text-[10px] text-ink-ghost">{label}</p>
                <p className="mt-1 text-[20px] font-display text-ink">{value}<span className="ml-1 text-[10px] text-ink-ghost">{unit}</span></p>
              </div>
            ))}
          </div>
          <section className="rounded-xl border border-paper-deep/20 bg-cloud/45 p-3">
            <div className="flex items-center justify-between"><h3 className="text-[12px] font-medium text-ink">笔记概览</h3><span className="text-[10px] text-ink-ghost">共 {notes.length} 篇 · {stats.totalWords} 字</span></div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-ghost">今天更新了 {stats.updatedToday} 篇笔记，累计完成 {stats.completedTodos} 个待办。</p>
          </section>
          <section className="rounded-xl border border-paper-deep/20 bg-cloud/45 p-3">
            <div className="flex items-center justify-between"><h3 className="text-[12px] font-medium text-ink">最近日记</h3><button type="button" onClick={() => onOpenNote(dailyNotes[0]?.id)} disabled={!dailyNotes[0]} className="text-[10px] text-bamboo disabled:opacity-30 cursor-pointer">打开最近一篇</button></div>
            <div className="mt-2 space-y-1.5">
              {dailyNotes.slice(0, 3).map((note) => <button key={note.id} type="button" onClick={() => onOpenNote(note.id)} className="block w-full truncate text-left text-[11px] text-ink-faint hover:text-bamboo cursor-pointer">{getDisplayTitle(note)}</button>)}
              {dailyNotes.length === 0 ? <p className="text-[11px] text-ink-ghost">还没有每日便笺。</p> : null}
            </div>
          </section>
          <section className="rounded-xl border border-paper-deep/20 bg-cloud/45 p-3">
            <div className="flex items-center justify-between gap-2"><h3 className="text-[12px] font-medium text-ink">本周回顾</h3><button type="button" disabled={creatingReview} onClick={() => { setCreatingReview(true); void createNote({ title: `本周回顾 ${weeklyReview.weekLabel}`, content: buildWeeklyReviewMarkdown(weeklyReview), category: "每周回顾", tags: ["weekly-review"], pinned: false }).then((note) => onWeeklyReviewCreated?.(note)).finally(() => setCreatingReview(false)); }} className="shrink-0 text-[10px] text-bamboo disabled:opacity-40 cursor-pointer">{creatingReview ? "生成中…" : "生成草稿"}</button></div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-ghost">本周新建 {weeklyReview.created} 篇、更新 {weeklyReview.updated} 篇，收件箱还有 {weeklyReview.inboxCount} 条。</p>
            {weeklyReview.topTags.length ? <p className="mt-1 text-[10px] text-ink-ghost">常见主题：{weeklyReview.topTags.map((tag) => `#${tag}`).join(" · ")}</p> : null}
          </section>
          <section className="rounded-xl border border-paper-deep/20 bg-cloud/45 p-3">
            <div className="flex items-center justify-between"><h3 className="text-[12px] font-medium text-ink">重复整理建议</h3><span className="text-[10px] text-ink-ghost">{duplicatePairs.length} 组</span></div>
            <div className="mt-2 space-y-2">
              {duplicatePairs.slice(0, 3).map((pair) => (
                <div key={`${pair.first.noteId}:${pair.second.noteId}`} className="rounded-lg bg-paper-warm/45 px-2 py-2">
                  <button type="button" onClick={() => onOpenNote(pair.first.noteId)} className="block w-full truncate text-left text-[10px] text-ink-faint hover:text-bamboo cursor-pointer">{pair.first.title}</button>
                  <button type="button" onClick={() => onOpenNote(pair.second.noteId)} className="mt-0.5 block w-full truncate text-left text-[10px] text-ink-faint hover:text-bamboo cursor-pointer">{pair.second.title}</button>
                  <button type="button" onClick={() => { if (window.confirm(`将「${pair.second.title}」合并到「${pair.first.title}」？来源笔记会移入回收站。`)) onMergeNotes(pair.first.noteId, pair.second.noteId); }} className="mt-1.5 rounded-md px-1.5 py-0.5 text-[10px] text-bamboo hover:bg-bamboo-mist cursor-pointer">合并第二篇到第一篇</button>
                </div>
              ))}
              {duplicatePairs.length === 0 ? <p className="text-[11px] text-ink-ghost">暂时没有足够相似的笔记。</p> : null}
            </div>
          </section>
        </> : null}
      </div>
    </div>
  );
}
