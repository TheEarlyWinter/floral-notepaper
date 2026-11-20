import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { searchNotes } from "../features/notes/api";
import { getDisplayTitle } from "../features/notes/noteUtils";
import type { IndexedSearchResult, NoteMetadata } from "../features/notes/types";

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  shortcut?: string;
  disabled?: boolean;
  onExecute: () => void | Promise<void>;
}

export type PaletteItem =
  | {
      kind: "note";
      id: string;
      noteId: string;
      title: string;
      category: string;
      tags: string[];
      snippet?: string;
      matchStart?: number;
      matchLength?: number;
    }
  | {
      kind: "command";
      id: string;
      command: PaletteCommand;
    }
  | {
      kind: "create-note";
      id: string;
      title: string;
    };

export interface CommandPaletteProps {
  open: boolean;
  notes: NoteMetadata[];
  commands: PaletteCommand[];
  onSelectNote: (noteId: string, matchStart?: number, matchLength?: number) => void | Promise<void>;
  onCreateNote: (title: string) => void | Promise<void>;
  onClose: (options?: { restoreFocus?: boolean }) => void;
  searchNotesFn?: (query: string) => Promise<IndexedSearchResult[]>;
  debounceMs?: number;
  initialQuery?: string;
}

export function isCommandOnlyQuery(query: string): boolean {
  return query.trimStart().startsWith(">");
}

export function stripCommandPrefix(query: string): string {
  return query.replace(/^\s*>\s*/, "");
}

export function toggleCommandOnlyQuery(query: string): string {
  if (isCommandOnlyQuery(query)) {
    return stripCommandPrefix(query);
  }
  const trimmedStart = query.trimStart();
  return trimmedStart ? `>${trimmedStart}` : ">";
}

function scoreFieldMatch(text: string, needle: string): number {
  const lower = text.toLowerCase();
  if (!lower || !needle) return 0;
  if (lower === needle) return 100;
  if (lower.startsWith(needle)) return 80;
  if (lower.includes(needle)) return 60;
  return 0;
}

