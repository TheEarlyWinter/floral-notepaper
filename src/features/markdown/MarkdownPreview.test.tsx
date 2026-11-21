import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { MarkdownPreview, toggleTaskCheckboxAtOffset } from "./MarkdownPreview";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

describe("MarkdownPreview", () => {
  test("marks rendered Markdown content as selectable", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="# 花笺\n\n正文" />);

    expect(markup).toContain("markdown-selectable");
    expect(markup).toContain("<h1");
    expect(markup).toContain("花笺");
    expect(markup).toContain("正文");
  });

  test("uses rehype-slug IDs that match the outline generator for punctuation", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="# 标题 & 测试" />);

    expect(markup).toContain('id="标题--测试"');
  });

  test("keeps code block controls outside the horizontally scrollable pre", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview content={"```text\nvery long code line\n```"} />,
    );

    const preCloseIndex = markup.indexOf("</pre>");
    const buttonIndex = markup.indexOf("<button");

    expect(markup).toContain("markdown-code-block");
    expect(markup).toContain("markdown-code-scroll");
    expect(preCloseIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeGreaterThan(preCloseIndex);
  });

  test("renders a relative external Markdown image through the approved asset base", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview
        content="![流程图](./assets/flow.png)"
        externalImageBaseDir="C:/Users/Alice/Documents/project"
        externalFilePath="C:/Users/Alice/Documents/project/readme.md"
      />,
    );

    expect(markup).toContain("正在加载本地图片");
  });

  test("removes raw HTML styles and executable attributes", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview
        renderHtml
        content={
          '<p style="position:fixed;inset:0">untrusted</p><img src="x" onerror="alert(1)"><script>alert(1)</script>'
        }
      />,
    );

    expect(markup).toContain("untrusted");
    expect(markup).not.toContain("position:fixed");
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("<script");
  });

  test("renders a placeholder instead of loading a remote image", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview content="![tracking pixel](https://example.com/pixel.png)" />,
    );

    expect(markup).toContain("已阻止或无法加载图片");
    expect(markup).not.toContain("https://example.com/pixel.png");
  });

  test("enables GFM task checkboxes only when onContentChange is provided", () => {
    const markdown = "- [ ] Buy milk\n- [x] Ship release";

    const readOnlyMarkup = renderToStaticMarkup(<MarkdownPreview content={markdown} />);
    expect(readOnlyMarkup).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/);

    const interactiveMarkup = renderToStaticMarkup(
      <MarkdownPreview content={markdown} onContentChange={vi.fn()} />,
    );
    const inputs = interactiveMarkup.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).not.toContain("disabled");
    expect(inputs[0]).toContain('aria-label="Buy milk"');
    expect(inputs[0]).toContain('data-task-offset="3"');
    expect(inputs[1]).not.toContain("disabled");
    expect(inputs[1]).toContain('checked=""');
    expect(inputs[1]).toContain('aria-label="Ship release"');
    expect(inputs[1]).toContain('data-task-offset="18"');
  });

  test("keeps raw HTML inputs disabled and sanitized even with renderHtml and onContentChange", () => {
    const markdown = [
      '- [ ] Real task <input type="checkbox" data-task-offset="0">',
      '<li class="task-list-item"><input type="checkbox" onclick="alert(1)" data-task-offset="3"> Forged</li>',
      '<input type="text" value="pwn" onclick="alert(2)">',
    ].join("\n");

    const markup = renderToStaticMarkup(
      <MarkdownPreview content={markdown} renderHtml onContentChange={vi.fn()} />,
    );
    const inputs = markup.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(4);
    // Only the GFM task checkbox is enabled
    expect(inputs[0]).not.toContain("disabled");
    expect(inputs[0]).toContain('data-task-offset="3"');
    // All raw HTML inputs remain disabled and stripped of executable attributes
    expect(inputs[1]).toContain('disabled=""');
    expect(inputs[2]).toContain('disabled=""');
    expect(inputs[3]).toContain('disabled=""');
    expect(markup).not.toContain("onclick");
  });

  test("toggles only verified task checkbox markers at offset without altering formatting", () => {
    const markdown = "  - [ ] First\r\n  - [X] Second";

    expect(toggleTaskCheckboxAtOffset(markdown, 5, true)).toBe("  - [x] First\r\n  - [X] Second");
    expect(toggleTaskCheckboxAtOffset(markdown, 20, false)).toBe("  - [ ] First\r\n  - [ ] Second");
    expect(toggleTaskCheckboxAtOffset(markdown, 2, true)).toBeNull();
    expect(toggleTaskCheckboxAtOffset(markdown, 4, true)).toBeNull();
    expect(toggleTaskCheckboxAtOffset(markdown, 999, true)).toBeNull();
  });

  test("preserves wiki links and GFM alerts alongside interactive task lists", () => {
    const markdown = "> [!TIP]\n> Check [[note-1|Project Plan]]\n\n- [ ] Review";
    const markup = renderToStaticMarkup(
      <MarkdownPreview content={markdown} onContentChange={vi.fn()} />,
    );

    expect(markup).toContain("markdown-alert-tip");
    expect(markup).toContain("Project Plan");
    expect(markup).toContain('aria-label="Review"');
    expect(markup).not.toContain("disabled");
  });

  test("renders clickable wiki-link buttons with decoded targets in both default and HTML modes", () => {
    const markdown =
      "链接一 [[note:eb0b9183-7e7a-4f4d-b886-8c3ad156b589|Tokio 运行时深入]] 与 [[简单标题]]";

    for (const renderHtml of [false, true]) {
      const markup = renderToStaticMarkup(
        <MarkdownPreview content={markdown} renderHtml={renderHtml} onOpenWikiLink={vi.fn()} />,
      );

      expect(markup).toContain("<button");
      expect(markup).toContain('data-wiki-target="note:eb0b9183-7e7a-4f4d-b886-8c3ad156b589"');
      expect(markup).toContain('data-wiki-target="简单标题"');
      expect(markup).toContain("Tokio 运行时深入");
    }
  });

  test("keeps unsafe javascript links neutralized even when preserving wiki scheme", () => {
    for (const renderHtml of [false, true]) {
      const markup = renderToStaticMarkup(
        <MarkdownPreview content="[xss](javascript:alert(1))" renderHtml={renderHtml} />,
      );

      expect(markup).toContain("xss");
      expect(markup).not.toContain("javascript:");
    }
  });
});
