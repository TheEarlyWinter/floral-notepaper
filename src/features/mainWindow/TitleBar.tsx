import type { MouseEvent } from "react";
import type { TFunction } from "i18next";
import type { AboutUpdateReminderState } from "../update/presentation";

interface TitleBarProps {
  t: TFunction;
  isMacOS: boolean;
  isMaximized: boolean;
  noteTitle: string;
  aboutUpdateReminder: AboutUpdateReminderState;
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  onOpenNotepad: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}

export function TitleBar({
  t,
  isMacOS,
  isMaximized,
  noteTitle,
  aboutUpdateReminder,
  onMouseDown,
  onOpenNotepad,
  onOpenSettings,
  onOpenAbout,
  onMinimize,
  onMaximize,
  onClose,
}: TitleBarProps) {
  const aboutButtonLabel = t("settings.update.title", { defaultValue: "更新" });
  const aboutButtonExpanded = aboutUpdateReminder.showText;
  const aboutButtonTitle = aboutUpdateReminder.hasPendingUpdate
    ? aboutButtonLabel
    : t("main.window.about", { defaultValue: "关于" });

  return (
    <div
      className={`relative z-10 flex items-center justify-between h-11 bg-paper/55 backdrop-blur-[1px] border-b border-paper-deep/30 shrink-0 select-none cursor-default ${
        isMacOS ? "pl-20 pr-5" : "pl-5 pr-0"
      }`}
      onMouseDown={onMouseDown}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-[15px] font-serif font-medium text-ink-soft tracking-wide leading-none">
          花笺
        </span>
        <span className="text-[11px] text-ink-ghost font-body leading-none translate-y-px">—</span>
        <span className="text-[11px] text-ink-faint font-body truncate max-w-[240px] leading-none translate-y-px">
          {noteTitle}
        </span>
      </div>
      <div className="flex items-center">
        <button
          onClick={onOpenNotepad}
          className="w-10 h-11 flex items-center justify-center text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer"
          title={t("main.window.quickNotepad", { defaultValue: "快捷便签" })}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 4h16v14H7l-3 3V4z" />
            <path d="M8 9h8M8 13h5" />
          </svg>
        </button>
        <button
          onClick={onOpenSettings}
          className="w-10 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer"
          title={t("main.window.settings", { defaultValue: "设置" })}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          onClick={onOpenAbout}
          className={`h-11 flex items-center justify-center overflow-hidden text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-[width,padding,gap,background-color,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] cursor-pointer ${
            aboutButtonExpanded ? "w-[72px] gap-1.5 px-3" : "w-10 gap-0 px-0"
          }`}
          title={aboutButtonTitle}
          aria-label={aboutButtonTitle}
        >
          {aboutUpdateReminder.hasPendingUpdate ? (
            <svg
              data-testid="main-about-update-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16V8" />
              <path d="m8.5 11.5 3.5-3.5 3.5 3.5" />
            </svg>
          ) : (
            <svg
              data-testid="main-about-info-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
          )}
          {aboutUpdateReminder.hasPendingUpdate ? (
            <span
              data-testid="main-about-update-label"
              className={`overflow-hidden whitespace-nowrap text-[11px] font-body leading-none transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                aboutButtonExpanded
                  ? "max-w-[24px] translate-x-0 opacity-100"
                  : "max-w-0 translate-x-1 opacity-0"
              }`}
            >
              {aboutButtonLabel}
            </span>
          ) : null}
        </button>

        {!isMacOS && (
          <>
            <div className="w-px h-4 bg-paper-deep/30 mx-0.5" />

            <button
              onClick={onMinimize}
              className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
              title={t("main.window.minimize", { defaultValue: "最小化" })}
            >
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="1" y="5.5" width="10" height="1" fill="currentColor" rx="0.5" />
              </svg>
            </button>
            <button
              onClick={onMaximize}
              className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
              title={
                isMaximized
                  ? t("main.window.restore", { defaultValue: "还原" })
                  : t("main.window.maximize", { defaultValue: "最大化" })
              }
            >
              {isMaximized ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                >
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <path d="M3 5H2V2a1 1 0 0 1 1-1h5v1" />
                </svg>
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                >
                  <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
                </svg>
              )}
            </button>
            <button
              onClick={onClose}
              className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-red-500 hover:bg-danger-bg transition-all cursor-pointer"
              title={t("main.window.close", { defaultValue: "关闭" })}
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
          </>
        )}
      </div>
    </div>
  );
}
