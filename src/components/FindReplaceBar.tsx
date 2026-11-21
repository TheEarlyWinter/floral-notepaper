import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  findInitialMatchIndex,
  findMatches,
  replaceAllMatches,
  replaceMatchAt,
  selectAndScrollTextareaMatch,
  stepMatchIndex,
} from "../features/notes/findReplace";

export interface FindReplaceBarProps {
  open: boolean;
  showReplace: boolean;
  content: string;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  focusSignal: number;
  initialQuery?: string;
  onToggleShowReplace: () => void;
  onContentChange: (nextContent: string) => void;
  onClose: () => void;
}

export interface FindInputKeyEvent {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export function handleFindInputKeyDown(
  event: FindInputKeyEvent,
  handlers: {
    isComposing: boolean;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
  },
): boolean {
  const composing = Boolean(
    handlers.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229,
  );
  if (composing) return false;

  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) {
      handlers.onPrev();
    } else {
      handlers.onNext();
    }
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation?.();
    handlers.onClose();
    return true;
  }

  return false;
}

export function handleReplaceInputKeyDown(
  event: FindInputKeyEvent,
  handlers: {
    isComposing: boolean;
    onReplaceCurrent: () => void;
    onClose: () => void;
  },
): boolean {
  const composing = Boolean(
    handlers.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229,
  );
  if (composing) return false;

  if (event.key === "Enter") {
    event.preventDefault();
    handlers.onReplaceCurrent();
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation?.();
    handlers.onClose();
    return true;
  }

  return false;
}

