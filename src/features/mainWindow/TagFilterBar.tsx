import { useMemo } from "react";
import { collectAllTags } from "../notes/noteUtils";
import type { NoteMetadata } from "../notes/types";

interface TagFilterBarProps {
  notes: NoteMetadata[];
  selectedTag: string;
  open: boolean;
  onToggle: () => void;
  onSelectTag: (tag: string) => void;
}

export function TagFilterBar({
  notes,
  selectedTag,
  open,
  onToggle,
  onSelectTag,
}: TagFilterBarProps) {
  const allTags = useMemo(() => collectAllTags(notes), [notes]);

  if (allTags.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        className={`w-full h-7 flex items-center gap-2 px-2.5 rounded-lg text-[11px] font-body transition-colors cursor-pointer ${
          open || selectedTag
            ? "bg-bamboo-mist/45 text-bamboo"
            : "text-ink-faint hover:text-bamboo hover:bg-paper-warm/70"
        }`}
        aria-expanded={open}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <path d="M20.59 13.41 11.41 22.59a2 2 0 0 1-2.82 0L1.41 15.41A2 2 0 0 1 .83 14V4a2 2 0 0 1 2-2h10a2 2 0 0 1 1.41.59l7.18 7.18a2 2 0 0 1 0 2.82Z" />
          <circle cx="7" cy="7" r="1" />
        </svg>
        <span className="flex-1 text-left">标签</span>
        {selectedTag ? (
          <span className="max-w-[90px] truncate rounded-full bg-bamboo/10 px-1.5 py-0.5 text-[10px]">
            #{selectedTag}
          </span>
        ) : (
          <span className="text-[10px] text-ink-ghost">{allTags.length}</span>
        )}
      </button>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1 ml-4 border-l border-paper-deep/50 pl-2 py-1 space-y-0.5">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onSelectTag(tag)}
                className={`w-full flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-body transition-colors cursor-pointer ${
                  selectedTag === tag
                    ? "bg-bamboo-mist text-bamboo"
                    : "text-ink-faint hover:text-bamboo hover:bg-paper-warm/70"
                }`}
              >
                <span className="text-ink-ghost">#</span>
                <span className="truncate">{tag}</span>
              </button>
            ))}
            {selectedTag && (
              <button
                type="button"
                onClick={() => onSelectTag("")}
                className="w-full rounded-md px-2 py-1 text-left text-[10px] text-red-400 hover:bg-danger-bg transition-colors cursor-pointer"
              >
                清除标签筛选
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
