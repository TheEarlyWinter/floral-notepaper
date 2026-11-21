import {
  Suspense,
  type ClipboardEvent,
  type DragEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { TFunction } from "i18next";
import { MarkdownPreviewLazy as MarkdownPreview } from "../markdown/MarkdownPreviewLazy";
import type { OutlineHeading } from "../markdown/outlineUtils";
import type { ExternalFile } from "../notes/types";
import type { ViewMode } from "../settings/types";
import { applyFormat, type ToolbarButtonConfig } from "./editorFormatting";
import { FindReplaceBar, OutlinePanel } from "./lazyPanels";

interface EditorPaneProps {
  t: TFunction;
  effectiveViewMode: ViewMode;
  splitContainerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  previewScrollRef: RefObject<HTMLDivElement | null>;
  selectedId: string | null;
  isLoading: boolean;
  isExternal: boolean;
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
                  <textarea
                    ref={contentRef}
                    data-tab-indent="true"
                    value={content}
                    onChange={(event) => onContentChange(event.target.value)}
                    onPaste={onPaste}
                    onDrop={onDrop}
                    onDragOver={onDragOver}
                    onScroll={onEditorScroll}
                    className="w-full h-full text-ink-soft font-body placeholder:text-ink-ghost/40 editor-textarea"
                    style={{
                      fontSize: `${fontSize}px`,
                      tabSize: `var(--tab-indent-size, 2)`,
                      fontFamily: `var(--editor-font-family)`,
                      lineHeight: `var(--editor-line-height)`,
                      maxWidth: `var(--editor-max-width)`,
                      margin: "0 auto",
                    }}
                    placeholder={t("main.editor.contentPlaceholder", {
                      defaultValue: "开始写作……",
                    })}
                    spellCheck={false}
                    disabled={!selectedId}
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