export function filterPaletteCommands(
  commands: PaletteCommand[],
  rawQuery: string,
  limit?: number,
): PaletteCommand[] {
  const normalized = rawQuery.trim().toLowerCase();
  if (!normalized) {
    return limit == null ? [...commands] : commands.slice(0, limit);
  }

  const terms = normalized.split(/\s+/).filter(Boolean);
  const scored: Array<{ command: PaletteCommand; score: number; index: number }> = [];

  commands.forEach((command, index) => {
    const label = command.label.toLowerCase();
    const description = (command.description ?? "").toLowerCase();
    const keywords = (command.keywords ?? []).map((kw) => kw.toLowerCase());
    const haystack = [label, description, ...keywords].join(" ");

    if (!terms.every((term) => haystack.includes(term))) {
      return;
    }

    let score = scoreFieldMatch(label, normalized) * 3;
    for (const kw of keywords) {
      score = Math.max(score, scoreFieldMatch(kw, normalized) * 2);
    }
    score = Math.max(score, scoreFieldMatch(description, normalized));
    if (score === 0) {
      score = 20;
    }

    scored.push({ command, score, index });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const matched = scored.map((entry) => entry.command);
  return limit == null ? matched : matched.slice(0, limit);
}

function scoreLocalNote(
  note: NoteMetadata,
  displayTitle: string,
  normalizedQuery: string,
  terms: string[],
): number {
  const titleLower = note.title.toLowerCase();
  const displayLower = displayTitle.toLowerCase();
  const categoryLower = note.category.toLowerCase();
  const tagsLower = (note.tags ?? []).map((tag) => tag.toLowerCase());
  const haystack = [
    titleLower,
    displayLower,
    categoryLower,
    ...tagsLower,
    ...tagsLower.map((tag) => `#${tag}`),
  ].join(" ");

  if (!terms.every((term) => haystack.includes(term))) {
    return 0;
  }

  let score = Math.max(
    scoreFieldMatch(titleLower, normalizedQuery) * 4,
    scoreFieldMatch(displayLower, normalizedQuery) * 3,
    scoreFieldMatch(categoryLower, normalizedQuery) * 2,
  );
  for (const tag of tagsLower) {
    score = Math.max(
      score,
      scoreFieldMatch(tag, normalizedQuery) * 2,
      scoreFieldMatch(`#${tag}`, normalizedQuery) * 2,
    );
  }
  return score || 15;
}

export function buildPaletteItems({
  query,
  notes,
  ftsHits,
  commands,
  t,
  maxNotes = 10,
  maxRecentNotes = 5,
  maxUnifiedCommands = 6,
}: {
  query: string;
  notes: NoteMetadata[];
  ftsHits: IndexedSearchResult[];
  commands: PaletteCommand[];
  t: TFunction;
  maxNotes?: number;
  maxRecentNotes?: number;
  maxUnifiedCommands?: number;
}): PaletteItem[] {
  if (isCommandOnlyQuery(query)) {
    const commandQuery = stripCommandPrefix(query);
    return filterPaletteCommands(commands, commandQuery).map((command) => ({
      kind: "command",
      id: `cmd:${command.id}`,
      command,
    }));
  }

  const trimmed = query.trim();
  if (!trimmed) {
    const recentNotes: PaletteItem[] = notes.slice(0, maxRecentNotes).map((note) => ({
      kind: "note",
      id: `note:${note.id}`,
      noteId: note.id,
      title: getDisplayTitle(note, t),
      category: note.category,
      tags: note.tags ?? [],
    }));
    const commandItems: PaletteItem[] = commands.map((command) => ({
      kind: "command",
      id: `cmd:${command.id}`,
      command,
    }));
    return [...recentNotes, ...commandItems];
  }

  const normalized = trimmed.toLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  const noteById = new Map(notes.map((note) => [note.id, note]));

  const localScored: Array<{ note: NoteMetadata; displayTitle: string; score: number }> = [];
  for (const note of notes) {
    const displayTitle = getDisplayTitle(note, t);
    const score = scoreLocalNote(note, displayTitle, normalized, terms);
    if (score > 0) {
      localScored.push({ note, displayTitle, score });
    }
  }
  localScored.sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt));

  const mergedNotes = new Map<string, Extract<PaletteItem, { kind: "note" }>>();
  for (const entry of localScored) {
    mergedNotes.set(entry.note.id, {
      kind: "note",
      id: `note:${entry.note.id}`,
      noteId: entry.note.id,
      title: entry.displayTitle,
      category: entry.note.category,
      tags: entry.note.tags ?? [],
    });
  }

  for (const hit of ftsHits) {
    const existing = mergedNotes.get(hit.noteId);
    if (existing) {
      if (!existing.snippet && hit.snippet) {
        existing.snippet = hit.snippet;
      }
      if (existing.matchStart == null && hit.matchStart >= 0) {
        existing.matchStart = hit.matchStart;
        existing.matchLength = hit.matchLength > 0 ? hit.matchLength : trimmed.length;
      }
      continue;
    }
    const meta = noteById.get(hit.noteId);
    const displayTitle =
      hit.title.trim() ||
      (meta ? getDisplayTitle(meta, t) : t("common.untitledNote", { defaultValue: "无标题笔记" }));
    mergedNotes.set(hit.noteId, {
      kind: "note",
      id: `note:${hit.noteId}`,
      noteId: hit.noteId,
      title: displayTitle,
      category: meta?.category ?? hit.category,
      tags: meta?.tags ?? [],
      snippet: hit.snippet || undefined,
      matchStart: hit.matchStart >= 0 ? hit.matchStart : undefined,
      matchLength:
        hit.matchStart >= 0 ? (hit.matchLength > 0 ? hit.matchLength : trimmed.length) : undefined,
    });
  }

  const noteItems = Array.from(mergedNotes.values()).slice(0, maxNotes);
  const matchingCommands: PaletteItem[] = filterPaletteCommands(
    commands,
    trimmed,
    maxUnifiedCommands,
  ).map((command) => ({
    kind: "command",
    id: `cmd:${command.id}`,
    command,
  }));

  const createItem: PaletteItem = {
    kind: "create-note",
    id: `create:${trimmed}`,
    title: trimmed,
  };

  return [...noteItems, ...matchingCommands, createItem];
}

export function isPaletteItemDisabled(item: PaletteItem | undefined): boolean {
  return Boolean(item && item.kind === "command" && item.command.disabled);
}

export function firstSelectablePaletteIndex(items: PaletteItem[]): number {
  const index = items.findIndex((item) => !isPaletteItemDisabled(item));
  if (index >= 0) return index;
  return items.length > 0 ? 0 : -1;
}

