import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { getDisplayTitle } from "../features/notes/noteUtils";
import type { NoteMetadata } from "../features/notes/types";
import {
  detectWikiLinkTrigger,
  filterWikiLinkCandidates,
  formatWikiLinkCompletion,
  handleWikiLinkKeyDown,
  insertWikiLinkCompletion,
  type WikiLinkTrigger,
} from "../features/notes/wikiLinkCompletion";
import { POPUP_VIEWPORT_MARGIN } from "./popupPosition";

interface CaretAnchor {
  x: number;
  lineTop: number;
  lineBottom: number;
}

function measureTextareaCaretAnchor(
  textarea: HTMLTextAreaElement,
  offset: number,
): CaretAnchor | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  const rect = textarea.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }

  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  const copyProps = [
    "boxSizing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "textTransform",
    "wordSpacing",
    "tabSize",
  ] as const;

  mirror.style.position = "fixed";
  mirror.style.top = "-9999px";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflowWrap = "break-word";
  for (const prop of copyProps) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.width = `${textarea.clientWidth}px`;

  mirror.textContent = textarea.value.slice(0, offset);
  const marker = document.createElement("span");
  marker.textContent = "[[";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const fontSize = parseFloat(style.fontSize) || 14;
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.6;
  const x = rect.left + marker.offsetLeft - textarea.scrollLeft;
  const lineTop = rect.top + marker.offsetTop - textarea.scrollTop;
  const lineBottom = lineTop + lineHeight + 4;

  mirror.remove();

  return { x, lineTop, lineBottom };
}

export interface UseWikiLinkAutocompleteOptions {
  content: string;
  notes: NoteMetadata[];
  activeNoteId?: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setContent: (value: string) => void;
  markDirty: () => void;
  disabled?: boolean;
  t?: TFunction;
}

export function useWikiLinkAutocomplete({
  content,
  notes,
  activeNoteId,
  textareaRef,
  setContent,
  markDirty,
  disabled = false,
  t,
}: UseWikiLinkAutocompleteOptions) {
  const [cursorPos, setCursorPos] = useState<{ start: number; end: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAtOffset, setDismissedAtOffset] = useState<number | null>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    setCursorPos(null);
    setDismissedAtOffset(null);
    setActiveIndex(0);
  }, [activeNoteId]);

  const trigger = useMemo(() => {
    if (disabled || !cursorPos) {
      return null;
    }
    return detectWikiLinkTrigger(content, cursorPos.start, cursorPos.end);
  }, [content, cursorPos, disabled]);

  useEffect(() => {
    if (dismissedAtOffset !== null && (!trigger || trigger.startOffset !== dismissedAtOffset)) {
      setDismissedAtOffset(null);
    }
  }, [dismissedAtOffset, trigger]);

  const isOpen = Boolean(trigger && trigger.startOffset !== dismissedAtOffset);

  const candidates = useMemo(() => {
    if (!isOpen || !trigger) {
      return [];
    }
    return filterWikiLinkCandidates(notes, trigger.query, activeNoteId);
  }, [activeNoteId, isOpen, notes, trigger]);

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.startOffset, trigger?.query, candidates.length]);

  const syncCursorFromElement = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (disabled || !element) {
        setCursorPos((current) => (current === null ? current : null));
        return;
      }
      const start = element.selectionStart ?? 0;
      const end = element.selectionEnd ?? 0;
      setCursorPos((current) =>
        current && current.start === start && current.end === end ? current : { start, end },
      );
    },
    [disabled],
  );

  const dismiss = useCallback(() => {
    if (trigger) {
      setDismissedAtOffset(trigger.startOffset);
    }
  }, [trigger]);

  const selectCandidate = useCallback(
    (note: NoteMetadata) => {
      const textarea = textareaRef.current;
      if (!textarea || !trigger) {
        return;
      }
      const nextValue = insertWikiLinkCompletion(textarea, trigger, note, setContent, markDirty, t);
      const nextOffset = Math.min(
        nextValue.length,
        trigger.startOffset + formatWikiLinkCompletion(note, t).length,
      );
      setCursorPos({
        start: textarea.selectionStart ?? nextOffset,
        end: textarea.selectionEnd ?? nextOffset,
      });
      setDismissedAtOffset(null);
      setActiveIndex(0);
    },
    [markDirty, setContent, t, textareaRef, trigger],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      return handleWikiLinkKeyDown(event, {
        isOpen,
        candidateCount: candidates.length,
        isComposing: isComposingRef.current,
        onMove: (delta) => {
          setActiveIndex((current) => {
            if (candidates.length === 0) return 0;
            return (current + delta + candidates.length) % candidates.length;
          });
        },
        onSelectActive: () => {
          const target = candidates[activeIndex] ?? candidates[0];
          if (target) {
            selectCandidate(target);
          }
        },
        onDismiss: dismiss,
      });
    },
    [activeIndex, candidates, dismiss, isOpen, selectCandidate],
  );

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (element: HTMLTextAreaElement | null) => {
      isComposingRef.current = false;
      syncCursorFromElement(element);
    },
    [syncCursorFromElement],
  );

  const handleBlur = useCallback(() => {
    setCursorPos(null);
  }, []);

  return {
    isOpen,
    trigger,
    candidates,
    activeIndex,
    setActiveIndex,
    selectCandidate,
    dismiss,
    syncCursorFromElement,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
    handleBlur,
  };
}

