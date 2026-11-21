import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { INBOX_CATEGORY } from "../features/notes/insights";

export interface BulkActionBarProps {
  selectedCount: number;
  categories: string[];
  busy?: boolean;
  initialConfirmDelete?: boolean;
  onMoveCategory: (targetCategory: string) => void | Promise<void>;
  onAddTags: (rawTags: string) => void | Promise<void>;
  onExportMarkdown: () => void | Promise<void>;
  onDeleteSelected: () => void | Promise<void>;
  onClearSelection: () => void;
  onExitMultiSelect: () => void;
}

export function BulkActionBar({
  selectedCount,
  categories,
  busy = false,
  initialConfirmDelete = false,
  onMoveCategory,
  onAddTags,
  onExportMarkdown,
  onDeleteSelected,
  onClearSelection,
  onExitMultiSelect,
}: BulkActionBarProps) {
  const { t } = useTranslation();
  const [targetCategory, setTargetCategory] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(initialConfirmDelete);

  const availableCategories = useMemo(
    () => categories.filter((category) => category !== INBOX_CATEGORY),
    [categories],
  );

  useEffect(() => {
    setConfirmingDelete(initialConfirmDelete);
  }, [initialConfirmDelete, selectedCount]);

  if (selectedCount < 1) return null;

  const submitTags = () => {
    if (!tagInput.trim() || busy) return;
    const raw = tagInput;
    setTagInput("");
    void onAddTags(raw);
  };

  return (
    <div
      data-testid="bulk-action-bar"
      role="region"
      aria-label={t("bulkActions.barLabel", { defaultValue: "批量管理操作栏" })}
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-2rem)] rounded-2xl bg-cloud/95 backdrop-blur-md border border-paper-deep/65 shadow-[0_14px_38px_var(--color-shadow-deep),0_4px_12px_var(--color-shadow)] px-3.5 py-2.5 flex flex-wrap items-center gap-2 animate-menu-enter"
    >
      <div className="flex items-center gap-1.5 pr-1 border-r border-paper-deep/35">
        <span className="px-2 py-0.5 rounded-full bg-bamboo-mist text-bamboo text-[11px] font-mono font-medium tabular-nums">
          {t("bulkActions.selectedCount", {
            count: selectedCount,
            defaultValue: "已选 {{count}} 项",
          })}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onClearSelection}
          className="px-2 h-7 rounded-lg text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
        >
          {t("bulkActions.clearSelection", { defaultValue: "清空" })}
        </button>
      </div>

      {/* 批量移动分类 */}
      <div className="flex items-center gap-1">
        <select
          value={targetCategory}
          onChange={(event) => setTargetCategory(event.target.value)}
          disabled={busy}
          aria-label={t("bulkActions.targetCategory", { defaultValue: "目标分类" })}
          className="h-7 max-w-[130px] px-2 rounded-lg border border-paper-deep/45 bg-paper-warm/70 text-[11px] text-ink-soft cursor-pointer disabled:opacity-40"
        >
          <option value="">{t("main.category.uncategorized", { defaultValue: "未分类" })}</option>
          {availableCategories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onMoveCategory(targetCategory)}
          className="h-7 px-2.5 rounded-lg border border-paper-deep/45 bg-paper-warm/70 text-[11px] text-ink-soft hover:text-bamboo hover:border-bamboo/40 hover:bg-bamboo-mist/50 transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap"
        >
          {t("bulkActions.move", { defaultValue: "移动分类" })}
        </button>
      </div>

      {/* 批量添加标签 */}
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={tagInput}
          onChange={(event) => setTagInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitTags();
            }
          }}
          disabled={busy}
          placeholder={t("bulkActions.tagsPlaceholder", {
            defaultValue: "标签（逗号分隔）",
          })}
          aria-label={t("bulkActions.tagsPlaceholder", {
            defaultValue: "标签（逗号分隔）",
          })}
          className="w-32 h-7 px-2 rounded-lg border border-paper-deep/45 bg-paper-warm/70 text-[11px] text-ink placeholder:text-ink-ghost/60 focus:border-bamboo/50"
        />
        <button
          type="button"
          disabled={busy || !tagInput.trim()}
          onClick={submitTags}
          className="h-7 px-2.5 rounded-lg border border-paper-deep/45 bg-paper-warm/70 text-[11px] text-ink-soft hover:text-bamboo hover:border-bamboo/40 hover:bg-bamboo-mist/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {t("bulkActions.addTags", { defaultValue: "添加标签" })}
        </button>
      </div>

      {/* 批量导出 Markdown */}
      <button
        type="button"
        disabled={busy}
        onClick={() => void onExportMarkdown()}
        className="h-7 px-2.5 rounded-lg border border-paper-deep/45 bg-paper-warm/70 text-[11px] text-ink-soft hover:text-bamboo hover:border-bamboo/40 hover:bg-bamboo-mist/50 transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap"
      >
        {t("bulkActions.exportMarkdown", { defaultValue: "导出 Markdown" })}
      </button>

      {/* 批量删除（带二次确认） */}
      {confirmingDelete ? (
        <div className="flex items-center gap-1 pl-1 border-l border-paper-deep/35">
          <span className="text-[11px] text-red-400 whitespace-nowrap">
            {t("bulkActions.confirmDelete", {
              count: selectedCount,
              defaultValue: "确认删除 {{count}} 篇？",
            })}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirmingDelete(false);
              void onDeleteSelected();
            }}
            className="h-7 px-2.5 rounded-lg bg-red-400 hover:bg-red-500 text-cloud text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap"
          >
            {t("bulkActions.confirmDeleteAction", { defaultValue: "确认删除" })}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingDelete(false)}
            className="h-7 px-2 rounded-lg text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
          >
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmingDelete(true)}
          className="h-7 px-2.5 rounded-lg border border-red-400/40 text-[11px] text-red-400 hover:bg-danger-bg transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap"
        >
          {t("bulkActions.delete", { defaultValue: "删除所选" })}
        </button>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={onExitMultiSelect}
        title={t("bulkActions.exitMode", { defaultValue: "退出多选" })}
        aria-label={t("bulkActions.exitMode", { defaultValue: "退出多选" })}
        className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
      >
        <svg
          width="12"
          height="12"
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
  );
}
