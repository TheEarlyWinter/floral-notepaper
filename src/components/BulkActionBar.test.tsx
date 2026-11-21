import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";
import { i18n } from "../locales";
import { BulkActionBar } from "./BulkActionBar";

describe("BulkActionBar", () => {
  test("hides when zero notes are selected and renders actions when >= 1 selected", () => {
    const emptyMarkup = renderToStaticMarkup(
      <BulkActionBar
        selectedCount={0}
        categories={["工作", "收件箱"]}
        onMoveCategory={vi.fn()}
        onAddTags={vi.fn()}
        onExportMarkdown={vi.fn()}
        onDeleteSelected={vi.fn()}
        onClearSelection={vi.fn()}
        onExitMultiSelect={vi.fn()}
      />,
    );
    expect(emptyMarkup).toBe("");

    const markup = renderToStaticMarkup(
      <BulkActionBar
        selectedCount={3}
        categories={["工作", "学习", "收件箱"]}
        onMoveCategory={vi.fn()}
        onAddTags={vi.fn()}
        onExportMarkdown={vi.fn()}
        onDeleteSelected={vi.fn()}
        onClearSelection={vi.fn()}
        onExitMultiSelect={vi.fn()}
      />,
    );

    expect(markup).toContain("bulk-action-bar");
    expect(markup).toContain("已选 3 项");
    expect(markup).toContain("未分类");
    expect(markup).toContain("工作");
    expect(markup).toContain("学习");
    expect(markup).not.toContain("收件箱");
    expect(markup).toContain("添加标签");
    expect(markup).toContain("导出 Markdown");
    expect(markup).toContain("删除所选");
  });

  test("renders delete confirmation state and localized labels", async () => {
    const en = i18n.cloneInstance({ lng: "en-US" });
    await en.changeLanguage("en-US");

    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={en}>
        <BulkActionBar
          selectedCount={2}
          categories={["Work"]}
          initialConfirmDelete={true}
          onMoveCategory={vi.fn()}
          onAddTags={vi.fn()}
          onExportMarkdown={vi.fn()}
          onDeleteSelected={vi.fn()}
          onClearSelection={vi.fn()}
          onExitMultiSelect={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(markup).toContain("2 selected");
    expect(markup).toContain("Delete 2 notes?");
    expect(markup).toContain("Confirm Delete");
    expect(markup).toContain("Export Markdown");
  });
});
