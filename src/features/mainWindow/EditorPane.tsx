import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { TFunction } from "i18next";
import {
  WikiLinkAutocomplete,
  useWikiLinkAutocomplete,
} from "../../components/WikiLinkAutocomplete";
import { MarkdownPreviewLazy as MarkdownPreview } from "../markdown/MarkdownPreviewLazy";
import type { OutlineHeading } from "../markdown/outlineUtils";
import {
  buildHighlightSegments,
  findMatches,
  MAX_HIGHLIGHT_MATCHES,
  type FindHighlightState,
} from "../notes/findReplace";
import type { ExternalFile, NoteMetadata } from "../notes/types";
import { findWikiLinkAtOffset } from "../notes/wikiLinks";
import type { ViewMode } from "../settings/types";
import { applyFormat, type ToolbarButtonConfig } from "./editorFormatting";
import { FindReplaceBar, OutlinePanel } from "./lazyPanels";

type CssHighlightConstructor = new (...ranges: AbstractRange[]) => unknown;
type CssHighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => boolean;
};

interface EditorPaneProps {
  t: TFunction;
  effectiveViewMode: ViewMode;
  splitContainerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  previewScrollRef: RefObject<HTMLDivElement | null>;
  selectedId: string | null;
  isLoading: boolean;
  isExternal: boolean;
  notes: NoteMetadata[];
  focusMode: boolean;
  settingsOpen: boolean;
  aboutOpen: boolean;
  splitRatio: number;
  isResizingSplit: boolean;
  onStartResizeSplit: () => void;
  toolbarButtons: ToolbarButtonConfig[];
  content: string;
  deferredContent: string;
  contentValueRef: MutableRefObject<string>;
  onContentChange: (nextContent: string) => void;
  setContent: (value: string) => void;
  markDirty: () => void;
  fontSize: number;
  allowRawHtml: boolean;
  imageBaseDir: string | null;
  externalImageBaseDir: string | null;
  selectedExternalFile: ExternalFile | null;
  outlineOpen: boolean;
  headings: OutlineHeading[];
  onToggleOutline: () => void;
  onCloseOutline: () => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop: (event: DragEvent<HTMLTextAreaElement>) => void;
  onDragOver: (event: DragEvent<HTMLTextAreaElement>) => void;
  onEditorScroll: () => void;
  onPreviewScroll: () => void;
  onOpenWikiLink: (target: string) => void;
  findOpen: boolean;
  findShowReplace: boolean;
  findFocusSignal: number;
  onToggleFindReplace: () => void;
  onCloseFind: () => void;
}

