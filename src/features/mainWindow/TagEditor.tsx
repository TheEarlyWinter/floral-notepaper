import { useState } from "react";

interface TagEditorProps {
  tags: string[];
  onChange: (tags: string[]) => void;
}

export function TagEditor({ tags, onChange }: TagEditorProps) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const tag = input.trim();
    if (!tag || tags.includes(tag)) {
      setInput("");
      return;
    }
    onChange([...tags, tag]);
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bamboo-mist/60 border border-bamboo/20 text-[10px] text-bamboo"
        >
          #{tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="w-3 h-3 flex items-center justify-center rounded-full hover:bg-bamboo/20 transition-colors cursor-pointer"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </span>
      ))}
      <div className="inline-flex items-center gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")) {
              e.preventDefault();
              // 不 stopPropagation：Ctrl+S 加标签的同时，事件继续冒泡触发全局保存
              addTag();
            }
            if (e.key === "Backspace" && !input && tags.length > 0)
              removeTag(tags[tags.length - 1]);
          }}
          onBlur={addTag}
          placeholder="添加标签…"
          className="w-20 h-5 px-1.5 rounded text-[10px] font-body text-ink-soft placeholder:text-ink-ghost bg-transparent border border-transparent focus:border-paper-deep/40 focus:bg-paper-warm/50 outline-none transition-colors"
        />
      </div>
    </div>
  );
}
