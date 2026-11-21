import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";
import type { RelatedNoteSuggestion } from "../features/notes/types";
import { i18n } from "../locales";
import { RelatedNotesSection, formatRelatedScorePercent } from "./RelatedNotesSection";

const suggestions: RelatedNoteSuggestion[] = [
  {
    id: "rel-1",
    title: "编译器后端优化",
    category: "技术",
    tags: ["rust", "compiler"],
    score: 0.842,
    matchedTerms: ["rust", "寄存器分配"],
    alreadyLinked: false,
  },
  {
    id: "rel-2",
    title: "词法分析笔记",
    category: "",
    tags: ["compiler"],
    score: 0.41,
    matchedTerms: ["compiler"],
    alreadyLinked: true,
  },
];

describe("RelatedNotesSection", () => {
  test("formats relevance score percentages safely", () => {
    expect(formatRelatedScorePercent(0)).toBe(0);
    expect(formatRelatedScorePercent(-0.2)).toBe(0);
    expect(formatRelatedScorePercent(0.002)).toBe(1);
    expect(formatRelatedScorePercent(0.842)).toBe(84);
    expect(formatRelatedScorePercent(1.5)).toBe(100);
  });

  test("renders related notes with score, matched terms, and unlinked insert button", () => {
    const markup = renderToStaticMarkup(
      <RelatedNotesSection
        noteId="active-1"
        onOpenNote={vi.fn()}
        onInsertLink={vi.fn()}
        initialSuggestions={suggestions}
      />,
    );

    expect(markup).toContain("相关笔记");
    expect(markup).toContain("编译器后端优化");
    expect(markup).toContain("技术");
    expect(markup).toContain("相关度 84%");
    expect(markup).toContain("rust");
    expect(markup).toContain("寄存器分配");
    expect(markup).toContain("插入链接");
    expect(markup).toContain("词法分析笔记");
    expect(markup).toContain("已关联");
  });

  test("renders localized empty and populated states across en-US and zh-HK", async () => {
    const enInstance = i18n.cloneInstance({ lng: "en-US" });
    await enInstance.changeLanguage("en-US");
    const enMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={enInstance}>
        <RelatedNotesSection
          noteId="active-1"
          onOpenNote={vi.fn()}
          onInsertLink={vi.fn()}
          initialSuggestions={suggestions}
        />
      </I18nextProvider>,
    );
    expect(enMarkup).toContain("Related Notes");
    expect(enMarkup).toContain("84% match");
    expect(enMarkup).toContain("Insert Link");
    expect(enMarkup).toContain("Linked");

    const hkInstance = i18n.cloneInstance({ lng: "zh-HK" });
    await hkInstance.changeLanguage("zh-HK");
    const hkEmptyMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={hkInstance}>
        <RelatedNotesSection noteId="active-1" onOpenNote={vi.fn()} initialSuggestions={[]} />
      </I18nextProvider>,
    );
    expect(hkEmptyMarkup).toContain("相關筆記");
    expect(hkEmptyMarkup).toContain("暫無高相關度的本地筆記");
  });
});