export function FindReplaceBar({
  open,
  showReplace,
  content,
  contentRef,
  focusSignal,
  initialQuery = "",
  onToggleShowReplace,
  onContentChange,
  onClose,
}: FindReplaceBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const latestContentRef = useRef(content);
  latestContentRef.current = content;
  const pendingPostReplaceSelectRef = useRef<{
    start: number;
    end: number;
    text: string;
  } | null>(null);

  const findResult = useMemo(
    () => findMatches(content, query, { caseSensitive, regex }),
    [caseSensitive, content, query, regex],
  );
  const matches = findResult.matches;
  const regexError = findResult.error;

  const displayIndex = matches.length > 0 && activeIndex >= 0 ? activeIndex + 1 : 0;

  // Focus input and optionally seed query from editor selection when opened or re-triggered.
  useEffect(() => {
    if (!open) return;
    const textarea = contentRef.current;
    if (textarea && typeof document !== "undefined" && document.activeElement === textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (end > start) {
        const selected = textarea.value.slice(start, end);
        if (!selected.includes("\n") && selected.length <= 200) {
          setQuery(selected);
        }
      }
    }

    requestAnimationFrame(() => {
      if (showReplace && query && document.activeElement === findInputRef.current) {
        replaceInputRef.current?.focus();
        replaceInputRef.current?.select();
      } else {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusSignal]);

  // Re-evaluate initial match and highlight it in the textarea when search query/flags change.
  useEffect(() => {
    if (!open) return;
    const currentContent = latestContentRef.current;
    const result = findMatches(currentContent, query, { caseSensitive, regex });
    if (result.error || result.matches.length === 0) {
      setActiveIndex(-1);
      return;
    }
    const cursorOffset = contentRef.current?.selectionStart ?? 0;
    const nextIdx = findInitialMatchIndex(result.matches, cursorOffset);
    setActiveIndex(nextIdx);
    selectAndScrollTextareaMatch(contentRef.current, result.matches[nextIdx]);
  }, [caseSensitive, contentRef, open, query, regex]);

  // Keep activeIndex in bounds if note content changes while the bar is open.
  useEffect(() => {
    if (!open) return;
    if (matches.length === 0) {
      if (activeIndex !== -1) setActiveIndex(-1);
      return;
    }
    if (activeIndex < 0 || activeIndex >= matches.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, matches.length, open]);

  // Apply deferred textarea selection after React commits replaced content.
  useEffect(() => {
    const pending = pendingPostReplaceSelectRef.current;
    if (!pending) return;
    pendingPostReplaceSelectRef.current = null;
    requestAnimationFrame(() => {
      selectAndScrollTextareaMatch(contentRef.current, pending);
    });
  }, [content, contentRef]);

  const navigateMatch = useCallback(
    (direction: 1 | -1) => {
      if (regexError || matches.length === 0) return;
      const nextIdx = stepMatchIndex(activeIndex, matches.length, direction);
      setActiveIndex(nextIdx);
      selectAndScrollTextareaMatch(contentRef.current, matches[nextIdx]);
    },
    [activeIndex, contentRef, matches, regexError],
  );

  const handleReplaceCurrent = useCallback(() => {
    if (regexError || matches.length === 0) return;
    const idx = activeIndex >= 0 && activeIndex < matches.length ? activeIndex : 0;
    const replaced = replaceMatchAt(content, matches, idx, query, replacement, {
      caseSensitive,
      regex,
    });
    if (!replaced.replaced) return;

    const afterResult = findMatches(replaced.nextContent, query, { caseSensitive, regex });
    if (!afterResult.error && afterResult.matches.length > 0) {
      const nextIdx = findInitialMatchIndex(afterResult.matches, replaced.replacedEndOffset);
      setActiveIndex(nextIdx);
      pendingPostReplaceSelectRef.current = afterResult.matches[nextIdx];
    } else {
      setActiveIndex(-1);
    }
    onContentChange(replaced.nextContent);
  }, [
    activeIndex,
    caseSensitive,
    content,
    matches,
    onContentChange,
    query,
    regex,
    regexError,
    replacement,
  ]);

  const handleReplaceAll = useCallback(() => {
    if (regexError || matches.length === 0) return;
    const result = replaceAllMatches(content, query, replacement, {
      caseSensitive,
      regex,
    });
    if (result.error || result.count === 0) return;
    setActiveIndex(-1);
    onContentChange(result.nextContent);
  }, [
    caseSensitive,
    content,
    matches.length,
    onContentChange,
    query,
    regex,
    regexError,
    replacement,
  ]);

  if (!open) return null;

  return (
    <div
      data-testid="find-replace-bar"
      role="region"
      aria-label={t("findReplace.regionLabel", { defaultValue: "查找与替换" })}
      className="px-4 py-2 border-b border-paper-deep/25 bg-paper/65 backdrop-blur-sm shrink-0 flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={onToggleShowReplace}
          aria-expanded={showReplace}
          aria-label={t("findReplace.toggleReplace", { defaultValue: "展开或收起替换" })}
          title={t("findReplace.toggleReplace", { defaultValue: "展开或收起替换" })}
          className="w-6 h-6 flex items-center justify-center rounded-md text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer shrink-0"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-150 ${showReplace ? "rotate-90" : ""}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <div
          className={`flex items-center flex-1 min-w-[180px] max-w-[340px] h-7 px-2 rounded-lg bg-cloud/90 border transition-colors ${
            regexError
              ? "border-red-400/70 focus-within:border-red-400"
              : "border-paper-deep/45 focus-within:border-bamboo/50"
          }`}
        >
          <input
            ref={findInputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={(event) => {
              handleFindInputKeyDown(event, {
                isComposing: isComposingRef.current,
                onNext: () => navigateMatch(1),
                onPrev: () => navigateMatch(-1),
                onClose,
              });
            }}
            placeholder={t("findReplace.findPlaceholder", { defaultValue: "查找…" })}
            aria-label={t("findReplace.findPlaceholder", { defaultValue: "查找…" })}
            spellCheck={false}
            className="flex-1 min-w-0 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
          />
          {query && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery("");
                findInputRef.current?.focus();
              }}
              aria-label={t("findReplace.clearFind", { defaultValue: "清空查找" })}
              title={t("findReplace.clearFind", { defaultValue: "清空查找" })}
              className="w-4 h-4 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft cursor-pointer shrink-0"
            >
              <svg
                width="10"
                height="10"
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
        </div>

        <button
          type="button"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((prev) => !prev)}
          title={t("findReplace.caseSensitive", { defaultValue: "区分大小写" })}
          aria-label={t("findReplace.caseSensitive", { defaultValue: "区分大小写" })}
          className={`h-7 px-2 rounded-md text-[11px] font-mono border transition-colors cursor-pointer shrink-0 ${
            caseSensitive
              ? "bg-bamboo-mist text-bamboo border-bamboo/40 font-semibold"
              : "bg-paper-warm/70 text-ink-faint border-paper-deep/40 hover:text-ink-soft"
          }`}
        >
          Aa
        </button>

        <button
          type="button"
          aria-pressed={regex}
          onClick={() => setRegex((prev) => !prev)}
          title={t("findReplace.regex", { defaultValue: "正则表达式" })}
          aria-label={t("findReplace.regex", { defaultValue: "正则表达式" })}
          className={`h-7 px-2 rounded-md text-[11px] font-mono border transition-colors cursor-pointer shrink-0 ${
            regex
              ? "bg-bamboo-mist text-bamboo border-bamboo/40 font-semibold"
              : "bg-paper-warm/70 text-ink-faint border-paper-deep/40 hover:text-ink-soft"
          }`}
        >
          .*
        </button>

        <span
          data-testid="find-match-counter"
          className={`min-w-[46px] text-center text-[11px] font-mono tabular-nums px-1 ${
            regexError || (query && matches.length === 0) ? "text-red-400" : "text-ink-faint"
          }`}
        >
          {`${displayIndex} / ${matches.length}`}
        </span>

        <button
          type="button"
          onClick={() => navigateMatch(-1)}
          disabled={matches.length === 0 || Boolean(regexError)}
          title={t("findReplace.previous", { defaultValue: "上一个 (Shift+Enter)" })}
          aria-label={t("findReplace.previous", { defaultValue: "上一个 (Shift+Enter)" })}
          className="w-7 h-7 flex items-center justify-center rounded-md text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed shrink-0"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => navigateMatch(1)}
          disabled={matches.length === 0 || Boolean(regexError)}
          title={t("findReplace.next", { defaultValue: "下一个 (Enter)" })}
          aria-label={t("findReplace.next", { defaultValue: "下一个 (Enter)" })}
          className="w-7 h-7 flex items-center justify-center rounded-md text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed shrink-0"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onClose}
          title={t("findReplace.close", { defaultValue: "关闭 (Esc)" })}
          aria-label={t("findReplace.close", { defaultValue: "关闭 (Esc)" })}
          className="ml-auto w-7 h-7 flex items-center justify-center rounded-md text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer shrink-0"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {regexError && (
        <div role="alert" className="pl-7 text-[11px] text-red-400 font-body">
          {t("findReplace.invalidRegex", { defaultValue: "正则表达式无效" })}: {regexError}
        </div>
      )}

      {showReplace && (
        <div className="flex items-center gap-1.5 pl-7 flex-wrap">
          <div className="flex items-center flex-1 min-w-[180px] max-w-[340px] h-7 px-2 rounded-lg bg-cloud/90 border border-paper-deep/45 focus-within:border-bamboo/50 transition-colors">
            <input
              ref={replaceInputRef}
              type="text"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onKeyDown={(event) => {
                handleReplaceInputKeyDown(event, {
                  isComposing: isComposingRef.current,
                  onReplaceCurrent: handleReplaceCurrent,
                  onClose,
                });
              }}
              placeholder={t("findReplace.replacePlaceholder", { defaultValue: "替换为…" })}
              aria-label={t("findReplace.replacePlaceholder", { defaultValue: "替换为…" })}
              spellCheck={false}
              className="flex-1 min-w-0 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
            />
          </div>

          <button
            type="button"
            onClick={handleReplaceCurrent}
            disabled={matches.length === 0 || Boolean(regexError)}
            className="h-7 px-2.5 rounded-md border border-paper-deep/45 bg-paper-warm/70 text-[11px] text-ink-soft hover:text-bamboo hover:border-bamboo/40 hover:bg-bamboo-mist/50 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed shrink-0"
          >
            {t("findReplace.replace", { defaultValue: "替换" })}
          </button>

          <button
            type="button"
            onClick={handleReplaceAll}
            disabled={matches.length === 0 || Boolean(regexError)}
            className="h-7 px-2.5 rounded-md border border-paper-deep/45 bg-paper-warm/70 text-[11px] text-ink-soft hover:text-bamboo hover:border-bamboo/40 hover:bg-bamboo-mist/50 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed shrink-0"
          >
            {t("findReplace.replaceAll", { defaultValue: "全部替换" })}
          </button>
        </div>
      )}
    </div>
  );
}
