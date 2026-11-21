import type { RefObject } from "react";
import type { TFunction } from "i18next";
import { formatShortDate, formatTime } from "../notes/noteUtils";
import type { ExternalFile, NoteMetadata } from "../notes/types";
import { TagEditor } from "./TagEditor";
import type { SaveState } from "./types";

interface NoteHeaderProps {
  t: TFunction;
  noteTransitionKey: number;
  focusMode: boolean;
  title: string;
  selectedId: string | null;
  isExternal: boolean;
  noteTags: string[];
  selectedExternalFile: ExternalFile | null;
  selectedNote: NoteMetadata | null;
  charCount: number;
  saveState: SaveState;
  saveStateLabel: Record<SaveState, string>;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  onTitleChange: (title: string) => void;
  onTagsChange: (tags: string[]) => void;
}

export function NoteHeader({
  t,
  noteTransitionKey,
  focusMode,
  title,
  selectedId,
  isExternal,
  noteTags,
  selectedExternalFile,
  selectedNote,
  charCount,
  saveState,
  saveStateLabel,
  contentRef,
  onTitleChange,
  onTagsChange,
}: NoteHeaderProps) {
  return (
    <div
      key={noteTransitionKey}
      className={`animate-note-enter px-6 pt-4 pb-2 shrink-0 border-b border-paper-deep/15 ${focusMode ? "hidden" : ""}`}
    >
      <input
        type="text"
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            contentRef.current?.focus();
          }
        }}
        placeholder={t("common.untitledNote", { defaultValue: "无标题笔记" })}
        disabled={!selectedId}
        className="w-full text-[20px] font-display font-bold text-ink placeholder:text-ink-ghost/50 tracking-wide disabled:opacity-60"
      />
      {/* 标签编辑 */}
      {!isExternal && selectedId && <TagEditor tags={noteTags} onChange={onTagsChange} />}
      <div className="flex items-center gap-3 mt-1.5">
        <span className="text-[10px] text-ink-ghost font-mono tabular-nums truncate max-w-[200px]">
          {selectedExternalFile
            ? t("main.externalFile.label", {
                path: selectedExternalFile.filePath,
                defaultValue: "外部文件 · {{path}}",
              })
            : selectedNote
              ? `${formatShortDate(selectedNote.updatedAt)} ${formatTime(selectedNote.updatedAt)}`
              : "--"}
        </span>
        <span className="text-[10px] text-ink-ghost/40">·</span>
        <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
          {t("common.wordCount", { count: charCount, defaultValue: "{{count}} 字" })}
        </span>
        <span className="text-[10px] text-ink-ghost/40">·</span>
        <span
          key={saveState}
          className={`text-[10px] font-mono tabular-nums animate-status-fade ${
            saveState === "error"
              ? "text-red-400"
              : saveState === "dirty"
                ? "text-amber-500/70"
                : "text-bamboo/60"
          }`}
        >
          {saveStateLabel[saveState]}
        </span>
      </div>
    </div>
  );
}