export interface WikiLinkAutocompleteProps {
  open: boolean;
  trigger: WikiLinkTrigger | null;
  candidates: NoteMetadata[];
  activeIndex: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onHoverIndex: (index: number) => void;
  onSelect: (note: NoteMetadata) => void;
  t?: TFunction;
}

export function WikiLinkAutocomplete({
  open,
  trigger,
  candidates,
  activeIndex,
  textareaRef,
  onHoverIndex,
  onSelect,
  t: providedT,
}: WikiLinkAutocompleteProps) {
  const { t: hookT } = useTranslation();
  const t = providedT ?? hookT;
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !trigger) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const textarea = textareaRef.current;
      const popup = popupRef.current;
      if (!textarea) return;

      const anchor = measureTextareaCaretAnchor(textarea, trigger.startOffset);
      if (!anchor) {
        const rect = textarea.getBoundingClientRect();
        setPosition({
          left: Math.max(POPUP_VIEWPORT_MARGIN, rect.left),
          top: Math.max(POPUP_VIEWPORT_MARGIN, rect.top + 28),
        });
        return;
      }

      const popupWidth = popup?.offsetWidth || 260;
      const popupHeight = popup?.offsetHeight || 200;
      const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
      const vh = typeof window !== "undefined" ? window.innerHeight : 768;

      const maxLeft = Math.max(POPUP_VIEWPORT_MARGIN, vw - popupWidth - POPUP_VIEWPORT_MARGIN);
      const left = Math.min(Math.max(anchor.x, POPUP_VIEWPORT_MARGIN), maxLeft);

      const fitsBelow = anchor.lineBottom + popupHeight <= vh - POPUP_VIEWPORT_MARGIN;
      const preferredTop = fitsBelow ? anchor.lineBottom : anchor.lineTop - popupHeight - 4;
      const maxTop = Math.max(POPUP_VIEWPORT_MARGIN, vh - popupHeight - POPUP_VIEWPORT_MARGIN);
      const top = Math.min(Math.max(preferredTop, POPUP_VIEWPORT_MARGIN), maxTop);

      setPosition((current) =>
        current && current.left === left && current.top === top ? current : { left, top },
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !popupRef.current
        ? null
        : new ResizeObserver(updatePosition);
    if (popupRef.current) {
      resizeObserver?.observe(popupRef.current);
    }

    return () => {
      window.removeEventListener("resize", updatePosition);
      resizeObserver?.disconnect();
    };
  }, [open, textareaRef, trigger, candidates.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const option = listRef.current?.querySelector<HTMLElement>(
      `[data-wiki-option-index="${activeIndex}"]`,
    );
    option?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open || !trigger) {
    return null;
  }

  return (
    <div
      ref={popupRef}
      role="listbox"
      aria-label={t("wikiAutocomplete.listboxLabel", { defaultValue: "关联笔记补全列表" })}
      data-testid="wiki-link-autocomplete"
      style={
        position
          ? { left: `${position.left}px`, top: `${position.top}px` }
          : { left: "16px", top: "48px" }
      }
      className="fixed z-[9980] w-[280px] max-w-[calc(100vw-16px)] rounded-xl border border-paper-deep/70 bg-cloud/96 backdrop-blur-md shadow-[0_12px_32px_var(--color-shadow-deep),0_2px_8px_var(--color-shadow)] overflow-hidden flex flex-col"
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-paper-deep/25 bg-paper/45">
        <span className="text-[10px] font-mono text-ink-ghost tracking-wide">
          {t("wikiAutocomplete.header", { defaultValue: "插入笔记链接" })}
        </span>
        {trigger.query && (
          <span className="text-[10px] font-mono text-bamboo truncate max-w-[140px]">
            {trigger.query}
          </span>
        )}
      </div>

      <div ref={listRef} className="max-h-[210px] overflow-y-auto p-1">
        {candidates.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11.5px] text-ink-ghost">
            {t("wikiAutocomplete.empty", { defaultValue: "没有匹配的笔记" })}
          </div>
        ) : (
          <div className="space-y-0.5">
            {candidates.map((note, index) => {
              const selected = index === activeIndex;
              return (
                <button
                  key={note.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-wiki-option-index={index}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onHoverIndex(index)}
                  onClick={() => onSelect(note)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                    selected
                      ? "bg-bamboo-mist/85 text-bamboo"
                      : "text-ink-soft hover:bg-paper-warm/70"
                  }`}
                >
                  <span className="text-[12.5px] font-body font-medium truncate">
                    {getDisplayTitle(note, t)}
                  </span>
                  {note.category && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded bg-paper-warm text-[10px] text-ink-ghost max-w-[90px] truncate">
                      {note.category}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-1 border-t border-paper-deep/25 bg-paper/35 text-[10px] text-ink-ghost font-mono">
        <span>{t("wikiAutocomplete.footer.navigate", { defaultValue: "↑↓ 选择" })}</span>
        <span>·</span>
        <span>{t("wikiAutocomplete.footer.confirm", { defaultValue: "Enter / Tab 插入" })}</span>
        <span>·</span>
        <span>{t("wikiAutocomplete.footer.close", { defaultValue: "Esc 关闭" })}</span>
      </div>
    </div>
  );
}