export function EditorPane({
  t,
  effectiveViewMode,
  splitContainerRef,
  contentRef,
  previewScrollRef,
  selectedId,
  isLoading,
  isExternal,
  notes,
  focusMode,
  settingsOpen,
  aboutOpen,
  splitRatio,
  isResizingSplit,
  onStartResizeSplit,
  toolbarButtons,
  content,
  deferredContent,
  contentValueRef,
  onContentChange,
  setContent,
  markDirty,
  fontSize,
  allowRawHtml,
  imageBaseDir,
  externalImageBaseDir,
  selectedExternalFile,
  outlineOpen,
  headings,
  onToggleOutline,
  onCloseOutline,
  onPaste,
  onDrop,
  onDragOver,
  onEditorScroll,
  onPreviewScroll,
  onOpenWikiLink,
  findOpen,
  findShowReplace,
  findFocusSignal,
  onToggleFindReplace,
  onCloseFind,
}: EditorPaneProps) {
  const wikiCompletion = useWikiLinkAutocomplete({
    content,
    notes,
    activeNoteId: isExternal ? null : selectedId,
    textareaRef: contentRef,
    setContent,
    markDirty,
    disabled: !selectedId || effectiveViewMode === "preview",
    t,
  });

  const [findHighlight, setFindHighlight] = useState<FindHighlightState | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!findOpen || !selectedId) {
      setFindHighlight(null);
    }
  }, [findOpen, selectedId]);

  const showEditorHighlight = Boolean(
    findOpen && findHighlight && findHighlight.matches.length > 0,
  );

  const highlightSegments = useMemo(
    () =>
      showEditorHighlight && findHighlight
        ? buildHighlightSegments(content, findHighlight.matches, findHighlight.activeIndex)
        : [],
    [content, findHighlight, showEditorHighlight],
  );

  const syncBackdropLayout = useCallback(() => {
    const textarea = contentRef.current;
    const backdrop = backdropRef.current;
    if (!textarea || !backdrop) return;
    backdrop.style.width = `${textarea.clientWidth}px`;
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  }, [contentRef]);

  useLayoutEffect(() => {
    if (!showEditorHighlight) return;
    syncBackdropLayout();
    const textarea = contentRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncBackdropLayout);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [
    content,
    contentRef,
    effectiveViewMode,
    fontSize,
    showEditorHighlight,
    splitRatio,
    syncBackdropLayout,
  ]);

  useEffect(() => {
    const cssRegistry =
      typeof CSS !== "undefined"
        ? (CSS as typeof CSS & { highlights?: CssHighlightRegistry }).highlights
        : undefined;
    const HighlightCtor =
      typeof globalThis !== "undefined"
        ? (globalThis as typeof globalThis & { Highlight?: CssHighlightConstructor }).Highlight
        : undefined;
    if (!cssRegistry || !HighlightCtor) return;

    const previewEl = previewScrollRef.current;
    if (
      !findOpen ||
      !findHighlight ||
      !findHighlight.query ||
      findHighlight.matches.length === 0 ||
      !previewEl ||
      effectiveViewMode === "edit"
    ) {
      cssRegistry.delete("floral-find-match");
      return;
    }

    const ranges: Range[] = [];
    const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) !== null && ranges.length < MAX_HIGHLIGHT_MATCHES) {
      const textNode = node as Text;
      if (!textNode.data) continue;
      const result = findMatches(textNode.data, findHighlight.query, {
        caseSensitive: findHighlight.caseSensitive,
        regex: findHighlight.regex,
      });
      if (result.error || result.matches.length === 0) continue;
      for (const m of result.matches) {
        if (ranges.length >= MAX_HIGHLIGHT_MATCHES) break;
        const range = document.createRange();
        range.setStart(textNode, m.start);
        range.setEnd(textNode, m.end);
        ranges.push(range);
      }
    }

    if (ranges.length > 0) {
      cssRegistry.set("floral-find-match", new HighlightCtor(...ranges));
    } else {
      cssRegistry.delete("floral-find-match");
    }

    return () => {
      cssRegistry.delete("floral-find-match");
    };
  }, [deferredContent, effectiveViewMode, findHighlight, findOpen, previewScrollRef]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {findOpen && selectedId && (
        <Suspense fallback={null}>
          <FindReplaceBar
            open={findOpen}
            showReplace={findShowReplace}
            content={content}
            contentRef={contentRef}
            focusSignal={findFocusSignal}
            onToggleShowReplace={onToggleFindReplace}
            onContentChange={onContentChange}
            onHighlightChange={setFindHighlight}
            onClose={onCloseFind}
          />
        </Suspense>
      )}
      <div
        key={effectiveViewMode}
        ref={splitContainerRef}
        className="flex-1 flex min-h-0 animate-view-fade"
      >
        {!selectedId && !isLoading ? (
          <div className="flex-1 flex items-center justify-center text-[13px] text-ink-ghost">
            {t("main.editor.emptyHint", { defaultValue: "选择或新建一篇笔记" })}
          </div>
        ) : (
          <>
            {(effectiveViewMode === "edit" || effectiveViewMode === "split") && (
              <div
                className="flex flex-col min-h-0 shrink-0"
                style={{
                  width: effectiveViewMode === "split" ? `${splitRatio * 100}%` : "100%",
                }}
              >
                <div
                  className={`flex items-center gap-0.5 px-4 pt-2 pb-1 shrink-0 ${focusMode || settingsOpen || aboutOpen ? "hidden" : ""}`}
                >
                  {toolbarButtons.map((button) => (
                    <button
                      key={button.label}
                      title={button.title}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (contentRef.current) {
                          applyFormat(contentRef.current, button.action, t, setContent, markDirty);
                        }
                      }}
                      className={`w-6 h-6 flex items-center justify-center rounded text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer ${button.style}`}
                    >
                      {button.label}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-hidden px-5 pb-4">
                  <div
                    className="relative w-full h-full"
                    style={{ maxWidth: "var(--editor-max-width)", margin: "0 auto" }}
                  >
                    {showEditorHighlight && (
                      <div
                        ref={backdropRef}
                        aria-hidden="true"
                        data-testid="editor-find-backdrop"
                        className="absolute inset-y-0 left-0 pointer-events-none overflow-hidden p-0 m-0 border-0 font-body text-transparent whitespace-pre-wrap break-words"
                        style={{
                          fontSize: `${fontSize}px`,
                          tabSize: `var(--tab-indent-size, 2)`,
                          fontFamily: `var(--editor-font-family)`,
                          lineHeight: `var(--editor-line-height)`,
                        }}
                      >
                        {highlightSegments.map((segment, index) =>
                          segment.isMatch ? (
                            <mark
                              key={index}
                              className={
                                segment.isActive ? "find-highlight-active" : "find-highlight-match"
                              }
                            >
                              {segment.text}
                            </mark>
                          ) : (
                            segment.text
                          ),
                        )}
                        {content.endsWith("\n") ? "\n" : null}
                      </div>
                    )}
                    <textarea
                      ref={contentRef}
                      data-tab-indent={wikiCompletion.isOpen ? "false" : "true"}
                      value={content}
                      onChange={(event) => {
                        onContentChange(event.target.value);
                        wikiCompletion.syncCursorFromElement(event.target);
                      }}
                      onKeyDown={(event) => {
                        wikiCompletion.handleKeyDown(event);
                      }}
                      onKeyUp={(event) => wikiCompletion.syncCursorFromElement(event.currentTarget)}
                      onClick={(event) => {
                        wikiCompletion.syncCursorFromElement(event.currentTarget);
                        if (
                          (event.ctrlKey || event.metaKey) &&
                          event.currentTarget.selectionStart === event.currentTarget.selectionEnd
                        ) {
                          const hit = findWikiLinkAtOffset(
                            event.currentTarget.value,
                            event.currentTarget.selectionStart,
                          );
                          if (hit) {
                            event.preventDefault();
                            onOpenWikiLink(hit.target);
                          }
                        }
                      }}
                      onSelect={(event) =>
                        wikiCompletion.syncCursorFromElement(event.currentTarget)
                      }
                      onCompositionStart={wikiCompletion.handleCompositionStart}
                      onCompositionEnd={(event) =>
                        wikiCompletion.handleCompositionEnd(event.currentTarget)
                      }
                      onBlur={wikiCompletion.handleBlur}
                      onPaste={onPaste}
                      onDrop={onDrop}
                      onDragOver={onDragOver}
                      onScroll={(event) => {
                        if (backdropRef.current) {
                          backdropRef.current.scrollTop = event.currentTarget.scrollTop;
                          backdropRef.current.scrollLeft = event.currentTarget.scrollLeft;
                        }
                        onEditorScroll();
                      }}
                      className="relative z-[1] block w-full h-full p-0 m-0 border-0 text-ink-soft font-body placeholder:text-ink-ghost/40 editor-textarea"
                      style={{
                        fontSize: `${fontSize}px`,
                        tabSize: `var(--tab-indent-size, 2)`,
                        fontFamily: `var(--editor-font-family)`,
                        lineHeight: `var(--editor-line-height)`,
                      }}
                      placeholder={t("main.editor.contentPlaceholder", {
                        defaultValue: "开始写作……",
                      })}
                      spellCheck={false}
                      disabled={!selectedId}
                    />
                  </div>
                  <WikiLinkAutocomplete
                    open={wikiCompletion.isOpen}
                    trigger={wikiCompletion.trigger}
                    candidates={wikiCompletion.candidates}
                    activeIndex={wikiCompletion.activeIndex}
                    textareaRef={contentRef}
                    onHoverIndex={wikiCompletion.setActiveIndex}
                    onSelect={wikiCompletion.selectCandidate}
                    t={t}
                  />
                </div>
              </div>
            )}

            {effectiveViewMode === "split" && (
              <div
                className={`w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center ${isResizingSplit ? "bg-bamboo/30" : "hover:bg-bamboo/20"} transition-colors`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onStartResizeSplit();
                }}
              >
                <div
                  className={`absolute inset-y-0 -left-1.5 -right-1.5 ${isResizingSplit ? "" : "group-hover:bg-bamboo/5"}`}
                />
                {/* 拖拽手柄指示器 */}
                <div className="relative z-10 flex flex-col gap-[3px] opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                  <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                  <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                </div>
              </div>
            )}

            {(effectiveViewMode === "preview" || effectiveViewMode === "split") && (
              <div className="flex flex-col min-h-0 min-w-0 flex-1">
                {(effectiveViewMode === "split" || (outlineOpen && headings.length > 0)) && (
                  <div className="px-4 pt-2.5 pb-1 shrink-0 flex items-center justify-between">
                    <span className="text-[10px] text-ink-ghost/60 font-mono tracking-widest uppercase">
                      {t("main.editor.previewLabel", { defaultValue: "Preview" })}
                    </span>
                    {outlineOpen && headings.length > 0 && (
                      <button
                        type="button"
                        onClick={onToggleOutline}
                        className={`text-[10px] font-mono transition-colors cursor-pointer ${
                          outlineOpen ? "text-bamboo" : "text-ink-ghost/50 hover:text-ink-ghost"
                        }`}
                        title={outlineOpen ? "隐藏目录" : "显示目录"}
                      >
                        {outlineOpen ? "目录 ▸" : "目录"}
                      </button>
                    )}
                  </div>
                )}
                <div
                  ref={previewScrollRef}
                  onScroll={onPreviewScroll}
                  className={`flex-1 overflow-y-auto px-6 pb-6 ${
                    effectiveViewMode === "preview" ? "pt-3" : "pt-1"
                  }`}
                >
                  <MarkdownPreview
                    content={deferredContent}
                    onContentChange={
                      selectedId
                        ? (nextContent) => {
                            // 仅拦截过期预览的写入，不切换整组复选框的 disabled 状态，
                            // 避免延迟预览追上正文之前出现闪烁和键盘焦点丢失。
                            if (contentValueRef.current !== deferredContent) return;
                            contentValueRef.current = nextContent;
                            setContent(nextContent);
                            markDirty();
                          }
                        : undefined
                    }
                    fontSize={fontSize}
                    renderHtml={allowRawHtml}
                    imageBaseDir={isExternal ? undefined : (imageBaseDir ?? undefined)}
                    externalImageBaseDir={
                      isExternal ? (externalImageBaseDir ?? undefined) : undefined
                    }
                    externalFilePath={selectedExternalFile?.filePath}
                    onOpenWikiLink={onOpenWikiLink}
                  />
                </div>
              </div>
            )}
            {outlineOpen && headings.length > 0 && effectiveViewMode !== "edit" && (
              <Suspense fallback={null}>
                <OutlinePanel
                  headings={headings}
                  previewScrollRef={previewScrollRef}
                  onClose={onCloseOutline}
                />
              </Suspense>
            )}
          </>
        )}
      </div>
    </div>
  );
}
