import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";
import type { NoteMetadata } from "../features/notes/types";
import { i18n } from "../locales";
import { WikiLinkAutocomplete } from "./WikiLinkAutocomplete";

const notes: NoteMetadata[] = [
  {
    id: "note-a",
    title: "项目规划",
    fileName: "note-a.md",
    category: "工作",
    createdAt: "2026-11-20T08:00:00Z",
    updatedAt: "2026-11-21T09:00:00Z",
    wordCount: 50,
    preview: "规划详情",
    tags: ["plan"],
    pinned: false,
  },
  {
    id: "note-b",
    title: "设计草图",
    fileName: "note-b.md",
    category: "灵感",
    createdAt: "2026-11-19T08:00:00Z",
    updatedAt: "2026-11-20T09:00:00Z",
    wordCount: 30,
    preview: "草图说明",
    tags: [],
    pinned: false,
  },
];

describe("WikiLinkAutocomplete", () => {
  test("renders nothing when closed or without trigger", () => {
    const markup = renderToStaticMarkup(
      <WikiLinkAutocomplete
        open={false}
        trigger={{ startOffset: 0, endOffset: 2, query: "" }}
        candidates={notes}
        activeIndex={0}
        textareaRef={{ current: null }}
        onHoverIndex={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(markup).toBe("");
  });

  test("renders candidates with active selection state and query indicator", () => {
    const markup = renderToStaticMarkup(
      <WikiLinkAutocomplete
        open={true}
        trigger={{ startOffset: 3, endOffset: 7, query: "项目" }}
        candidates={notes}
        activeIndex={1}
        textareaRef={{ current: null }}
        onHoverIndex={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain("插入笔记链接");
    expect(markup).toContain("项目规划");
    expect(markup).toContain("设计草图");
    expect(markup).toContain("工作");
    expect(markup).toContain('aria-selected="false"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Enter / Tab 插入");
  });

  test("renders localized empty state across zh-CN, zh-HK, and en-US", async () => {
    const enInstance = i18n.cloneInstance({ lng: "en-US" });
    await enInstance.changeLanguage("en-US");
    const enMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={enInstance}>
        <WikiLinkAutocomplete
          open={true}
          trigger={{ startOffset: 0, endOffset: 5, query: "zzz" }}
          candidates={[]}
          activeIndex={0}
          textareaRef={{ current: null }}
          onHoverIndex={vi.fn()}
          onSelect={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(enMarkup).toContain("Link Note");
    expect(enMarkup).toContain("No matching notes");
    expect(enMarkup).toContain("Esc Close");

    const hkInstance = i18n.cloneInstance({ lng: "zh-HK" });
    await hkInstance.changeLanguage("zh-HK");
    const hkMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={hkInstance}>
        <WikiLinkAutocomplete
          open={true}
          trigger={{ startOffset: 0, endOffset: 5, query: "zzz" }}
          candidates={[]}
          activeIndex={0}
          textareaRef={{ current: null }}
          onHoverIndex={vi.fn()}
          onSelect={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(hkMarkup).toContain("插入筆記連結");
    expect(hkMarkup).toContain("沒有符合的筆記");
    expect(hkMarkup).toContain("Esc 關閉");
  });
});
