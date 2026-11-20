import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { emit, listen } from "@tauri-apps/api/event";
import { createNote, getErrorMessage, openDailyNote, updateNote } from "../features/notes/api";
import { INBOX_CATEGORY } from "../features/notes/insights";
import type { Note } from "../features/notes/types";
import { reportInstallPreparation } from "../features/update/api";
import type { UpdateInstallPrepareRequest } from "../features/update/types";
import { hideQuickCaptureWindow } from "../features/windows/api";
import { showCurrentWindow, startCurrentWindowDrag } from "../features/windows/controls";

export type QuickCaptureTarget = "inbox" | "daily";

export interface QuickCaptureProps {
  initialTarget?: QuickCaptureTarget;
  initialText?: string;
  initialError?: string | null;
}

export function toggleCaptureTarget(current: QuickCaptureTarget): QuickCaptureTarget {
  return current === "inbox" ? "daily" : "inbox";
}

export function formatDailyTimestampedEntry(text: string, now: Date = new Date()): string {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return "";
  const [first, ...rest] = lines;
  const formattedRest = rest.map((line) => (line.length > 0 ? `  ${line}` : "  "));
  return [`- **${hours}:${minutes}** ${first}`, ...formattedRest].join("\n");
}

export function appendEntryToDailyNoteContent(existingContent: string, entry: string): string {
  if (!entry) return existingContent;
  if (!existingContent.trim()) {
    return `${entry}\n`;
  }
  const separator = existingContent.endsWith("\n") ? "" : "\n";
  return `${existingContent}${separator}${entry}\n`;
}

export function isImeComposingEvent(
  event: { nativeEvent?: { isComposing?: boolean }; keyCode?: number },
  composingFlag: boolean,
): boolean {
  return Boolean(composingFlag || event.nativeEvent?.isComposing || event.keyCode === 229);
}

export interface QuickCaptureSubmitDeps {
  createNote: typeof createNote;
  openDailyNote: typeof openDailyNote;
  updateNote: typeof updateNote;
  emitNotesChanged: () => Promise<void>;
}

const defaultSubmitDeps: QuickCaptureSubmitDeps = {
  createNote,
  openDailyNote,
  updateNote,
  emitNotesChanged: () => emit("notes-changed"),
};

export async function submitQuickCapture(
  {
    text,
    target,
    now = new Date(),
  }: {
    text: string;
    target: QuickCaptureTarget;
    now?: Date;
  },
  deps: QuickCaptureSubmitDeps = defaultSubmitDeps,
): Promise<Note> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("EMPTY_CAPTURE");
  }

  let savedNote: Note;
  if (target === "inbox") {
    savedNote = await deps.createNote({
      title: "",
      content: trimmed,
      category: INBOX_CATEGORY,
      tags: [],
      pinned: false,
    });
  } else {
    const daily = await deps.openDailyNote();
    const entry = formatDailyTimestampedEntry(trimmed, now);
    const nextContent = appendEntryToDailyNoteContent(daily.content, entry);
    savedNote = await deps.updateNote(daily.id, {
      title: daily.title,
      content: nextContent,
      category: daily.category,
      tags: daily.tags,
      pinned: daily.pinned,
    });
  }

  await deps.emitNotesChanged().catch(() => undefined);
  return savedNote;
}

export interface QuickCaptureKeyActionHandlers {
  isComposing: boolean;
  onSubmit: () => void;
  onToggleTarget: () => void;
  onClose: () => void;
}

export interface QuickCaptureKeyEvent {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  preventDefault: () => void;
}

export function handleQuickCaptureKeyDown(
  event: QuickCaptureKeyEvent,
  handlers: QuickCaptureKeyActionHandlers,
): boolean {
  if (isImeComposingEvent(event, handlers.isComposing)) {
    return false;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    handlers.onToggleTarget();
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    handlers.onClose();
    return true;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handlers.onSubmit();
    return true;
  }

  return false;
}

