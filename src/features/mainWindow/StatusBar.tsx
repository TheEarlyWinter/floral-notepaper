import type { TFunction } from "i18next";

interface StatusBarProps {
  t: TFunction;
  focusMode: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lineCount: number;
  byteSize: string;
  showCleanUnusedImages: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onCleanUnusedImages: () => void;
}

export function StatusBar({
  t,
  focusMode,
  canGoBack,
  canGoForward,
  lineCount,
  byteSize,
  showCleanUnusedImages,
  onGoBack,
  onGoForward,
  onCleanUnusedImages,
}: StatusBarProps) {
  return (
    <div
      className={`flex items-center justify-between px-4 h-7 border-t border-paper-deep/20 bg-paper/30 shrink-0 ${focusMode ? "hidden" : ""}`}
    >
      <div className="flex items-center gap-3">
        {canGoBack && (
          <button
            type="button"
            onClick={onGoBack}
            className="p-0.5 rounded text-ink-ghost hover:text-ink hover:bg-paper-warm transition-colors cursor-pointer"
            title="后退 (Alt+←)"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7.5 2.5L4 6l3.5 3.5" />
            </svg>
          </button>
        )}
        {canGoForward && (
          <button
            type="button"
            onClick={onGoForward}
            className="p-0.5 rounded text-ink-ghost hover:text-ink hover:bg-paper-warm transition-colors cursor-pointer"
            title="前进 (Alt+→)"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.5 2.5L8 6l-3.5 3.5" />
            </svg>
          </button>
        )}
        {(canGoBack || canGoForward) && <span className="text-[10px] text-ink-ghost/30">|</span>}
        <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
          {t("main.statusBar.lineNumber", {
            count: lineCount,
            defaultValue: "Ln {{count}}",
          })}
        </span>
        <span className="text-[10px] text-ink-ghost/40">|</span>
        <span className="text-[10px] text-ink-ghost font-mono">
          {t("main.statusBar.format", { defaultValue: "Markdown + LaTeX" })}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {showCleanUnusedImages && (
          <>
            <button
              type="button"
              onClick={onCleanUnusedImages}
              className="text-[10px] text-ink-ghost hover:text-bamboo font-mono cursor-pointer transition-colors"
            >
              {t("main.images.cleanUnused", { defaultValue: "清理未使用图片" })}
            </button>
            <span className="text-[10px] text-ink-ghost/40">|</span>
          </>
        )}
        <span className="text-[10px] text-ink-ghost font-mono">
          {t("main.statusBar.encoding", { defaultValue: "UTF-8" })}
        </span>
        <span className="text-[10px] text-ink-ghost/40">|</span>
        <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
          {t("main.statusBar.byteSize", { size: byteSize, defaultValue: "{{size}} KB" })}
        </span>
      </div>
    </div>
  );
}
