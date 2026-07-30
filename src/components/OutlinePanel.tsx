import { useCallback, useEffect, useRef, useState } from "react";
import type { OutlineHeading } from "../features/markdown/outlineUtils";

interface OutlinePanelProps {
  headings: OutlineHeading[];
  previewScrollRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

const MAX_INDENT = 4;

/** 根据当前滚动位置高亮对应的标题 */
function useActiveHeading(
  headings: OutlineHeading[],
  scrollContainer: HTMLElement | null,
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  // 序列化完整 id 列表，避免用逗号拼接时发生边界碰撞。
  const headingIds = JSON.stringify(headings.map((heading) => heading.id).filter(Boolean));

  useEffect(() => {
    if (!scrollContainer || headings.length === 0) return;

    const handleScroll = () => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const threshold = containerRect.top + 80;
      let currentId: string | null = null;

      for (let i = headings.length - 1; i >= 0; i--) {
        const heading = headings[i];
        if (!heading.id) continue;
        const el = document.getElementById(heading.id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= threshold) {
            currentId = heading.id;
            break;
          }
        }
      }

      setActiveId(currentId);
    };

    handleScroll(); // 初始化
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollContainer, headingIds]);

  return activeId;
}

export function OutlinePanel({ headings, previewScrollRef, onClose }: OutlinePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainer = previewScrollRef?.current ?? null;
  const activeId = useActiveHeading(headings, scrollContainer);

  const handleClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      // center 避免预览区顶部工具栏把目标标题盖住。
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  // 自动滚动大纲面板，让激活项可见
  useEffect(() => {
    if (!activeId || !containerRef.current) return;
    const activeEl = containerRef.current.querySelector(`[data-outline-id="${activeId}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeId]);

  const hasHeadings = headings.length > 0;

  return (
    <aside className="w-[260px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between h-11 px-4 border-b border-paper-deep/25">
        <div>
          <h2 className="text-[13px] font-display font-medium text-ink-soft">目录</h2>
          <p className="text-[10px] text-ink-ghost mt-0.5">
            {hasHeadings ? `${headings.length} 个标题` : "暂无标题"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭大纲"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      {/* Outline tree */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-2 py-2">
        {!hasHeadings ? (
          <div className="py-8 text-center text-[12px] text-ink-ghost leading-relaxed">
            这篇笔记还没有标题。
            <br />
            试试用 <code className="px-1 py-0.5 bg-paper-warm rounded text-[11px]">
              # 一级标题
            </code>{" "}
            来组织内容。
          </div>
        ) : (
          <div className="space-y-0.5">
            {headings.map((heading) => {
              const indent = Math.min(heading.level - 1, MAX_INDENT);
              const isActive = heading.id === activeId;

              return (
                <button
                  key={heading.id}
                  data-outline-id={heading.id}
                  type="button"
                  onClick={() => handleClick(heading.id)}
                  className={`relative w-full text-left rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed transition-colors cursor-pointer truncate ${
                    isActive
                      ? "bg-bamboo/12 text-bamboo font-medium"
                      : "text-ink-soft hover:bg-paper-warm/80 hover:text-ink"
                  }`}
                  style={{ paddingLeft: `${12 + indent * 14}px` }}
                  title={heading.text}
                >
                  {/* 激活指示条 */}
                  {isActive && (
                    <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-bamboo rounded-r-full" />
                  )}
                  {heading.text}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