export function nextSelectablePaletteIndex(
  items: PaletteItem[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const len = items.length;
  if (len === 0) return -1;

  const start = currentIndex >= 0 && currentIndex < len ? currentIndex : direction === 1 ? -1 : 0;
  for (let offset = 1; offset <= len; offset += 1) {
    const candidate = (((start + direction * offset) % len) + len) % len;
    if (!isPaletteItemDisabled(items[candidate])) {
      return candidate;
    }
  }

  return (((start + direction) % len) + len) % len;
}

export interface PaletteKeyDownHandlers {
  items: PaletteItem[];
  activeIndex: number;
  isComposing: boolean;
  onMove: (nextIndex: number) => void;
  onExecute: (item: PaletteItem) => void;
  onClose: () => void;
}

export interface PaletteKeyEvent {
  key: string;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function handlePaletteKeyDown(
  event: PaletteKeyEvent,
  handlers: PaletteKeyDownHandlers,
): boolean {
  const composing = Boolean(
    handlers.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229,
  );
  if (composing) {
    return false;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    handlers.onMove(nextSelectablePaletteIndex(handlers.items, handlers.activeIndex, 1));
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    handlers.onMove(nextSelectablePaletteIndex(handlers.items, handlers.activeIndex, -1));
    return true;
  }

  if (event.key === "Enter") {
    const item = handlers.items[handlers.activeIndex];
    event.preventDefault();
    if (item && !isPaletteItemDisabled(item)) {
      handlers.onExecute(item);
    }
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    handlers.onClose();
    return true;
  }

  return false;
}

export function CommandPalette({
  open,
  notes,
  commands,
  onSelectNote,
  onCreateNote,
  onClose,
  searchNotesFn = searchNotes,
  debounceMs = 160,
  initialQuery = "",
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [ftsHits, setFtsHits] = useState<IndexedSearchResult[]>([]);
  const [searchingFts, setSearchingFts] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  const commandOnly = isCommandOnlyQuery(query);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFtsHits([]);
      setSearchingFts(false);
      setActiveIndex(0);
      return;
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [open]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!open || !trimmed || isCommandOnlyQuery(query)) {
      setFtsHits([]);
      setSearchingFts(false);
      return;
    }

    let active = true;
    setSearchingFts(true);
    const timer = window.setTimeout(() => {
      void searchNotesFn(trimmed)
        .then((hits) => {
          if (active) setFtsHits(hits);
        })
        .catch(() => {
          if (active) setFtsHits([]);
        })
        .finally(() => {
          if (active) setSearchingFts(false);
        });
    }, debounceMs);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [debounceMs, open, query, searchNotesFn]);

  const items = useMemo(
    () =>
      buildPaletteItems({
        query,
        notes,
        ftsHits,
        commands,
        t,
      }),
    [commands, ftsHits, notes, query, t],
  );

  useEffect(() => {
    setActiveIndex(firstSelectablePaletteIndex(items));
  }, [items]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const container = listRef.current;
    const option = container?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  const executeItem = (item: PaletteItem) => {
    if (isPaletteItemDisabled(item)) return;
    if (item.kind === "note") {
      onClose({ restoreFocus: false });
      void onSelectNote(item.noteId, item.matchStart, item.matchLength);
      return;
    }
    if (item.kind === "command") {
      onClose({ restoreFocus: false });
      void item.command.onExecute();
      return;
    }
    onClose({ restoreFocus: false });
    void onCreateNote(item.title);
  };

  let lastKind: PaletteItem["kind"] | null = null;
  const sectionLabelFor = (kind: PaletteItem["kind"]) => {
    if (kind === "note") {
      return t("commandPalette.section.notes", { defaultValue: "笔记" });
    }
    if (kind === "command") {
      return t("commandPalette.section.commands", { defaultValue: "命令" });
    }
    return t("commandPalette.section.create", { defaultValue: "快速创建" });
  };

  return (
    <div
      data-testid="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose({ restoreFocus: true });
        }
      }}
      className="fixed inset-0 z-[9990] flex items-start justify-center pt-[12vh] px-4 bg-ink/20 backdrop-blur-[2px] animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("commandPalette.title", { defaultValue: "命令面板" })}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          handlePaletteKeyDown(event, {
            items,
            activeIndex,
            isComposing: isComposingRef.current,
            onMove: setActiveIndex,
            onExecute: executeItem,
            onClose: () => onClose({ restoreFocus: true }),
          });
        }}
        className="w-full max-w-[560px] rounded-2xl bg-cloud/95 backdrop-blur-md border border-paper-deep/65 shadow-[0_18px_48px_var(--color-shadow-deep),0_4px_12px_var(--color-shadow)] overflow-hidden flex flex-col animate-menu-enter"
      >
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-paper-deep/35">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            className="text-ink-ghost shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            placeholder={t("commandPalette.placeholder", {
              defaultValue: "搜索笔记或输入 > 执行命令…",
            })}
            spellCheck={false}
            className="flex-1 min-w-0 text-[13.5px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
          />

          {query && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label={t("commandPalette.clearQuery", { defaultValue: "清空输入" })}
              title={t("commandPalette.clearQuery", { defaultValue: "清空输入" })}
              className="w-6 h-6 flex items-center justify-center rounded-md text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer shrink-0"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}

          <button
            type="button"
            aria-pressed={commandOnly}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery((current) => toggleCommandOnlyQuery(current));
              inputRef.current?.focus();
            }}
            title={t("commandPalette.commandFilterTitle", {
              defaultValue: "切换仅命令模式 (>)",
            })}
            className={`px-2 py-1 rounded-md text-[11px] font-mono border transition-colors cursor-pointer shrink-0 ${
              commandOnly
                ? "bg-bamboo-mist text-bamboo border-bamboo/35 font-medium"
                : "bg-paper-warm/70 text-ink-faint border-paper-deep/40 hover:text-ink-soft"
            }`}
          >
            &gt; {t("commandPalette.commandFilter", { defaultValue: "仅命令" })}
          </button>
        </div>

        <div ref={listRef} role="listbox" className="max-h-[360px] overflow-y-auto px-2 py-2">
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-ink-ghost">
              {t("commandPalette.empty", { defaultValue: "没有匹配的笔记或命令" })}
            </div>
          ) : (
            <div className="space-y-0.5">
              {items.map((item, index) => {
                const showSectionHeader = item.kind !== lastKind;
                lastKind = item.kind;
                const isSelected = index === activeIndex;
                const disabled = isPaletteItemDisabled(item);

                return (
                  <div key={item.id}>
                    {showSectionHeader && (
                      <div className="px-2.5 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-ink-ghost/80">
                        {sectionLabelFor(item.kind)}
                      </div>
                    )}
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={disabled || undefined}
                      disabled={disabled}
                      data-palette-index={index}
                      onMouseEnter={() => {
                        if (!disabled) setActiveIndex(index);
                      }}
                      onClick={() => executeItem(item)}
                      className={`w-full text-left px-3 py-2 rounded-xl flex items-start gap-2.5 transition-colors ${
                        disabled
                          ? "opacity-45 cursor-not-allowed"
                          : isSelected
                            ? "bg-bamboo-mist/75 text-bamboo cursor-pointer"
                            : "text-ink-soft hover:bg-paper-warm/70 cursor-pointer"
                      }`}
                    >
                      {item.kind === "note" ? (
                        <>
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="mt-0.5 shrink-0 opacity-65"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-display font-medium truncate">
                                {item.title}
                              </span>
                              {item.category && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded bg-paper-warm text-[10px] text-ink-faint">
                                  {item.category}
                                </span>
                              )}
                              {item.tags.slice(0, 2).map((tag) => (
                                <span
                                  key={tag}
                                  className="shrink-0 text-[10px] text-bamboo/75 font-mono"
                                >
                                  #{tag}
                                </span>
                              ))}
                            </div>
                            {item.snippet && (
                              <p className="mt-0.5 text-[11px] text-ink-ghost line-clamp-1">
                                {item.snippet}
                              </p>
                            )}
                          </div>
                        </>
                      ) : item.kind === "command" ? (
                        <>
                          <span className="mt-0.5 w-4 h-4 flex items-center justify-center rounded bg-paper-warm text-[10px] font-mono text-ink-faint shrink-0">
                            &gt;
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[13px] font-body font-medium truncate">
                                {item.command.label}
                              </span>
                              {item.command.shortcut && (
                                <span className="shrink-0 text-[10px] font-mono text-ink-ghost px-1.5 py-0.5 rounded bg-paper-warm/80 border border-paper-deep/30">
                                  {item.command.shortcut}
                                </span>
                              )}
                            </div>
                            {item.command.description && (
                              <p className="mt-0.5 text-[11px] text-ink-ghost truncate">
                                {item.command.description}
                              </p>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="mt-0.5 w-4 h-4 flex items-center justify-center rounded bg-bamboo/15 text-[12px] font-bold text-bamboo shrink-0">
                            +
                          </span>
                          <div className="min-w-0 flex-1">
                            <span className="text-[13px] font-body font-medium text-bamboo truncate block">
                              {t("commandPalette.createNote", {
                                title: item.title,
                                defaultValue: "创建笔记：{{title}}",
                              })}
                            </span>
                          </div>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-paper-deep/30 bg-paper/45 text-[10.5px] text-ink-ghost font-mono">
          <div className="flex items-center gap-3">
            <span>{t("commandPalette.footer.navigate", { defaultValue: "↑↓ 选择" })}</span>
            <span>·</span>
            <span>{t("commandPalette.footer.confirm", { defaultValue: "Enter 打开/执行" })}</span>
            <span>·</span>
            <span>{t("commandPalette.footer.close", { defaultValue: "Esc 关闭" })}</span>
          </div>
          {searchingFts && (
            <span className="text-bamboo/80">
              {t("commandPalette.searching", { defaultValue: "正在搜索正文…" })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
