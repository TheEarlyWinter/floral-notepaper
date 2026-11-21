import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage, getRelatedNotes } from "../features/notes/api";
import type { NoteMetadata, RelatedNoteSuggestion } from "../features/notes/types";

export interface RelatedNotesSectionProps {
  noteId: string;
  notes?: NoteMetadata[];
  onOpenNote: (noteId: string) => void;
  onInsertLink?: (suggestion: RelatedNoteSuggestion) => void;
  fetchRelatedNotes?: (noteId: string, limit?: number) => Promise<RelatedNoteSuggestion[]>;
  limit?: number;
  initialSuggestions?: RelatedNoteSuggestion[];
}

export function formatRelatedScorePercent(score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(100, Math.round(score * 100)));
}

export function RelatedNotesSection({
  noteId,
  notes,
  onOpenNote,
  onInsertLink,
  fetchRelatedNotes = getRelatedNotes,
  limit = 5,
  initialSuggestions,
}: RelatedNotesSectionProps) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<RelatedNoteSuggestion[]>(
    () => initialSuggestions ?? [],
  );
  const [loading, setLoading] = useState(initialSuggestions === undefined);
  const [error, setError] = useState<string | null>(null);
  const [insertedIds, setInsertedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setInsertedIds(new Set());
  }, [noteId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    return fetchRelatedNotes(noteId, limit);
  }, [fetchRelatedNotes, limit, noteId]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void load()
        .then((items) => {
          if (!active) return;
          setSuggestions(items);
          setInsertedIds(new Set());
          setLoading(false);
        })
        .catch((reason) => {
          if (!active) return;
          setError(getErrorMessage(reason, t));
          setLoading(false);
        });
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, notes, t]);

  const handleInsertClick = (suggestion: RelatedNoteSuggestion) => {
    onInsertLink?.(suggestion);
    setInsertedIds((current) => {
      const next = new Set(current);
      next.add(suggestion.id);
      return next;
    });
  };

  return (
    <section
      aria-label={t("relatedNotes.title", { defaultValue: "相关笔记" })}
      data-testid="related-notes-section"
      className="pt-4 border-t border-paper-deep/25"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2 px-0.5">
        <div>
          <h3 className="text-[12px] font-display font-medium text-ink-soft">
            {t("relatedNotes.title", { defaultValue: "相关笔记" })}
          </h3>
          <p className="text-[10px] text-ink-ghost mt-0.5">
            {t("relatedNotes.subtitle", { defaultValue: "基于本地词频与标签推荐" })}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="py-5 text-center text-[12px] text-ink-ghost">
          {t("relatedNotes.loading", { defaultValue: "正在分析本地关联…" })}
        </div>
      ) : error ? (
        <div className="py-5 text-center text-[12px] text-red-400">{error}</div>
      ) : suggestions.length === 0 ? (
        <div className="py-5 text-center text-[12px] text-ink-ghost leading-relaxed">
          {t("relatedNotes.empty", { defaultValue: "暂无高相关度的本地笔记" })}
        </div>
      ) : (
        <div className="space-y-2">
          {suggestions.map((suggestion) => {
            const percent = formatRelatedScorePercent(suggestion.score);
            const isLinked = suggestion.alreadyLinked || insertedIds.has(suggestion.id);
            const displayTitle =
              suggestion.title.trim() || t("common.untitledNote", { defaultValue: "无标题笔记" });

            return (
              <div
                key={suggestion.id}
                data-related-note-id={suggestion.id}
                className="rounded-lg border border-paper-deep/25 bg-paper-warm/35 px-3 py-2.5 hover:bg-bamboo-mist/35 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenNote(suggestion.id)}
                    className="min-w-0 flex-1 text-left cursor-pointer group"
                  >
                    <p className="text-[12px] font-medium text-ink-soft group-hover:text-bamboo truncate transition-colors">
                      {displayTitle}
                    </p>
                    <div className="mt-1 flex items-center flex-wrap gap-1.5 text-[10px] text-ink-ghost">
                      {suggestion.category && (
                        <span className="px-1.5 py-0.5 rounded bg-paper-deep/35 text-ink-faint">
                          {suggestion.category}
                        </span>
                      )}
                      <span className="font-mono text-bamboo/85">
                        {t("relatedNotes.score", {
                          percent,
                          defaultValue: "相关度 {{percent}}%",
                        })}
                      </span>
                    </div>
                  </button>

                  {isLinked ? (
                    <span className="shrink-0 px-2 py-0.5 rounded-md bg-bamboo-mist/70 text-[10px] text-bamboo font-medium">
                      {t("relatedNotes.linked", { defaultValue: "已关联" })}
                    </span>
                  ) : onInsertLink ? (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleInsertClick(suggestion)}
                      className="shrink-0 px-2 py-1 rounded-md border border-bamboo/30 bg-cloud/80 hover:bg-bamboo-mist text-[10.5px] text-bamboo font-medium transition-colors cursor-pointer"
                    >
                      {t("relatedNotes.insertLink", { defaultValue: "插入链接" })}
                    </button>
                  ) : null}
                </div>

                {suggestion.matchedTerms.length > 0 && (
                  <div
                    className="mt-2 flex items-center flex-wrap gap-1"
                    aria-label={t("relatedNotes.matchedTermsLabel", {
                      defaultValue: "匹配词",
                    })}
                  >
                    {suggestion.matchedTerms.map((term) => (
                      <span
                        key={term}
                        className="px-1.5 py-0.5 rounded bg-cloud/80 border border-paper-deep/25 text-[10px] text-ink-faint font-mono"
                      >
                        {term}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