export function QuickCapture({
  initialTarget = "inbox",
  initialText = "",
  initialError = null,
}: QuickCaptureProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<QuickCaptureTarget>(initialTarget);
  const [text, setText] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const submittingRef = useRef(false);

  const focusInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        void showCurrentWindow()
          .then(() => {
            if (!cancelled) focusInput();
          })
          .catch(() => {
            if (!cancelled) focusInput();
          });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [focusInput]);

  useEffect(() => {
    const handleWindowFocus = () => {
      focusInput();
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [focusInput]);

  useEffect(() => {
    const unlistenOpened = listen("quick-capture-opened", () => {
      setError(null);
      focusInput();
      requestAnimationFrame(() => focusInput());
    });
    const unlistenPrepare = listen<UpdateInstallPrepareRequest>(
      "update://prepare-install",
      (event) => {
        void reportInstallPreparation(event.payload.requestId, "quick-capture", "ready").catch(
          () => undefined,
        );
      },
    );

    return () => {
      void unlistenOpened.then((fn) => fn());
      void unlistenPrepare.then((fn) => fn());
    };
  }, [focusInput]);

  const handleClose = useCallback(() => {
    setError(null);
    void hideQuickCaptureWindow().catch(() => undefined);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    if (!text.trim()) {
      setError(t("quickCapture.error.empty", { defaultValue: "请输入内容后再保存" }));
      focusInput();
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await submitQuickCapture({ text, target });
      setText("");
      setError(null);
      await hideQuickCaptureWindow().catch(() => undefined);
    } catch (err) {
      setError(getErrorMessage(err, t));
      focusInput();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [focusInput, t, target, text]);

  const handleHeaderMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button,input,textarea")) return;
    void startCurrentWindowDrag().catch(() => undefined);
  };

  return (
    <div className="w-full h-screen bg-transparent p-2 flex flex-col">
      <div className="app-surface-frame noise-bg relative flex-1 min-h-0 flex flex-col bg-cloud/95 backdrop-blur-md border border-paper-deep/75 shadow-[0_12px_32px_var(--color-shadow-deep),0_2px_8px_var(--color-shadow)] overflow-hidden">
        <div
          onMouseDown={handleHeaderMouseDown}
          className="flex items-center justify-between gap-2 px-3.5 pt-2.5 pb-1.5 border-b border-paper-deep/35 shrink-0 select-none cursor-default"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-bamboo shrink-0" />
            <span className="text-[12px] font-display font-medium text-ink-soft truncate">
              {t("quickCapture.title", { defaultValue: "快速捕获" })}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <div
              role="tablist"
              aria-label={t("quickCapture.target.switchHint", { defaultValue: "Tab 切换" })}
              className="inline-flex items-center rounded-lg bg-paper-warm/90 p-0.5 border border-paper-deep/40"
            >
              <button
                type="button"
                role="tab"
                aria-selected={target === "inbox"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setTarget("inbox");
                  focusInput();
                }}
                className={`px-2.5 py-0.5 rounded-md text-[11px] font-body transition-all cursor-pointer ${
                  target === "inbox"
                    ? "bg-cloud text-bamboo font-medium shadow-xs"
                    : "text-ink-faint hover:text-ink-soft"
                }`}
              >
                {t("quickCapture.target.inbox", { defaultValue: "收件箱" })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={target === "daily"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setTarget("daily");
                  focusInput();
                }}
                className={`px-2.5 py-0.5 rounded-md text-[11px] font-body transition-all cursor-pointer ${
                  target === "daily"
                    ? "bg-cloud text-bamboo font-medium shadow-xs"
                    : "text-ink-faint hover:text-ink-soft"
                }`}
              >
                {t("quickCapture.target.daily", { defaultValue: "每日便笺" })}
              </button>
            </div>

            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleClose}
              title={t("quickCapture.action.close", { defaultValue: "关闭 (Esc)" })}
              aria-label={t("quickCapture.action.close", { defaultValue: "关闭 (Esc)" })}
              className="w-6 h-6 flex items-center justify-center rounded-md text-ink-ghost hover:text-red-400 hover:bg-danger-bg transition-colors cursor-pointer"
            >
              <svg
                width="11"
                height="11"
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
        </div>

        <div className="flex-1 min-h-0 px-3.5 py-2 flex flex-col">
          <textarea
            ref={textareaRef}
            autoFocus
            value={text}
            disabled={submitting}
            onChange={(event) => {
              setText(event.target.value);
              if (error) setError(null);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={(event) => {
              handleQuickCaptureKeyDown(event, {
                isComposing: isComposingRef.current,
                onSubmit: () => void handleSubmit(),
                onToggleTarget: () => setTarget(toggleCaptureTarget),
                onClose: handleClose,
              });
            }}
            placeholder={t("quickCapture.placeholder", {
              defaultValue: "记下这一刻的想法… (Enter 保存，Shift+Enter 换行)",
            })}
            spellCheck={false}
            className="w-full flex-1 min-h-0 text-[13.5px] leading-relaxed text-ink font-body placeholder:text-ink-ghost/60 bg-transparent"
          />
        </div>

        <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-t border-paper-deep/30 bg-paper/45 shrink-0">
          <div className="min-w-0 flex-1">
            {error ? (
              <p role="alert" className="text-[11px] font-body text-red-500 truncate">
                {error}
              </p>
            ) : (
              <div className="flex items-center gap-2.5 text-[10.5px] text-ink-ghost font-mono truncate">
                <span>{t("quickCapture.target.switchHint", { defaultValue: "Tab 切换" })}</span>
                <span>·</span>
                <span>{t("quickCapture.hint.submit", { defaultValue: "Enter 保存" })}</span>
                <span>·</span>
                <span>{t("quickCapture.hint.newline", { defaultValue: "Shift+Enter 换行" })}</span>
                <span>·</span>
                <span>{t("quickCapture.hint.close", { defaultValue: "Esc 隐藏" })}</span>
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={submitting}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void handleSubmit()}
            className="px-3 py-1 rounded-lg text-[11.5px] font-medium text-cloud bg-bamboo hover:bg-bamboo-light disabled:opacity-50 transition-colors cursor-pointer shrink-0"
          >
            {submitting
              ? t("quickCapture.action.saving", { defaultValue: "保存中…" })
              : t("quickCapture.action.submit", { defaultValue: "保存" })}
          </button>
        </div>
      </div>
    </div>
  );
}
